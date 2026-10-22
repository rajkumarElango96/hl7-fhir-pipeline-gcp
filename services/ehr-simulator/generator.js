// Synthetic "legacy EHR" feed: HL7 v2.5 ADT messages for fake Indian patients.
// Each patient produces admit (A01) -> update (A08) -> discharge (A03).
// Malformed messages break one mandatory rule, so the validator should reject them.
import { fakerEN_IN as faker } from '@faker-js/faker';
import { escape, hl7Timestamp } from '@pipeline/hl7';

// HL7 v2.5 message structure per trigger (MSH-9.3). The legacy EHR owns its own copy on purpose:
// it is an independent system, not part of the pipeline.
const TRIGGER_STRUCTURE = { A01: 'ADT_A01', A08: 'ADT_A01', A03: 'ADT_A03' };

// Each synthetic hospital and the nearby cities its patients come from.
// City, state and PIN prefix are consistent; the last three PIN digits are random.
const HOSPITALS = {
  'AIIMS-SYN': [
    ['New Delhi', 'Delhi', '110'], ['Gurugram', 'Haryana', '122'],
    ['Noida', 'Uttar Pradesh', '201'], ['Faridabad', 'Haryana', '121'],
  ],
  'APOLLO-SYN': [
    ['Chennai', 'Tamil Nadu', '600'], ['Vellore', 'Tamil Nadu', '632'],
    ['Coimbatore', 'Tamil Nadu', '641'], ['Madurai', 'Tamil Nadu', '625'],
  ],
  'MANIPAL-SYN': [
    ['Bengaluru', 'Karnataka', '560'], ['Mysuru', 'Karnataka', '570'],
    ['Mangaluru', 'Karnataka', '575'], ['Belagavi', 'Karnataka', '590'],
  ],
};

// Patient class (PV1-2) and a typical length of stay in hours.
const CLASSES = [
  { code: 'I', weight: 5, wards: ['GEN', 'ICU', 'CARD', 'ORTHO'], stay: [24, 96] }, // inpatient
  { code: 'O', weight: 3, wards: ['OPD'], stay: [1, 3] },                          // outpatient
  { code: 'E', weight: 2, wards: ['ER'], stay: [2, 8] },                           // emergency
];

const phone = () => `+91${faker.string.numeric({ length: 10, allowLeadingZeros: false })}`;

function makePatient() {
  const sex = faker.helpers.arrayElement(['M', 'F']);
  const facility = faker.helpers.objectKey(HOSPITALS);
  const [city, state, pinPrefix] = faker.helpers.arrayElement(HOSPITALS[facility]);
  const cls = faker.helpers.weightedArrayElement(CLASSES.map((c) => ({ weight: c.weight, value: c })));
  return {
    mrn: `MRN${faker.string.numeric(6)}`,
    abha: faker.helpers.replaceSymbols('##-####-####-####'),
    family: faker.person.lastName(),
    given: faker.person.firstName(sex === 'M' ? 'male' : 'female'),
    dob: hl7Timestamp(faker.date.birthdate({ min: 1, max: 90, mode: 'age' })).slice(0, 8),
    sex,
    street: faker.location.streetAddress(),
    city,
    state,
    zip: pinPrefix + faker.string.numeric(3),
    phone: phone(),
    facility,
    visit: `V${faker.string.numeric(7)}`,
    patientClass: cls.code,
    ward: faker.helpers.arrayElement(cls.wards),
    stayHours: faker.number.int({ min: cls.stay[0], max: cls.stay[1] }),
    room: `R${faker.string.numeric(2)}`,
    bed: `B${faker.number.int({ min: 1, max: 4 })}`,
    doctor: { id: `D${faker.string.numeric(4)}`, family: faker.person.lastName(), given: faker.person.firstName() },
  };
}

let seq = 0;
export function buildAdt(p, trigger, { admit, discharge, sentAt = new Date(), omitPv1 = false }) {
  const e = (v) => escape(v ?? '');
  const controlId = `SIM${String(Date.now()).slice(-8)}${String(seq++).padStart(4, '0')}`;
  const now = hl7Timestamp(sentAt);
  const structure = TRIGGER_STRUCTURE[trigger] ?? 'ADT_A01';
  const pv1 = new Array(46).fill('');
  pv1[0] = 'PV1'; pv1[1] = '1'; pv1[2] = p.patientClass ?? 'I';
  pv1[3] = `${p.ward}^${p.room}^${p.bed}`;
  pv1[7] = `${p.doctor.id}^${e(p.doctor.family)}^${e(p.doctor.given)}`;
  pv1[19] = p.visit;
  pv1[44] = admit;
  pv1[45] = discharge ?? '';
  const mrnType = p.mrnType ?? 'MR';
  return [
    `MSH|^~\\&|SYN-HIS|${p.facility}|PIPELINE|PIPELINE|${now}||ADT^${trigger}^${structure}|${controlId}|P|2.5`,
    `EVN|${trigger}|${now}`,
    `PID|1||${p.mrn}^^^${p.facility}^${mrnType}~${p.abha}^^^ABDM^ABHA||${e(p.family)}^${e(p.given)}||${p.dob}|${p.sex}|||${e(p.street)}^^${e(p.city)}^${e(p.state)}^${p.zip}^IN||${p.phone}`,
    // Every ADT structure used here requires PV1, including A08 (ADT_A01).
    omitPv1 ? null : pv1.join('|').replace(/\|+$/, ''),
  ].filter(Boolean).join('\r');
}

// Each defect breaks exactly one validation rule.
export const DEFECTS = [
  { name: 'missing visit number (PV1-19)', patient: (p) => ({ ...p, visit: '' }) },
  { name: 'no MR identifier in PID-3', patient: (p) => ({ ...p, mrnType: 'XX' }) },
  { name: 'missing family name (PID-5.1)', patient: (p) => ({ ...p, family: '' }) },
  { name: 'A08 without PV1 segment', trigger: 'A08', omitPv1: true },
];

// Admits 2-6 days ago, so every stay has ended by the time the batch is written.
const pastAdmit = () => faker.date.between({ from: Date.now() - 6 * 86400_000, to: Date.now() - 2 * 86400_000 });
const hours = (date, h) => new Date(date.getTime() + h * 3600_000);
const ts12 = (date) => hl7Timestamp(date).slice(0, 12);

// Returns an array of HL7 message strings (segments separated by \r).
export function generateMessages({ patients = 2, malformed = 1, seed } = {}) {
  if (seed !== undefined) faker.seed(Number(seed));
  const messages = [];

  for (let i = 0; i < patients; i++) {
    const p = makePatient();
    const admitAt = pastAdmit();
    const dischargeAt = hours(admitAt, p.stayHours);
    const updateAt = hours(admitAt, p.stayHours / 2);
    const admit = ts12(admitAt);
    // A08 changes the phone number; the later A03 carries the updated record, like a real EHR would.
    const updated = { ...p, phone: phone() };
    messages.push(buildAdt(p, 'A01', { admit, sentAt: admitAt }));
    messages.push(buildAdt(updated, 'A08', { admit, sentAt: updateAt }));
    messages.push(buildAdt(updated, 'A03', { admit, discharge: ts12(dischargeAt), sentAt: dischargeAt }));
  }
  for (let i = 0; i < malformed; i++) {
    const defect = DEFECTS[i % DEFECTS.length];
    const admitAt = pastAdmit();
    const p = defect.patient ? defect.patient(makePatient()) : makePatient();
    messages.push(buildAdt(p, defect.trigger ?? 'A01', { admit: ts12(admitAt), sentAt: admitAt, omitPv1: defect.omitPv1 }));
  }
  return messages;
}

// One file = one batch. Messages are separated by a blank line and segments by newlines,
// so the file is readable; the loader splits on MSH, so line endings do not matter.
export function toBatchFile(messages) {
  return messages.map((m) => m.replace(/\r/g, '\n')).join('\n\n') + '\n';
}
