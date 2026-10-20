// FHIR writer: posts transaction Bundles to HAPI and announces domain events on fhir.events.
// If HAPI fails, it retries the same message with growing delays and does not move on,
// so per-patient order is kept and lag builds up until HAPI recovers.
// (Retry topics and a DLQ for writes come in milestone M3.)
//
// A small control port lets the ops dashboard inject faults:
//   GET  /status                 -> state, counters, last error
//   POST /chaos { paused?, fhirOutage? }
import http from 'node:http';
import { domainEventName } from '@pipeline/fhir-mapping';
import { config, TOPICS, createKafka, createProducer, createConsumer, createLogger, readHeaders, onShutdown } from '@pipeline/common';

const log = createLogger('fhir-writer');
const kafka = createKafka('fhir-writer');
const producer = await createProducer(kafka);
const consumer = await createConsumer(kafka, 'fhir-writer', [TOPICS.bundles]);

const state = {
  paused: false,
  fhirOutage: false, // chaos: make every HAPI call fail
  written: 0,
  failedAttempts: 0,
  retrying: null, // { controlId, attempt, error } while stuck on a message
  lastError: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postBundle(bundle) {
  if (state.fhirOutage) throw new Error('Simulated HAPI outage (chaos toggle)');
  const res = await fetch(config.fhirBaseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' },
    body: JSON.stringify(bundle),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issue = body.issue?.map((i) => i.diagnostics).join('; ');
    throw new Error(`HAPI ${res.status}: ${issue || res.statusText}`);
  }
  return body;
}

// Keep trying until HAPI accepts the bundle. Backoff: 0.5s, 1s, 2s, 4s, then 5s.
async function postWithRetry(bundle, controlId) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await postBundle(bundle);
      if (state.retrying) log.info({ controlId, attempts: attempt }, 'HAPI recovered');
      state.retrying = null;
      return res;
    } catch (err) {
      state.failedAttempts++;
      state.lastError = { controlId, message: err.message, at: new Date().toISOString() };
      state.retrying = { controlId, attempt, error: err.message };
      const wait = Math.min(500 * 2 ** (attempt - 1), 5000);
      log.warn({ controlId, attempt, retryInMs: wait, err: err.message }, 'HAPI write failed, retrying');
      await sleep(wait);
    }
  }
}

await consumer.run({
  eachMessage: async ({ message }) => {
    const headers = readHeaders(message);
    const { event, bundle } = JSON.parse(message.value.toString());

    const response = await postWithRetry(bundle, event.controlId);
    const resources = response.entry.map((e) => ({ location: e.response.location, status: e.response.status }));

    await producer.send({
      topic: TOPICS.events,
      messages: [{
        key: message.key,
        value: JSON.stringify({
          type: domainEventName(event.eventType),
          mrn: event.patient.mrn,
          visitNumber: event.visit?.visitNumber,
          controlId: event.controlId,
          occurredAt: event.messageTime,
          resources,
        }),
        headers: { ...headers, 'source-stage': 'fhir-writer' },
      }],
    });
    state.written++;
    log.info({ controlId: event.controlId, resources: resources.map((r) => `${r.status} ${r.location}`) }, 'written to HAPI -> fhir.events');
  },
});

// ---- control port -------------------------------------------------------
function setPaused(paused) {
  if (paused === state.paused) return;
  if (paused) consumer.pause([{ topic: TOPICS.bundles }]);
  else consumer.resume([{ topic: TOPICS.bundles }]);
  state.paused = paused;
  log.warn({ paused }, paused ? 'consumer paused' : 'consumer resumed');
}

const control = http.createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === 'GET' && req.url === '/status') return send(200, state);
    if (req.method === 'POST' && req.url === '/chaos') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { paused, fhirOutage } = JSON.parse(body || '{}');
      if (typeof paused === 'boolean') setPaused(paused);
      if (typeof fhirOutage === 'boolean' && fhirOutage !== state.fhirOutage) {
        state.fhirOutage = fhirOutage;
        log.warn({ fhirOutage }, fhirOutage ? 'chaos: simulating HAPI outage' : 'chaos: HAPI outage cleared');
      }
      return send(200, state);
    }
    send(404, { error: 'not found' });
  } catch (err) {
    send(400, { error: err.message });
  }
});
control.listen(config.writerControlPort, () => log.info({ port: config.writerControlPort }, 'control port listening'));

log.info({ fhir: config.fhirBaseUrl }, 'consuming fhir.bundles');
onShutdown(log, () => new Promise((r) => control.close(r)), () => consumer.disconnect(), () => producer.disconnect());
