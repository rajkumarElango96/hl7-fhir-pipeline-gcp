// ADT validation and conversion to a canonical, HL7-free event object.
// Downstream code only sees the canonical shape, so it never deals with pipes and carets.
import { get, getSegment, repetitions } from './parse.js';

export const SUPPORTED_TRIGGERS = ['A01', 'A03', 'A08'];

// HL7 v2.5: the abstract message structure each trigger uses (declared in MSH-9.3).
export const TRIGGER_STRUCTURE = { A01: 'ADT_A01', A08: 'ADT_A01', A03: 'ADT_A03' };

// Segments the structure requires. Both structures make PV1 mandatory, A08 included.
export const STRUCTURE_SEGMENTS = {
  ADT_A01: ['MSH', 'EVN', 'PID', 'PV1'],
  ADT_A03: ['MSH', 'EVN', 'PID', 'PV1'],
};

// Mandatory fields (the same list the manual BigQuery validation used).
// A field is only checked when its segment exists; a missing segment is reported once.
export const REQUIRED_FIELDS = [
  { field: 'MSH-7', label: 'message timestamp' },
  { field: 'MSH-10', label: 'message control ID' },
  { field: 'PID-3', label: 'patient MRN (identifier type MR)', read: (msg) => findMrn(msg) },
  { field: 'PID-5.1', label: 'patient family name' },
  { field: 'PV1-2', label: 'patient class' },
  { field: 'PV1-19', label: 'visit number' },
];

export class AdtValidationError extends Error {
  constructor(errors) {
    super(errors.map((e) => e.reason).join('; '));
    this.errors = errors;
  }
}

// Returns [] for a valid message, otherwise [{ rule, field, reason }].
export function validateAdt(msg) {
  const errors = [];
  const fail = (rule, field, reason) => errors.push({ rule, field, reason });

  const type = get(msg, 'MSH-9.1');
  const trigger = get(msg, 'MSH-9.2');
  if (type !== 'ADT') fail('message_type', 'MSH-9.1', `Message type must be ADT, got "${type}"`);
  if (!SUPPORTED_TRIGGERS.includes(trigger)) {
    fail('trigger', 'MSH-9.2', `Trigger must be one of ${SUPPORTED_TRIGGERS.join(', ')}, got "${trigger}"`);
    return errors; // structure rules depend on a known trigger
  }

  const structure = get(msg, 'MSH-9.3') || TRIGGER_STRUCTURE[trigger];
  const required = STRUCTURE_SEGMENTS[structure];
  if (!required) {
    fail('structure', 'MSH-9.3', `Unsupported message structure "${structure}"`);
    return errors;
  }
  const missingSegments = required.filter((name) => !getSegment(msg, name));
  for (const name of missingSegments) fail('segment', name, `${name} segment is required by ${structure}`);

  for (const rule of REQUIRED_FIELDS) {
    const segment = rule.field.slice(0, 3);
    if (missingSegments.includes(segment)) continue;
    const value = rule.read ? rule.read(msg) : get(msg, rule.field);
    if (!value) fail('required_field', rule.field, `${rule.field} (${rule.label}) is required`);
  }
  return errors;
}

function findIdentifier(msg, typeCode) {
  const ids = repetitions(msg, getSegment(msg, 'PID'), 3);
  const hit = ids.find((c) => c[4] === typeCode);
  return hit ? hit[0] : '';
}

export function findMrn(msg) {
  return findIdentifier(msg, 'MR');
}

// HL7 TS (YYYYMMDD[HHMM[SS]]) -> ISO 8601. Dates stay dates; times are treated as IST (+05:30).
export function hl7ToIso(ts) {
  if (!ts) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?/.exec(ts);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  if (!h) return `${y}-${mo}-${d}`;
  return `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}+05:30`;
}

const SEX = { M: 'male', F: 'female', O: 'other', U: 'unknown' };

export function toAdtEvent(msg) {
  const errors = validateAdt(msg);
  if (errors.length) throw new AdtValidationError(errors);

  const trigger = get(msg, 'MSH-9.2');
  const messageTime = hl7ToIso(get(msg, 'MSH-7'));
  return {
    eventType: trigger,
    controlId: get(msg, 'MSH-10'),
    messageTime,
    sendingApp: get(msg, 'MSH-3'),
    sendingFacility: get(msg, 'MSH-4'),
    patient: {
      mrn: findMrn(msg),
      abha: findIdentifier(msg, 'ABHA') || undefined,
      family: get(msg, 'PID-5.1'),
      given: get(msg, 'PID-5.2') || undefined,
      birthDate: hl7ToIso(get(msg, 'PID-7')),
      gender: SEX[get(msg, 'PID-8')],
      address: {
        line: get(msg, 'PID-11.1'),
        city: get(msg, 'PID-11.3'),
        state: get(msg, 'PID-11.4'),
        postalCode: get(msg, 'PID-11.5'),
        country: get(msg, 'PID-11.6') || 'IN',
      },
      phone: get(msg, 'PID-13') || undefined,
    },
    visit: {
      visitNumber: get(msg, 'PV1-19'),
      patientClass: get(msg, 'PV1-2'),
      location: [get(msg, 'PV1-3.1'), get(msg, 'PV1-3.2'), get(msg, 'PV1-3.3')].filter(Boolean).join('-'),
      attending: {
        id: get(msg, 'PV1-7.1'),
        name: [get(msg, 'PV1-7.3'), get(msg, 'PV1-7.2')].filter(Boolean).join(' '),
      },
      // Fall back to the message time when the sender leaves PV1-44 / PV1-45 empty.
      admitTime: hl7ToIso(get(msg, 'PV1-44')) ?? (trigger === 'A01' ? messageTime : undefined),
      dischargeTime: hl7ToIso(get(msg, 'PV1-45')) ?? (trigger === 'A03' ? messageTime : undefined),
    },
  };
}
