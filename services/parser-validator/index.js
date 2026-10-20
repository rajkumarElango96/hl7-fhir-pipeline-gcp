// Parser/validator: hl7.raw -> canonical ADT event on hl7.parsed (or hl7.dlq with a reason).
import { parseMessage, toAdtEvent } from '@pipeline/hl7';
import { TOPICS, createKafka, createProducer, createConsumer, createLogger, readHeaders, onShutdown } from '@pipeline/common';

const log = createLogger('parser-validator');
const kafka = createKafka('parser-validator');
const producer = await createProducer(kafka);
const consumer = await createConsumer(kafka, 'parser-validator', [TOPICS.raw]);

await consumer.run({
  eachMessage: async ({ message }) => {
    const headers = readHeaders(message);
    const raw = message.value.toString();
    const out = { ...headers, 'source-stage': 'parser-validator' };

    let event;
    try {
      event = toAdtEvent(parseMessage(raw));
    } catch (err) {
      await producer.send({
        topic: TOPICS.dlq,
        messages: [{ key: message.key, value: JSON.stringify({ reason: err.message, stage: 'parser-validator', raw }), headers: out }],
      });
      log.warn({ controlId: headers['correlation-id'], reason: err.message }, 'invalid -> hl7.dlq');
      return;
    }

    await producer.send({
      topic: TOPICS.parsed,
      messages: [{ key: message.key, value: JSON.stringify(event), headers: out }],
    });
    log.info({ controlId: event.controlId, mrn: event.patient.mrn, trigger: event.eventType }, 'parsed -> hl7.parsed');
  },
});

log.info('consuming hl7.raw');
onShutdown(log, () => consumer.disconnect(), () => producer.disconnect());
