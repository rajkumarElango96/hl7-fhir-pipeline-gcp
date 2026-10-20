// Synthetic hospital system: sends ADT A01 -> A08 -> A03 flows for fake Indian patients over MLLP.
// Used by the CLI (index.js) and by ops-api (the dashboard's "Send patients" button).
import net from 'node:net';
import { fakerEN_IN as faker } from '@faker-js/faker';
import { frame, createDecoder, parseMessage, get, escape, hl7Timestamp } from '@pipeline/hl7';
import { config } from '@pipeline/common';

const FACILITIES = ['APOLLO-SYN', 'MANIPAL-SYN', 'AIIMS-SYN'];
const WARDS = ['GEN', 'ICU', 'CARD', 'ORTHO'];

const phone = () => `+91${faker.string.numeric({ length: 10, allowLeadingZeros: false })}`;

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
    phone: phone(),
    facility: faker.helpers.arrayElement(FACILITIES),
    visit: `V${faker.string.numeric(7)}`,
    ward: faker.helpers.arrayElement(WARDS),
    room: `R${faker.string.numeric(2)}`,
    bed: `B${faker.number.int({ min: 1, max: 4 })}`,
    doctor: { id: `D${faker.string.numeric(4)}`, family: faker.person.lastName(), given: faker.person.firstName() },
  };
}

let seq = 0;
export function buildAdt(p, trigger, { admit, discharge }) {
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

// Defects the gateway accepts (the message parses) but the validator rejects -> hl7.dlq.
const DEFECTS = [
  { name: 'missing visit number (PV1-19)', apply: (p) => ({ ...p, visit: '' }) },
  { name: 'no MR identifier in PID-3', apply: (p) => ({ ...p, mrn: p.mrn, mrnType: 'XX' }) },
  { name: 'unsupported trigger A99', trigger: 'A99' },
];

function buildMalformed(p, admit, i) {
  const defect = DEFECTS[i % DEFECTS.length];
  const data = defect.apply ? defect.apply(p) : p;
  let msg = buildAdt(data, defect.trigger ?? 'A01', { admit });
  if (data.mrnType) msg = msg.replace(`${p.mrn}^^^${p.facility}^MR`, `${p.mrn}^^^${p.facility}^XX`);
  return { msg, defect: defect.name };
}

export function connect({ host = config.mllpHost, port = config.mllpPort } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => resolve(client));
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

// Send `patients` full flows plus `malformed` broken messages. Returns a summary.
export async function simulate({ patients = 3, malformed = 0, seed, onSent = () => {} } = {}) {
  if (seed !== undefined) faker.seed(Number(seed));
  const client = await connect();
  let accepted = 0;
  let sent = 0;

  const send = async (msg, info) => {
    const ack = parseMessage(await client.send(msg));
    const code = get(ack, 'MSA-1');
    sent++;
    if (code === 'AA') accepted++;
    onSent({ ...info, controlId: get(ack, 'MSA-2'), ack: code });
  };

  try {
    for (let i = 0; i < patients; i++) {
      const p = makePatient();
      const admitAt = faker.date.recent({ days: 3 });
      const admit = hl7Timestamp(admitAt).slice(0, 12);
      const discharge = hl7Timestamp(new Date(admitAt.getTime() + 36 * 3600_000)).slice(0, 12);

      // A08 changes the phone number; the later A03 carries the updated record, like a real HIS would.
      const updated = { ...p, phone: phone() };
      const flow = [['A01', p], ['A08', updated], ['A03', updated]];
      for (const [trigger, data] of flow) {
        const msg = buildAdt(data, trigger, { admit, discharge: trigger === 'A03' ? discharge : undefined });
        await send(msg, { mrn: p.mrn, patient: `${p.given} ${p.family}`, trigger });
      }
    }
    for (let i = 0; i < malformed; i++) {
      const p = makePatient();
      const { msg, defect } = buildMalformed(p, hl7Timestamp().slice(0, 12), i);
      await send(msg, { mrn: p.mrn, patient: `${p.given} ${p.family}`, trigger: 'malformed', defect });
    }
  } finally {
    client.close();
  }
  return { sent, accepted };
}
