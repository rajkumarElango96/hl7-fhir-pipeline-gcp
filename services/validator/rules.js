// Mandatory rules for ADT messages. Pure functions: no I/O, easy to read and change.
const { parseMessage, get, getSegment, findMrn, hl7ToIso } = require('../../lib/hl7')

const SUPPORTED_TRIGGERS = ['A01', 'A03', 'A08']

// HL7 v2.5: the message structure each trigger uses (MSH-9.3) and the segments it requires.
// A08 uses ADT_A01, so PV1 is mandatory for updates too.
const TRIGGER_STRUCTURE  = { A01: 'ADT_A01', A08: 'ADT_A01', A03: 'ADT_A03' }
const STRUCTURE_SEGMENTS = {
  ADT_A01: ['MSH', 'EVN', 'PID', 'PV1'],
  ADT_A03: ['MSH', 'EVN', 'PID', 'PV1'],
}

const REQUIRED_FIELDS = [
  { field: 'MSH-7',   label: 'message timestamp' },
  { field: 'MSH-10',  label: 'message control ID' },
  { field: 'PID-3',   label: 'patient MRN (identifier type MR)', read: findMrn },
  { field: 'PID-5.1', label: 'patient family name' },
  { field: 'PV1-2',   label: 'patient class' },
  { field: 'PV1-19',  label: 'visit number' },
]

// Parsed message -> [] when valid, otherwise [{ rule, field, reason }]
function validateAdt(msg) {
  const errors = []
  const fail   = (rule, field, reason) => errors.push({ rule, field, reason })

  const type    = get(msg, 'MSH-9.1')
  const trigger = get(msg, 'MSH-9.2')
  if (type !== 'ADT') fail('message_type', 'MSH-9.1', `Message type must be ADT, got "${type}"`)
  if (!SUPPORTED_TRIGGERS.includes(trigger)) {
    fail('trigger', 'MSH-9.2', `Trigger must be one of ${SUPPORTED_TRIGGERS.join(', ')}, got "${trigger}"`)
    return errors
  }

  const structure = get(msg, 'MSH-9.3') || TRIGGER_STRUCTURE[trigger]
  const required  = STRUCTURE_SEGMENTS[structure]
  if (!required) {
    fail('structure', 'MSH-9.3', `Unsupported message structure "${structure}"`)
    return errors
  }

  const missingSegments = required.filter(name => !getSegment(msg, name))
  missingSegments.forEach(name => fail('segment', name, `${name} segment is required by ${structure}`))

  for (const rule of REQUIRED_FIELDS) {
    if (missingSegments.includes(rule.field.slice(0, 3))) continue // already reported
    const value = rule.read ? rule.read(msg) : get(msg, rule.field)
    if (!value) fail('required_field', rule.field, `${rule.field} (${rule.label}) is required`)
  }
  return errors
}

// Raw row -> { status: 'validated' | 'rejected', row }
function validateRow(raw, now = new Date().toISOString()) {
  const base = { message_hash: raw.message_hash, file_name: raw.file_name, msg_no: raw.msg_no, message: raw.message }

  let msg
  try {
    msg = parseMessage(raw.message)
  } catch (err) {
    return { status: 'rejected', row: { ...base, rules: 'parse', reason: `Not parseable as HL7: ${err.message}`, rejected_at: now } }
  }

  const ids = {
    control_id:    get(msg, 'MSH-10') || null,
    trigger_event: get(msg, 'MSH-9.2') || null,
    mrn:           findMrn(msg) || null,
  }

  const errors = validateAdt(msg)
  if (errors.length) {
    return {
      status: 'rejected',
      row: {
        ...base, ...ids,
        rules:       errors.map(e => `${e.rule}:${e.field}`).join(','),
        reason:      errors.map(e => e.reason).join('; '),
        rejected_at: now,
      },
    }
  }

  return {
    status: 'validated',
    row: { ...base, ...ids, message_time: hl7ToIso(get(msg, 'MSH-7')), validated_at: now },
  }
}

module.exports = { validateAdt, validateRow }
