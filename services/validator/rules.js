// Mandatory rules for ADT messages. Keep in sync with the BigQuery SQL from the manual run.
import { get, getSegment, findMrn } from '@pipeline/hl7';

export const SUPPORTED_TRIGGERS = ['A01', 'A03', 'A08'];

// HL7 v2.5: the abstract message structure each trigger uses (declared in MSH-9.3).
export const TRIGGER_STRUCTURE = { A01: 'ADT_A01', A08: 'ADT_A01', A03: 'ADT_A03' };

// Segments each structure requires. Both make PV1 mandatory, A08 included.
export const STRUCTURE_SEGMENTS = {
  ADT_A01: ['MSH', 'EVN', 'PID', 'PV1'],
  ADT_A03: ['MSH', 'EVN', 'PID', 'PV1'],
};

// Mandatory fields. A field is only checked when its segment exists; a missing segment is reported once.
export const REQUIRED_FIELDS = [
  { field: 'MSH-7', label: 'message timestamp' },
  { field: 'MSH-10', label: 'message control ID' },
  { field: 'PID-3', label: 'patient MRN (identifier type MR)', read: (msg) => findMrn(msg) },
  { field: 'PID-5.1', label: 'patient family name' },
  { field: 'PV1-2', label: 'patient class' },
  { field: 'PV1-19', label: 'visit number' },
];

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
    if (missingSegments.includes(rule.field.slice(0, 3))) continue;
    const value = rule.read ? rule.read(msg) : get(msg, rule.field);
    if (!value) fail('required_field', rule.field, `${rule.field} (${rule.label}) is required`);
  }
  return errors;
}
