// Summarise what landed in HAPI: patient/encounter counts plus a few recent patients.
import { config } from '@pipeline/common';

const get = async (path) => (await fetch(`${config.fhirBaseUrl}/${path}`, { headers: { Accept: 'application/fhir+json' } })).json();

const [patients, encounters, finished] = await Promise.all([
  get('Patient?_summary=count'),
  get('Encounter?_summary=count'),
  get('Encounter?status=finished&_summary=count'),
]);
console.log(`Patients: ${patients.total}   Encounters: ${encounters.total} (finished: ${finished.total})`);

const recent = await get('Patient?_sort=-_lastUpdated&_count=5&_revinclude=Encounter:subject');
for (const e of recent.entry ?? []) {
  const r = e.resource;
  if (r.resourceType === 'Patient') {
    const mrn = r.identifier?.find((i) => i.system.endsWith('/mrn'))?.value;
    console.log(`  Patient/${r.id}  ${mrn}  ${r.name?.[0]?.given?.[0]} ${r.name?.[0]?.family}  phone ${r.telecom?.[0]?.value}  v${r.meta.versionId}`);
  } else {
    console.log(`    Encounter/${r.id}  ${r.identifier?.[0]?.value}  ${r.status}  ${r.period?.start} -> ${r.period?.end ?? '…'}`);
  }
}
