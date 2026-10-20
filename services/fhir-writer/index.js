// FHIR writer: posts transaction Bundles to HAPI and announces domain events on fhir.events.
// Happy path only: if HAPI fails, the handler throws and the consumer retries the same
// message. Retry topics, DLQ and backpressure come in milestone M3.
import { domainEventName } from '@pipeline/fhir-mapping';
import { config, TOPICS, createKafka, createProducer, createConsumer, createLogger, readHeaders, onShutdown } from '@pipeline/common';

const log = createLogger('fhir-writer');
const kafka = createKafka('fhir-writer');
const producer = await createProducer(kafka);
const consumer = await createConsumer(kafka, 'fhir-writer', [TOPICS.bundles]);

async function postBundle(bundle) {
  const res = await fetch(config.fhirBaseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' },
    body: JSON.stringify(bundle),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issue = body.issue?.map((i) => i.diagnostics).join('; ');
    throw new Error(`HAPI ${res.status}: ${issue || res.statusText}`);
  }
  return body;
}

await consumer.run({
  eachMessage: async ({ message }) => {
    const headers = readHeaders(message);
    const { event, bundle } = JSON.parse(message.value.toString());

    const response = await postBundle(bundle);
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
    log.info({ controlId: event.controlId, resources: resources.map((r) => `${r.status} ${r.location}`) }, 'written to HAPI -> fhir.events');
  },
});

log.info({ fhir: config.fhirBaseUrl }, 'consuming fhir.bundles');
onShutdown(log, () => consumer.disconnect(), () => producer.disconnect());
