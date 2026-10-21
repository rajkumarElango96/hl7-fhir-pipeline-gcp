// Turn a parsed ADT message into a canonical, HL7-free event object.
// Downstream services only see this shape, so they never deal with pipes and carets.
import { get, getSegment, repetitions } from './parse.js';

export const SUPPORTED_TRIGGERS = ['A01', 'A03', 'A08'];

export class AdtValidationError extends Error {}

export function validateAdt(msg) {
  const errors = [];
  const type = get(msg, 'MSH-9.1');
  const trigger = get(msg, 'MSH-9.2');
  if (type !== 'ADT') errors.push(`Unsupported message type "${type}"`);
  if (!SUPPORTED_TRIGGERS.includes(trigger)) errors.push(`Unsupported trigger "${trigger}"`);
  if (!get(msg, 'MSH-10')) errors.push('MSH-10 (message control ID) is required');
  if (!get(msg, 'MSH-7')) errors.push('MSH-7 (message timestamp) is required');
  if (!getSegment(msg, 'PID')) errors.push('PID segment is required');
  else {
    if (!findMrn(msg)) errors.push('PID-3 must contain an MR identifier');
    if (!get(msg, 'PID-5.1')) errors.push('PID-5.1 (family name) is required');
    if (!/^\d{8}/.test(get(msg, 'PID-7'))) errors.push('PID-7 (date of birth) is required as YYYYMMDD');
    if (!['M', 'F', 'O', 'U'].includes(get(msg, 'PID-8'))) errors.push('PID-8 (sex) must be M, F, O or U');
  }
  if (['A01', 'A03'].includes(trigger)) {
    if (!getSegment(msg, 'PV1')) errors.push(`PV1 segment is required for ${trigger}`);
    else if (!get(msg, 'PV1-19')) errors.push('PV1-19 (visit number) is required');
  }
  if (trigger === 'A03' && !get(msg, 'PV1-45')) errors.push('PV1-45 (discharge time) is required for A03');
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
  if (errors.length) throw new AdtValidationError(errors.join('; '));

  const pv1 = getSegment(msg, 'PV1');
  return {
    eventType: get(msg, 'MSH-9.2'),
    controlId: get(msg, 'MSH-10'),
    messageTime: hl7ToIso(get(msg, 'MSH-7')),
    sendingApp: get(msg, 'MSH-3'),
    sendingFacility: get(msg, 'MSH-4'),
    patient: {
      mrn: findMrn(msg),
      abha: findIdentifier(msg, 'ABHA') || undefined,
      family: get(msg, 'PID-5.1'),
      given: get(msg, 'PID-5.2'),
      birthDate: hl7ToIso(get(msg, 'PID-7')),
      gender: SEX[get(msg, 'PID-8')] ?? 'unknown',
      address: {
        line: get(msg, 'PID-11.1'),
        city: get(msg, 'PID-11.3'),
        state: get(msg, 'PID-11.4'),
        postalCode: get(msg, 'PID-11.5'),
        country: get(msg, 'PID-11.6') || 'IN',
      },
      phone: get(msg, 'PID-13') || undefined,
    },
    visit: pv1
      ? {
          visitNumber: get(msg, 'PV1-19'),
          patientClass: get(msg, 'PV1-2'),
          location: [get(msg, 'PV1-3.1'), get(msg, 'PV1-3.2'), get(msg, 'PV1-3.3')].filter(Boolean).join('-'),
          attending: {
            id: get(msg, 'PV1-7.1'),
            name: [get(msg, 'PV1-7.3'), get(msg, 'PV1-7.2')].filter(Boolean).join(' '),
          },
          admitTime: hl7ToIso(get(msg, 'PV1-44')),
          dischargeTime: hl7ToIso(get(msg, 'PV1-45')),
        }
      : undefined,
  };
}
