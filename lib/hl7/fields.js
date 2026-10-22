// Readers for the HL7 fields more than one service needs.
import { getSegment, repetitions } from './parse.js';

// PID-3 holds several identifiers (repetitions); pick the one with the given type code (CX.5).
export function findIdentifier(msg, typeCode) {
  const ids = repetitions(msg, getSegment(msg, 'PID'), 3);
  const hit = ids.find((c) => c[4] === typeCode);
  return hit ? hit[0] : '';
}

export const findMrn = (msg) => findIdentifier(msg, 'MR');

// HL7 TS (YYYYMMDD[HHMM[SS]]) -> ISO 8601. Dates stay dates; times are treated as IST (+05:30).
export function hl7ToIso(ts) {
  if (!ts) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?/.exec(ts);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  if (!h) return `${y}-${mo}-${d}`;
  return `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}+05:30`;
}
