// Validator service logic: one raw row in, a validated or rejected row out.
// Validation failures are data problems: they are quarantined, never retried.
import { parseMessage, get, findMrn, hl7ToIso } from '@pipeline/hl7';
import { validateAdt } from './rules.js';

export function validateRow(raw, now = new Date()) {
  const base = { message_hash: raw.message_hash, file_name: raw.file_name, msg_no: raw.msg_no };

  let msg;
  try {
    msg = parseMessage(raw.message);
  } catch (err) {
    return { status: 'rejected', row: { ...base, control_id: null, trigger_event: null, mrn: null,
      rules: 'parse', reason: `Not parseable as HL7: ${err.message}`, message: raw.message, rejected_at: now.toISOString() } };
  }

  const ids = {
    control_id: get(msg, 'MSH-10') || null,
    trigger_event: get(msg, 'MSH-9.2') || null,
    mrn: findMrn(msg) || null,
  };
  const errors = validateAdt(msg);
  if (errors.length) {
    return { status: 'rejected', row: { ...base, ...ids, rules: errors.map((e) => `${e.rule}:${e.field}`).join(','),
      reason: errors.map((e) => e.reason).join('; '), message: raw.message, rejected_at: now.toISOString() } };
  }
  return { status: 'validated', row: { ...base, ...ids, message_time: hl7ToIso(get(msg, 'MSH-7')),
    message: raw.message, validated_at: now.toISOString() } };
}

export const VALIDATED_SCHEMA = 'message_hash:STRING,file_name:STRING,msg_no:INTEGER,control_id:STRING,trigger_event:STRING,mrn:STRING,message_time:TIMESTAMP,message:STRING,validated_at:TIMESTAMP';
export const REJECTED_SCHEMA = 'message_hash:STRING,file_name:STRING,msg_no:INTEGER,control_id:STRING,trigger_event:STRING,mrn:STRING,rules:STRING,reason:STRING,message:STRING,rejected_at:TIMESTAMP';
