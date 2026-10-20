// ops-api: watches every pipeline topic, keeps a per-message timeline in SQLite,
// and serves the dashboard (REST + WebSocket). Also hosts the demo controls:
// send synthetic patients, replay DLQ messages, and chaos toggles on the writer.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { parseMessage, get, findMrn } from '@pipeline/hl7';
import { simulate } from '@pipeline/hl7-simulator';
import { config, TOPICS, createKafka, createProducer, createConsumer, createLogger, readHeaders, onShutdown } from '@pipeline/common';
import { openStore } from './store.js';

const log = createLogger('ops-api');
const store = openStore(process.env.OPS_DB ?? fileURLToPath(new URL('../../.local/ops.db', import.meta.url)));
const kafka = createKafka('ops-api');
const admin = kafka.admin();
await admin.connect();
const producer = await createProducer(kafka);

// ---- live clients ---------------------------------------------------------
const clients = new Set();
const broadcast = (msg) => {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
};

// ---- read model: consume every topic ----------------------------------------
const kafkaTime = (m) => new Date(Number(m.timestamp)).toISOString();

function rawSummary(raw) {
  try {
    const msg = parseMessage(raw);
    return {
      mrn: findMrn(msg) || null,
      trigger: get(msg, 'MSH-9.2') || null,
      facility: get(msg, 'MSH-4') || null,
      patient: [get(msg, 'PID-5.2'), get(msg, 'PID-5.1')].filter(Boolean).join(' ') || null,
    };
  } catch {
    return {};
  }
}

const handlers = {
  [TOPICS.raw]: (m, h) => {
    const raw = m.value.toString();
    return { control_id: h['correlation-id'], raw_hl7: raw, received_at: h['received-at'] ?? kafkaTime(m), ...rawSummary(raw) };
  },
  [TOPICS.parsed]: (m, h) => {
    const ev = JSON.parse(m.value.toString());
    return {
      control_id: h['correlation-id'], canonical: JSON.stringify(ev), parsed_at: kafkaTime(m),
      mrn: ev.patient.mrn, trigger: ev.eventType, patient: `${ev.patient.given} ${ev.patient.family}`.trim(),
    };
  },
  [TOPICS.bundles]: (m, h) => {
    const { bundle } = JSON.parse(m.value.toString());
    return { control_id: h['correlation-id'], bundle: JSON.stringify(bundle), mapped_at: kafkaTime(m) };
  },
  [TOPICS.events]: (m, h) => ({ control_id: h['correlation-id'], fhir_result: m.value.toString(), written_at: kafkaTime(m) }),
  [TOPICS.dlq]: (m, h) => {
    const { reason } = JSON.parse(m.value.toString());
    return { control_id: h['correlation-id'], dlq_reason: reason, dlq_at: kafkaTime(m) };
  },
};

const consumer = await createConsumer(kafka, 'ops-api', Object.values(TOPICS));
await consumer.run({
  eachMessage: async ({ topic, message }) => {
    const headers = readHeaders(message);
    if (!headers['correlation-id']) return;
    try {
      const row = store.upsert(handlers[topic](message, headers));
      broadcast({ type: 'message', row });
    } catch (err) {
      log.warn({ topic, err: err.message }, 'could not record message');
    }
  },
});

// ---- stats: per-stage counts + consumer lag -------------------------------
const STAGE_GROUPS = [
  { stage: 'parser-validator', groupId: 'parser-validator', topic: TOPICS.raw },
  { stage: 'fhir-mapper', groupId: 'fhir-mapper', topic: TOPICS.parsed },
  { stage: 'fhir-writer', groupId: 'fhir-writer', topic: TOPICS.bundles },
];

async function lagFor({ groupId, topic }) {
  const [ends, committed] = await Promise.all([
    admin.fetchTopicOffsets(topic),
    admin.fetchOffsets({ groupId, topics: [topic] }),
  ]);
  const done = new Map((committed[0]?.partitions ?? []).map((p) => [p.partition, Number(p.offset)]));
  return ends.reduce((sum, p) => {
    const high = Number(p.high ?? p.offset);
    const at = done.get(p.partition);
    return sum + Math.max(0, high - (at >= 0 ? at : Number(p.low ?? 0)));
  }, 0);
}

async function writerStatus() {
  try {
    const res = await fetch(`http://localhost:${config.writerControlPort}/status`, { signal: AbortSignal.timeout(800) });
    return { reachable: true, ...(await res.json()) };
  } catch {
    return { reachable: false };
  }
}

async function fhirUp() {
  try {
    const res = await fetch(`${config.fhirBaseUrl}/metadata?_summary=true`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

let latestStats = null;
async function collectStats() {
  const [lags, writer, fhir] = await Promise.all([
    Promise.all(STAGE_GROUPS.map((g) => lagFor(g).catch(() => null))),
    writerStatus(),
    fhirUp(),
  ]);
  latestStats = {
    at: new Date().toISOString(),
    counts: store.counts(),
    lag: Object.fromEntries(STAGE_GROUPS.map((g, i) => [g.stage, lags[i]])),
    writer,
    fhir: { up: fhir, url: config.fhirBaseUrl },
  };
  return latestStats;
}

const statsTimer = setInterval(async () => {
  try {
    broadcast({ type: 'stats', stats: await collectStats() });
  } catch (err) {
    log.warn({ err: err.message }, 'stats failed');
  }
}, 1000);

// ---- HTTP API -------------------------------------------------------------
const app = Fastify({ logger: false });
await app.register(websocket);

app.get('/ws', { websocket: true }, (socket) => {
  clients.add(socket);
  if (latestStats) socket.send(JSON.stringify({ type: 'stats', stats: latestStats }));
  socket.on('close', () => clients.delete(socket));
});

app.get('/api/stats', () => latestStats ?? collectStats());
app.get('/api/messages', (req) => store.list(req.query));
app.get('/api/messages/:id', (req, reply) => store.get(req.params.id) ?? reply.code(404).send({ error: 'not found' }));

// Re-send a message (usually from the DLQ) into the front of the pipeline.
// The body may carry a corrected HL7 message.
app.post('/api/messages/:id/replay', async (req, reply) => {
  const original = store.get(req.params.id);
  if (!original) return reply.code(404).send({ error: 'not found' });
  const raw = (req.body?.raw ?? original.raw_hl7).replace(/\r\n|\n/g, '\r');
  let msg;
  try {
    msg = parseMessage(raw);
  } catch (err) {
    return reply.code(400).send({ error: `Not valid HL7: ${err.message}` });
  }
  const controlId = get(msg, 'MSH-10');
  if (controlId === original.control_id) store.markReplayed(controlId);
  await producer.send({
    topic: TOPICS.raw,
    messages: [{
      key: findMrn(msg) || controlId,
      value: raw,
      headers: { 'correlation-id': controlId, 'received-at': new Date().toISOString(), 'source-stage': 'ops-replay', 'replay-of': original.control_id },
    }],
  });
  log.info({ controlId, from: original.control_id, edited: raw !== original.raw_hl7 }, 'replayed into hl7.raw');
  return { ok: true, controlId };
});

app.post('/api/simulate', async (req) => {
  const patients = Math.min(Number(req.body?.patients ?? 3), 200);
  const malformed = Math.min(Number(req.body?.malformed ?? 0), 50);
  const summary = await simulate({ patients, malformed });
  log.info({ patients, malformed, ...summary }, 'simulation sent');
  return summary;
});

app.post('/api/chaos', async (req, reply) => {
  try {
    const res = await fetch(`http://localhost:${config.writerControlPort}/chaos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(2000),
    });
    return await res.json();
  } catch {
    return reply.code(503).send({ error: 'fhir-writer is not reachable' });
  }
});

// Read-only pass-through so the dashboard can show resources exactly as HAPI stored them.
app.get('/api/fhir/:type/:id', async (req, reply) => {
  const { type, id } = req.params;
  if (!/^[A-Za-z]+$/.test(type) || !/^[A-Za-z0-9\-.]+$/.test(id)) return reply.code(400).send({ error: 'bad reference' });
  const res = await fetch(`${config.fhirBaseUrl}/${type}/${id}`, { headers: { Accept: 'application/fhir+json' } });
  return reply.code(res.status).send(await res.json());
});

// Serve the built dashboard when it exists (npm run build -w apps/dashboard).
const dist = fileURLToPath(new URL('../../apps/dashboard/dist', import.meta.url));
if (existsSync(dist)) await app.register(fastifyStatic, { root: dist });

await app.listen({ port: config.opsApiPort, host: '127.0.0.1' });
log.info({ port: config.opsApiPort }, 'ops-api listening');

onShutdown(log, async () => clearInterval(statsTimer), () => app.close(), () => consumer.disconnect(), () => producer.disconnect(), () => admin.disconnect());
