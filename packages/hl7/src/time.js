// HL7 timestamps in this project are local Indian time (IST, UTC+05:30), matching hl7ToIso in adt.js.
const IST_OFFSET_MS = 330 * 60_000;

// Date -> HL7 TS (YYYYMMDDHHMMSS) in IST.
export function hl7Timestamp(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}
