// Synthetic "legacy EHR" feed: HL7v2 ADT messages for fake Indian patients.
// Each patient produces admit (A01) -> update (A08) -> discharge (A03).
// Malformed messages are missing a mandatory field, so the validator should reject them.
import { fakerEN_IN as faker } from '@faker-js/faker';
import { escape, hl7Timestamp } from '@pipeline/hl7';

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
export function buildAdt(p, trigger, { admit, discharge, sentAt = new Date() }) {
  const e = (v) => escape(v ?? '');
  const controlId = `SIM${String(Date.now()).slice(-8)}${String(seq++).padStart(4, '0')}`;
  const now = hl7Timestamp(sentAt);
  const pv1 = new Array(46).fill('');
  pv1[0] = 'PV1'; pv1[1] = '1'; pv1[2] = 'I';
  pv1[3] = `${p.ward}^${p.room}^${p.bed}`;
  pv1[7] = `${p.doctor.id}^${e(p.doctor.family)}^${e(p.doctor.given)}`;
  pv1[19] = p.visit;
  pv1[44] = admit;
  pv1[45] = discharge ?? '';
  const mrnType = p.mrnType ?? 'MR';
  return [
    `MSH|^~\\&|SYN-HIS|${p.facility}|PIPELINE|PIPELINE|${now}||ADT^${trigger}^ADT_A01|${controlId}|P|2.5`,
    `EVN|${trigger}|${now}`,
    `PID|1||${p.mrn}^^^${p.facility}^${mrnType}~${p.abha}^^^ABDM^ABHA||${e(p.family)}^${e(p.given)}||${p.dob}|${p.sex}|||${e(p.street)}^^${e(p.city)}^${e(p.state)}^${p.zip}^IN||${p.phone}`,
    trigger === 'A08' ? null : pv1.join('|').replace(/\|+$/, ''),
  ].filter(Boolean).join('\r');
}

// Each defect removes or breaks one mandatory field.
const DEFECTS = [
  { name: 'missing visit number (PV1-19)', apply: (p) => ({ ...p, visit: '' }) },
  { name: 'no MR identifier in PID-3', apply: (p) => ({ ...p, mrnType: 'XX' }) },
  { name: 'missing family name (PID-5.1)', apply: (p) => ({ ...p, family: '' }) },
];

// Returns an array of HL7 message strings (segments separated by \r).
export function generateMessages({ patients = 2, malformed = 1, seed } = {}) {
  if (seed !== undefined) faker.seed(Number(seed));
  const messages = [];

  // Admits 2-6 days ago, so a 36-hour stay always ends in the past.
  const pastAdmit = () => faker.date.between({ from: Date.now() - 6 * 86400_000, to: Date.now() - 2 * 86400_000 });

  for (let i = 0; i < patients; i++) {
    const p = makePatient();
    const admitAt = pastAdmit();
    const admit = hl7Timestamp(admitAt).slice(0, 12);
    const discharge = hl7Timestamp(new Date(admitAt.getTime() + 36 * 3600_000)).slice(0, 12);
    // A08 changes the phone number; the later A03 carries the updated record, like a real EHR would.
    const updated = { ...p, phone: phone() };
    messages.push(buildAdt(p, 'A01', { admit, sentAt: admitAt }));
    messages.push(buildAdt(updated, 'A08', { admit, sentAt: new Date(admitAt.getTime() + 6 * 3600_000) }));
    messages.push(buildAdt(updated, 'A03', { admit, discharge, sentAt: new Date(admitAt.getTime() + 36 * 3600_000) }));
  }
  for (let i = 0; i < malformed; i++) {
    const defect = DEFECTS[i % DEFECTS.length];
    const admitAt = pastAdmit();
    messages.push(buildAdt(defect.apply(makePatient()), 'A01', { admit: hl7Timestamp(admitAt).slice(0, 12), sentAt: admitAt }));
  }
  return messages;
}

// One file = one batch. Messages are separated by a blank line and segments by newlines,
// so the file is readable; loaders split on blank lines and turn newlines back into \r.
export function toBatchFile(messages) {
  return messages.map((m) => m.replace(/\r/g, '\n')).join('\n\n') + '\n';
}
