// Pure mapping: canonical ADT event -> FHIR R4 transaction Bundle.
// Every write is a conditional PUT on a business identifier, so replaying the same
// message updates the same resources instead of creating duplicates (idempotent).

export const SYSTEMS = {
  mrn: 'https://fhir.pipeline.local/sid/mrn',
  visit: 'https://fhir.pipeline.local/sid/visit-number',
  abha: 'https://healthid.ndhm.gov.in',
  sourceMessage: 'https://fhir.pipeline.local/sid/hl7-control-id',
};

const ENCOUNTER_CLASS = {
  I: { code: 'IMP', display: 'inpatient encounter' },
  O: { code: 'AMB', display: 'ambulatory' },
  E: { code: 'EMER', display: 'emergency' },
};

const STATUS_BY_TRIGGER = { A01: 'in-progress', A03: 'finished' };

// Deterministic placeholder ids let the Encounter reference the Patient inside one transaction.
const patientFullUrl = (mrn) => `urn:uuid:patient-${mrn}`;

export function mapPatient(event) {
  const p = event.patient;
  const identifier = [{ use: 'usual', type: mrType(), system: SYSTEMS.mrn, value: p.mrn }];
  if (p.abha) identifier.push({ system: SYSTEMS.abha, value: p.abha });

  const resource = {
    resourceType: 'Patient',
    meta: { source: `${event.sendingFacility}#${event.controlId}` },
    identifier,
    active: true,
    name: [{ use: 'official', family: p.family, given: p.given ? [p.given] : undefined }],
    gender: p.gender,
    birthDate: p.birthDate,
    telecom: p.phone ? [{ system: 'phone', value: p.phone, use: 'mobile' }] : undefined,
    address: hasAddress(p.address) ? [{ use: 'home', ...dropEmpty(p.address) }] : undefined,
  };

  return {
    fullUrl: patientFullUrl(p.mrn),
    resource: dropEmpty(resource),
    request: { method: 'PUT', url: `Patient?identifier=${enc(SYSTEMS.mrn)}|${enc(p.mrn)}` },
  };
}

export function mapEncounter(event) {
  const v = event.visit;
  const cls = ENCOUNTER_CLASS[v.patientClass] ?? ENCOUNTER_CLASS.I;
  const resource = {
    resourceType: 'Encounter',
    meta: { source: `${event.sendingFacility}#${event.controlId}` },
    identifier: [{ use: 'official', system: SYSTEMS.visit, value: v.visitNumber }],
    status: STATUS_BY_TRIGGER[event.eventType] ?? 'in-progress',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', ...cls },
    subject: { reference: patientFullUrl(event.patient.mrn) },
    period: dropEmpty({ start: v.admitTime, end: event.eventType === 'A03' ? v.dischargeTime : undefined }),
    participant: v.attending?.name
      ? [{ individual: { display: `Dr. ${v.attending.name}`, identifier: { value: v.attending.id } } }]
      : undefined,
    location: v.location ? [{ location: { display: v.location } }] : undefined,
    serviceProvider: event.sendingFacility ? { display: event.sendingFacility } : undefined,
  };

  return {
    fullUrl: `urn:uuid:encounter-${v.visitNumber}`,
    resource: dropEmpty(resource),
    request: { method: 'PUT', url: `Encounter?identifier=${enc(SYSTEMS.visit)}|${enc(v.visitNumber)}` },
  };
}

export function mapAdtToBundle(event) {
  const entry = [mapPatient(event)];
  // A08 is a demographics update; A01/A03 also carry the visit.
  if (event.eventType !== 'A08' && event.visit) entry.push(mapEncounter(event));
  return { resourceType: 'Bundle', type: 'transaction', entry };
}

// Domain event name emitted after a successful write.
export function domainEventName(eventType) {
  return { A01: 'patient.admitted', A03: 'patient.discharged', A08: 'patient.updated' }[eventType];
}

function mrType() {
  return { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR', display: 'Medical record number' }] };
}

function hasAddress(a) {
  return a && (a.line || a.city || a.state || a.postalCode);
}

const enc = (s) => encodeURIComponent(s);

// Remove undefined / empty-string values so the FHIR JSON stays clean.
function dropEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = k === 'line' && typeof v === 'string' ? [v] : v;
  }
  return out;
}
