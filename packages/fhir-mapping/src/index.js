// Pure mapping: canonical ADT event -> FHIR R4 transaction Bundle.
//
// Idempotent: resources are keyed on business identifiers (MRN, visit number), so replaying a
// message updates the same resources instead of creating duplicates.
//
// Newest message wins: each resource records the MSH-7 time of the message it came from.
// planBundle() compares that with the incoming message and skips stale writes. Updates carry
// If-Match on the current version, so a concurrent writer causes a retry instead of a lost update.
import { createHash } from 'node:crypto';

export const ABHA_SYSTEM = 'https://healthid.ndhm.gov.in';
export const EXT_SOURCE_TIME = 'https://fhir.pipeline.local/StructureDefinition/source-message-time';
export const EXT_SOURCE_CONTROL_ID = 'https://fhir.pipeline.local/StructureDefinition/source-control-id';

const ENCOUNTER_CLASS = {
  I: { code: 'IMP', display: 'inpatient encounter' },
  O: { code: 'AMB', display: 'ambulatory' },
  E: { code: 'EMER', display: 'emergency' },
};
const STATUS_BY_TRIGGER = { A01: 'in-progress', A03: 'finished' };

// MRNs and visit numbers are only unique within a hospital, so the identifier system names it:
// AIIMS-SYN -> urn:syn:aiims:mrn
export function facilityCode(facility) {
  return (facility || 'unknown').toLowerCase().replace(/-syn$/, '').replace(/[^a-z0-9]+/g, '-');
}
export function identifierSystem(facility, kind) {
  return `urn:syn:${facilityCode(facility)}:${kind}`;
}

// Conditional reference "Type?identifier=system|value" with the whole token encoded (| -> %7C).
export function conditionalUrl(type, system, value) {
  return `${type}?identifier=${encodeURIComponent(`${system}|${value}`)}`;
}

// Stable RFC 4122 UUID (v5-style, SHA-1) so the same identifier always gets the same fullUrl.
export function uuidFor(name) {
  const h = createHash('sha1').update(name).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export function sourceMessageTime(resource) {
  return resource?.extension?.find((e) => e.url === EXT_SOURCE_TIME)?.valueDateTime;
}

function sourceExtensions(event) {
  return [
    { url: EXT_SOURCE_TIME, valueDateTime: event.messageTime },
    { url: EXT_SOURCE_CONTROL_ID, valueString: event.controlId },
  ];
}

export function patientResource(event) {
  const p = event.patient;
  const identifier = [{
    use: 'usual',
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
    system: identifierSystem(event.sendingFacility, 'mrn'),
    value: p.mrn,
  }];
  if (p.abha) identifier.push({ system: ABHA_SYSTEM, value: p.abha });
  return clean({
    resourceType: 'Patient',
    extension: sourceExtensions(event),
    identifier,
    active: true,
    name: [{ use: 'official', family: p.family, given: p.given ? [p.given] : undefined }],
    gender: p.gender,
    birthDate: p.birthDate,
    telecom: p.phone ? [{ system: 'phone', value: p.phone, use: 'mobile' }] : undefined,
    address: p.address && (p.address.line || p.address.city)
      ? [{ use: 'home', line: p.address.line ? [p.address.line] : undefined, city: p.address.city,
          state: p.address.state, postalCode: p.address.postalCode, country: p.address.country }]
      : undefined,
  });
}

export function encounterResource(event, subjectReference) {
  const v = event.visit;
  const cls = ENCOUNTER_CLASS[v.patientClass] ?? ENCOUNTER_CLASS.I;
  return clean({
    resourceType: 'Encounter',
    extension: sourceExtensions(event),
    identifier: [{ use: 'official', system: identifierSystem(event.sendingFacility, 'visit'), value: v.visitNumber }],
    status: STATUS_BY_TRIGGER[event.eventType] ?? 'in-progress',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', ...cls },
    subject: { reference: subjectReference },
    period: { start: v.admitTime, end: event.eventType === 'A03' ? v.dischargeTime : undefined },
    participant: v.attending?.name
      ? [{ individual: { display: `Dr. ${v.attending.name}`, identifier: { value: v.attending.id } } }]
      : undefined,
    location: v.location ? [{ location: { display: v.location } }] : undefined,
    serviceProvider: event.sendingFacility ? { display: event.sendingFacility } : undefined,
  });
}

// create: nothing stored yet | update: stored version is older | skip: stored version is newer or the same
export function decide(current, incomingTime) {
  if (!current) return 'create';
  const storedTime = sourceMessageTime(current);
  if (storedTime && Date.parse(storedTime) >= Date.parse(incomingTime)) return 'skip';
  return 'update';
}

function entryFor(resource, { type, system, value, current, decision }) {
  const fullUrl = `urn:uuid:${uuidFor(`${system}|${value}`)}`;
  if (decision === 'create') {
    // Conditional update: creates the resource if no match exists (requires update-create on the store).
    return { fullUrl, resource, request: { method: 'PUT', url: conditionalUrl(type, system, value) } };
  }
  const request = { method: 'PUT', url: `${type}/${current.id}` };
  if (current.meta?.versionId) request.ifMatch = `W/"${current.meta.versionId}"`;
  return { fullUrl, resource: { ...resource, id: current.id }, request };
}

// Build the transaction for one event, given what the store currently holds:
//   current = { patient?: Patient, encounter?: Encounter } (looked up by identifier beforehand)
// Returns { bundle, skipped } where skipped lists stale writes that were left out.
export function planBundle(event, current = {}) {
  const entry = [];
  const skipped = [];

  const mrnSystem = identifierSystem(event.sendingFacility, 'mrn');
  const patientDecision = decide(current.patient, event.messageTime);
  let subject;
  if (patientDecision === 'skip') {
    skipped.push({ resourceType: 'Patient', id: current.patient.id, reason: 'stored version comes from a newer message' });
    subject = `Patient/${current.patient.id}`;
  } else {
    const e = entryFor(patientResource(event), { type: 'Patient', system: mrnSystem, value: event.patient.mrn, current: current.patient, decision: patientDecision });
    entry.push(e);
    subject = e.fullUrl;
  }

  // A08 is a demographics update; A01 and A03 also write the visit.
  if (event.eventType !== 'A08') {
    const visitSystem = identifierSystem(event.sendingFacility, 'visit');
    const encounterDecision = decide(current.encounter, event.messageTime);
    if (encounterDecision === 'skip') {
      skipped.push({ resourceType: 'Encounter', id: current.encounter.id, reason: 'stored version comes from a newer message' });
    } else {
      entry.push(entryFor(encounterResource(event, subject), {
        type: 'Encounter', system: visitSystem, value: event.visit.visitNumber, current: current.encounter, decision: encounterDecision,
      }));
    }
  }
  return { bundle: { resourceType: 'Bundle', type: 'transaction', entry }, skipped };
}

// Bundle for an empty store (no stale-write checks needed).
export const mapAdtToBundle = (event) => planBundle(event).bundle;

// FHIR rejects null and empty values: remove undefined, null, '' and empty arrays/objects, recursively.
function clean(value) {
  if (Array.isArray(value)) {
    const arr = value.map(clean).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = clean(v);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value === null || value === '' ? undefined : value;
}
