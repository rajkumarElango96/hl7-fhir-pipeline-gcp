// Synthetic hospital system: sends ADT A01 -> A08 -> A03 flows for fake Indian patients over MLLP.
// Usage: node services/hl7-simulator/index.js [--patients 5]
import net from 'node:net';
import { parseArgs } from 'node:util';
import { fakerEN_IN as faker } from '@faker-js/faker';
import { frame, createDecoder, parseMessage, get, escape, hl7Timestamp } from '@pipeline/hl7';
import { config, createLogger } from '@pipeline/common';

const log = createLogger('hl7-simulator');
const { values } = parseArgs({ options: { patients: { type: 'string', default: '3' }, seed: { type: 'string' } } });
if (values.seed) faker.seed(Number(values.seed));

const FACILITIES = ['APOLLO-SYN', 'MANIPAL-SYN', 'AIIMS-SYN'];
const WARDS = ['GEN', 'ICU', 'CARD', 'ORTHO'];

function makePatient() {
  const sex = faker.helpers.arrayElement(['M', 'F']);
  return {
    mrn: `MRN${faker.string.numeric(6)}`,
    abha: faker.helpers.replaceSymbols('##-####-####-####'),
    family: faker.person.lastName(),
    given: faker.person.firstName(sex === 'M' ? 'male' : 'female'),
    dob: hl7Timestamp(faker.date.birthdate({ min: 1, max: 90, mode: 'age' })).slice(0, 8),
    sex,
    street: faker.location.streetAddress(),
    city: faker.location.city(),
    state: faker.location.state(),
    zip: faker.location.zipCode('######'),
    phone: `+91${faker.string.numeric({ length: 10, allowLeadingZeros: false })}`,
    facility: faker.helpers.arrayElement(FACILITIES),
    visit: `V${faker.string.numeric(7)}`,
    ward: faker.helpers.arrayElement(WARDS),
    room: `R${faker.string.numeric(2)}`,
    bed: `B${faker.number.int({ min: 1, max: 4 })}`,
    doctor: { id: `D${faker.string.numeric(4)}`, family: faker.person.lastName(), given: faker.person.firstName() },
  };
}

let seq = 0;
function buildAdt(p, trigger, { admit, discharge }) {
  const e = (v) => escape(v ?? '');
  const controlId = `SIM${Date.now()}${String(seq++).padStart(4, '0')}`;
  const now = hl7Timestamp();
  const pv1 = new Array(46).fill('');
  pv1[0] = 'PV1'; pv1[1] = '1'; pv1[2] = 'I';
  pv1[3] = `${p.ward}^${p.room}^${p.bed}`;
  pv1[7] = `${p.doctor.id}^${e(p.doctor.family)}^${e(p.doctor.given)}`;
  pv1[19] = p.visit;
  pv1[44] = admit;
  pv1[45] = discharge ?? '';
  const segments = [
    `MSH|^~\\&|SYN-HIS|${p.facility}|PIPELINE|PIPELINE|${now}||ADT^${trigger}^ADT_A01|${controlId}|P|2.5`,
    `EVN|${trigger}|${now}`,
    `PID|1||${p.mrn}^^^${p.facility}^MR~${p.abha}^^^ABDM^ABHA||${e(p.family)}^${e(p.given)}||${p.dob}|${p.sex}|||${e(p.street)}^^${e(p.city)}^${e(p.state)}^${p.zip}^IN||${p.phone}`,
    trigger === 'A08' ? null : pv1.join('|').replace(/\|+$/, ''),
  ].filter(Boolean);
  return segments.join('\r');
}

// Send one message and wait for its ACK.
function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(config.mllpPort, config.mllpHost, () => resolve(client));
    socket.on('error', reject);
    const waiting = [];
    const decoder = createDecoder((ack) => waiting.shift()?.(ack));
    socket.on('data', (c) => decoder.push(c));
    const client = {
      send: (msg) => new Promise((res) => { waiting.push(res); socket.write(frame(msg)); }),
      close: () => socket.end(),
    };
  });
}

const client = await connect();
const count = Number(values.patients);
let accepted = 0;

for (let i = 0; i < count; i++) {
  const p = makePatient();
  const admitAt = faker.date.recent({ days: 3 });
  const admit = hl7Timestamp(admitAt).slice(0, 12);
  const discharge = hl7Timestamp(new Date(admitAt.getTime() + 36 * 3600_000)).slice(0, 12);

  // A08 changes the phone number; the later A03 carries the updated record, like a real HIS would.
  const updated = { ...p, phone: `+91${faker.string.numeric({ length: 10, allowLeadingZeros: false })}` };
  const flow = [
    ['A01', p],
    ['A08', updated],
    ['A03', updated],
  ];
  for (const [trigger, data] of flow) {
    const msg = buildAdt(data, trigger, { admit, discharge: trigger === 'A03' ? discharge : undefined });
    const ack = parseMessage(await client.send(msg));
    const code = get(ack, 'MSA-1');
    if (code === 'AA') accepted++;
    log.info({ mrn: p.mrn, patient: `${p.given} ${p.family}`, phone: data.phone, trigger, controlId: get(ack, 'MSA-2'), ack: code }, 'sent');
  }
}

client.close();
log.info({ patients: count, messages: count * 3, accepted }, 'done');
