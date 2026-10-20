// FHIR mapper: canonical ADT event (hl7.parsed) -> FHIR transaction Bundle (fhir.bundles).
import { mapAdtToBundle } from '@pipeline/fhir-mapping';
import { TOPICS, createKafka, createProducer, createConsumer, createLogger, readHeaders, onShutdown } from '@pipeline/common';

const log = createLogger('fhir-mapper');
const kafka = createKafka('fhir-mapper');
const producer = await createProducer(kafka);
const consumer = await createConsumer(kafka, 'fhir-mapper', [TOPICS.parsed]);

await consumer.run({
  eachMessage: async ({ message }) => {
    const headers = readHeaders(message);
    const event = JSON.parse(message.value.toString());
    const bundle = mapAdtToBundle(event);

    await producer.send({
      topic: TOPICS.bundles,
      messages: [{
        key: message.key,
        value: JSON.stringify({ event, bundle }),
        headers: { ...headers, 'source-stage': 'fhir-mapper' },
      }],
    });
    log.info({ controlId: event.controlId, entries: bundle.entry.length }, 'mapped -> fhir.bundles');
  },
});

log.info('consuming hl7.parsed');
onShutdown(log, () => consumer.disconnect(), () => producer.disconnect());
