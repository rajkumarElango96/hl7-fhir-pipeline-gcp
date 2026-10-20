// MLLP gateway: accepts HL7v2 over TCP and publishes the raw message to Kafka.
// It replies ACK AA only after Kafka confirms the write, so an ACK means "durably stored".
import net from 'node:net';
import { parseMessage, get, buildAck, frame, createDecoder, findMrn } from '@pipeline/hl7';
import { config, TOPICS, createKafka, createProducer, createLogger, onShutdown } from '@pipeline/common';

const log = createLogger('mllp-gateway');
const producer = await createProducer(createKafka('mllp-gateway'));

const server = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  log.info({ peer }, 'connection opened');

  // Handle messages one at a time per connection so ACKs come back in order.
  let queue = Promise.resolve();
  const decoder = createDecoder((raw) => {
    queue = queue.then(() => handle(raw, socket));
  });

  socket.on('data', (chunk) => decoder.push(chunk));
  socket.on('close', () => log.info({ peer }, 'connection closed'));
  socket.on('error', (err) => log.warn({ peer, err: err.message }, 'socket error'));
});

async function handle(raw, socket) {
  let msg;
  try {
    msg = parseMessage(raw);
  } catch (err) {
    log.warn({ err: err.message }, 'rejected unparseable message');
    socket.write(frame(buildAck(null, 'AR', err.message)));
    return;
  }

  const controlId = get(msg, 'MSH-10');
  const mrn = findMrn(msg);
  try {
    await producer.send({
      topic: TOPICS.raw,
      // Partition key = MRN, so all messages for one patient stay in order.
      messages: [{
        key: mrn || controlId,
        value: raw,
        headers: { 'correlation-id': controlId, 'received-at': new Date().toISOString(), 'source-stage': 'mllp-gateway' },
      }],
    });
    socket.write(frame(buildAck(msg, 'AA')));
    log.info({ controlId, mrn, trigger: get(msg, 'MSH-9.2') }, 'accepted -> hl7.raw');
  } catch (err) {
    // Not stored, so tell the sender to retry.
    log.error({ controlId, err: err.message }, 'kafka write failed');
    socket.write(frame(buildAck(msg, 'AE', 'Temporary failure, please resend')));
  }
}

server.listen(config.mllpPort, () => log.info({ port: config.mllpPort }, 'MLLP listening'));

onShutdown(log, () => new Promise((r) => server.close(r)), () => producer.disconnect());
