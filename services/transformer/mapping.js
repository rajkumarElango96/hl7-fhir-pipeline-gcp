// Pure mapping: ADT event -> FHIR R4 transaction Bundle.
//
// Idempotent: resources are keyed on business identifiers (MRN, visit number), so replaying
// a message updates the same resources instead of creating duplicates.
//
// Newest message wins: each resource records the MSH-7 time of the message that wrote it.
// planBundle() compares that with the incoming message and leaves stale writes out.
// Updates carry If-Match on the current version, so a concurrent writer causes a retry
// instead of a lost update.
const crypto = require('node:crypto')

const ABHA_SYSTEM        = 'https://healthid.ndhm.gov.in'
const EXT_SOURCE_TIME    = 'https://fhir.pipeline.local/StructureDefinition/source-message-time'
const EXT_SOURCE_CONTROL = 'https://fhir.pipeline.local/StructureDefinition/source-control-id'
const ACT_CODE_SYSTEM    = 'http://terminology.hl7.org/CodeSystem/v3-ActCode'

const ENCOUNTER_CLASS = {
  I: { code: 'IMP',  display: 'inpatient encounter' },
  O: { code: 'AMB',  display: 'ambulatory' },
  E: { code: 'EMER', display: 'emergency' },
}
const STATUS_BY_TRIGGER = { A01: 'in-progress', A03: 'finished' }

// MRNs and visit numbers are only unique within a hospital, so the system names it:
// SYNH-CHN -> urn:syn:synh-chn:mrn
const identifierSystem = (facility, kind) =>
  `urn:syn:${(facility || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${kind}`

// Conditional reference "Type?identifier=system|value", whole token encoded (| -> %7C)
const conditionalUrl = (type, system, value) => `${type}?identifier=${encodeURIComponent(`${system}|${value}`)}`

// Stable UUID per identifier, so the same patient always gets the same fullUrl in a bundle
function uuidFor(name) {
  const h = crypto.createHash('sha1').update(name).digest()
  h[6] = (h[6] & 0x0f) | 0x50
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.subarray(0, 16).toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`
}

const sourceExtensions = event => [
  { url: EXT_SOURCE_TIME,    valueDateTime: event.messageTime },
  { url: EXT_SOURCE_CONTROL, valueString: event.controlId },
]

const sourceMessageTime = resource =>
  resource?.extension?.find(e => e.url === EXT_SOURCE_TIME)?.valueDateTime

function patientResource(event) {
  const p = event.patient
  const identifier = [{
    use:    'usual',
    type:   { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
    system: identifierSystem(event.sendingFacility, 'mrn'),
    value:  p.mrn,
  }]
  if (p.abha) identifier.push({ system: ABHA_SYSTEM, value: p.abha })

  return clean({
    resourceType: 'Patient',
    extension:    sourceExtensions(event),
    identifier,
    active:       true,
    name:         [{ use: 'official', family: p.family, given: p.given ? [p.given] : undefined }],
    gender:       p.gender,
    birthDate:    p.birthDate,
    telecom:      p.phone ? [{ system: 'phone', value: p.phone, use: 'mobile' }] : undefined,
    address:      [{ use: 'home', line: p.address.line ? [p.address.line] : undefined, city: p.address.city,
                     state: p.address.state, postalCode: p.address.postalCode, country: p.address.country }],
  })
}

function encounterResource(event, subjectReference) {
  const v   = event.visit
  const cls = ENCOUNTER_CLASS[v.patientClass] ?? ENCOUNTER_CLASS.I

  return clean({
    resourceType:    'Encounter',
    extension:       sourceExtensions(event),
    identifier:      [{ use: 'official', system: identifierSystem(event.sendingFacility, 'visit'), value: v.visitNumber }],
    status:          STATUS_BY_TRIGGER[event.eventType] ?? 'in-progress',
    class:           { system: ACT_CODE_SYSTEM, ...cls },
    // PV1-10 hospital service codes are local to each hospital (HL7 table 0069 is user-defined)
    serviceType:     v.service ? { coding: [{ system: identifierSystem(event.sendingFacility, 'service'), code: v.service }] } : undefined,
    subject:         { reference: subjectReference },
    period:          { start: v.admitTime, end: event.eventType === 'A03' ? v.dischargeTime : undefined },
    participant:     v.attending.name
      ? [{ individual: { display: `Dr. ${v.attending.name}`, identifier: { value: v.attending.id } } }]
      : undefined,
    location:        v.location ? [{ location: { display: v.location } }] : undefined,
    serviceProvider: event.sendingFacility ? { display: event.sendingFacility } : undefined,
  })
}

// create: nothing stored | update: stored copy is older | skip: stored copy is the same or newer
function decide(current, incomingTime) {
  if (!current) return 'create'
  const storedTime = sourceMessageTime(current)
  return storedTime && Date.parse(storedTime) >= Date.parse(incomingTime) ? 'skip' : 'update'
}

function entryFor(resource, { type, system, value, current, decision }) {
  const fullUrl = `urn:uuid:${uuidFor(`${system}|${value}`)}`
  if (decision === 'create') {
    // Conditional update: creates the resource when nothing matches (needs update-create on the store)
    return { fullUrl, resource, request: { method: 'PUT', url: conditionalUrl(type, system, value) } }
  }
  const request = { method: 'PUT', url: `${type}/${current.id}` }
  if (current.meta?.versionId) request.ifMatch = `W/"${current.meta.versionId}"`
  return { fullUrl, resource: { ...resource, id: current.id }, request }
}

// One transaction for one event, given what the store holds now:
//   current = { patient?, encounter? }  (looked up by identifier beforehand)
// Returns { bundle, skipped } where skipped lists the stale writes left out.
function planBundle(event, current = {}) {
  const entry   = []
  const skipped = []

  const mrnSystem       = identifierSystem(event.sendingFacility, 'mrn')
  const patientDecision = decide(current.patient, event.messageTime)
  let subject
  if (patientDecision === 'skip') {
    skipped.push(`Patient/${current.patient.id}`)
    subject = `Patient/${current.patient.id}`
  } else {
    const e = entryFor(patientResource(event), {
      type: 'Patient', system: mrnSystem, value: event.patient.mrn, current: current.patient, decision: patientDecision,
    })
    entry.push(e)
    subject = e.fullUrl
  }

  // A08 is a demographics update: it writes the Patient only
  if (event.eventType !== 'A08') {
    const visitSystem       = identifierSystem(event.sendingFacility, 'visit')
    const encounterDecision = decide(current.encounter, event.messageTime)
    if (encounterDecision === 'skip') {
      skipped.push(`Encounter/${current.encounter.id}`)
    } else {
      entry.push(entryFor(encounterResource(event, subject), {
        type: 'Encounter', system: visitSystem, value: event.visit.visitNumber,
        current: current.encounter, decision: encounterDecision,
      }))
    }
  }

  return { bundle: { resourceType: 'Bundle', type: 'transaction', entry }, skipped }
}

// FHIR rejects null and empty values: drop undefined, null, '' and empty arrays/objects
function clean(value) {
  if (Array.isArray(value)) {
    const items = value.map(clean).filter(v => v !== undefined)
    return items.length ? items : undefined
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      const c = clean(v)
      if (c !== undefined) out[k] = c
    }
    return Object.keys(out).length ? out : undefined
  }
  return value === null || value === '' ? undefined : value
}

module.exports = { planBundle, identifierSystem }
