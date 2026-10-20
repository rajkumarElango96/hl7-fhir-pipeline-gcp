import KafkaPkg from '@confluentinc/kafka-javascript';
import pino from 'pino';

const { Kafka } = KafkaPkg.KafkaJS;

export const config = {
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
  fhirBaseUrl: process.env.FHIR_BASE_URL ?? 'http://localhost:8080/fhir',
  mllpHost: process.env.MLLP_HOST ?? 'localhost',
  mllpPort: Number(process.env.MLLP_PORT ?? 2575),
};

export const TOPICS = {
  raw: 'hl7.raw',
  parsed: 'hl7.parsed',
  dlq: 'hl7.dlq',
  bundles: 'fhir.bundles',
  events: 'fhir.events',
};

export function createLogger(service) {
  return pino({
    name: service,
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.LOG_JSON ? undefined : { target: 'pino-pretty', options: { ignore: 'pid,hostname', translateTime: 'HH:MM:ss.l' } },
  });
}

export function createKafka(clientId) {
  return new Kafka({ kafkaJS: { clientId, brokers: config.kafkaBrokers, logLevel: KafkaPkg.KafkaJS.logLevel.ERROR } });
}

// Idempotent producer: the broker de-duplicates retried sends, and acks=all means
// a send only resolves once the write is durable.
export async function createProducer(kafka) {
  const producer = kafka.producer({ kafkaJS: { idempotent: true, acks: -1 } });
  await producer.connect();
  return producer;
}

export async function createConsumer(kafka, groupId, topics) {
  const consumer = kafka.consumer({ kafkaJS: { groupId, fromBeginning: true } });
  await consumer.connect();
  await consumer.subscribe({ topics });
  return consumer;
}

// Kafka headers arrive as Buffers; turn them into a plain string map.
export function readHeaders(message) {
  const out = {};
  for (const [k, v] of Object.entries(message.headers ?? {})) out[k] = v?.toString();
  return out;
}

export function onShutdown(log, ...closers) {
  const stop = async (signal) => {
    log.info({ signal }, 'shutting down');
    for (const close of closers) await close().catch((err) => log.error({ err }, 'error during shutdown'));
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
