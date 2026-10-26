// Minimal HL7v2 helpers shared by the services.
// Fields are numbered as in the spec: get(msg, 'PID-5.2') = field 5, component 2.
const crypto            = require('node:crypto')
const { HL7_TZ_OFFSET } = require('../config')

const ENVELOPE = /^(FHS|BHS|BTS|FTS)\|/

// Batch file -> messages. A message starts at each MSH. Accepts CR, LF and CRLF,
// drops blank lines and batch-envelope segments. Lines before the first MSH become
// their own "message" so the validator rejects them instead of losing them.
function splitMessages(text) {
  const messages = []
  let current = null
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line.trim() || ENVELOPE.test(line)) continue
    if (line.startsWith('MSH') || current === null) {
      current = []
      messages.push(current)
    }
    current.push(line)
  }
  return messages.map(segments => segments.join('\r'))
}

// Idempotency key for a message
function messageHash(message) {
  return crypto.createHash('sha256').update(message, 'utf8').digest('hex')
}

// Message text -> { delimiters, segments: [{ name, fields }] }. fields[n] is HL7 field n.
function parseMessage(text) {
  if (typeof text !== 'string' || !text.startsWith('MSH')) {
    throw new Error('Message must start with an MSH segment')
  }
  const field = text[3]
  const [component, repetition, escape, subcomponent] = text.slice(4, 8)
  const segments = text.split(/\r\n|\r|\n/).filter(Boolean).map(line => {
    const parts = line.split(field)
    const name  = parts[0]
    if (!/^[A-Z][A-Z0-9]{2}$/.test(name)) throw new Error(`Bad segment name "${name}"`)
    // For MSH, field 1 is the separator itself, so shift by one to keep spec numbering
    return { name, fields: name === 'MSH' ? ['MSH', field, ...parts.slice(1)] : parts }
  })
  return { delimiters: { field, component, repetition, escape, subcomponent }, segments }
}

function getSegment(msg, name) {
  return msg.segments.find(s => s.name === name)
}

// One field as repetitions -> components
function repetitions(msg, segment, fieldNo) {
  const raw = segment?.fields[fieldNo]
  if (!raw) return []
  if (segment.name === 'MSH' && fieldNo <= 2) return [[raw]]
  const d = msg.delimiters
  return raw.split(d.repetition).map(rep => rep.split(d.component).map(value => unescape(value, d)))
}

// HL7 escape sequences: \F\ -> |, \S\ -> ^, \T\ -> &, \R\ -> ~, \E\ -> \
function unescape(value, d) {
  if (!value.includes(d.escape)) return value
  const map = { F: d.field, S: d.component, T: d.subcomponent, R: d.repetition, E: d.escape }
  const e   = d.escape.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  return value.replace(new RegExp(`${e}([FSTRE])${e}`, 'g'), (_, k) => map[k])
}

// Value at an HL7 path like 'MSH-10' or 'PID-5.2' (first repetition). '' when absent.
function get(msg, path) {
  const match = /^([A-Z][A-Z0-9]{2})-(\d+)(?:\.(\d+))?$/.exec(path)
  if (!match) throw new Error(`Bad HL7 path "${path}"`)
  const [, segment, fieldNo, componentNo] = match
  const reps = repetitions(msg, getSegment(msg, segment), Number(fieldNo))
  return reps[0]?.[(Number(componentNo) || 1) - 1] ?? ''
}

// PID-3 holds several identifiers; pick one by its type code (CX.5), e.g. 'MR' or 'ABHA'
function findIdentifier(msg, typeCode) {
  const hit = repetitions(msg, getSegment(msg, 'PID'), 3).find(c => c[4] === typeCode)
  return hit ? hit[0] : ''
}

const findMrn = msg => findIdentifier(msg, 'MR')

// HL7 TS (YYYYMMDD[HHMM[SS]][+ZZZZ]) -> ISO 8601. Dates stay dates; times use the
// message's own offset, or HL7_TZ_OFFSET when it has none.
function hl7ToIso(ts) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?(?:\.\d+)?([+-]\d{4})?/.exec(ts || '')
  if (!m) return undefined
  const [, y, mo, d, h, mi, s, tz] = m
  if (!h) return `${y}-${mo}-${d}`
  const offset = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : HL7_TZ_OFFSET
  return `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}${offset}`
}

module.exports = { splitMessages, messageHash, parseMessage, getSegment, get, findIdentifier, findMrn, hl7ToIso }
