// FHIR transformer service (manual phase).
// Dry run (default): validated rows -> FHIR transaction bundles written to a file.
// --send: write to the Cloud Healthcare API FHIR store named in .env, newest message wins.
// Usage: npm run transform -- [--in data/validated.ndjson] [--out data/bundles.ndjson] [--send]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createFhirClient } from './fhir-client.js';
import { transformRow } from './transformer.js';

const { values } = parseArgs({
  options: {
    in: { type: 'string', default: 'data/validated.ndjson' },
    out: { type: 'string', default: 'data/bundles.ndjson' },
    send: { type: 'boolean', default: false },
  },
});

// Oldest first, so a normal run applies A01 -> A08 -> A03 in order.
const rows = readFileSync(values.in, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .sort((a, b) => Date.parse(a.message_time) - Date.parse(b.message_time));

const client = values.send ? createFhirClient() : null;
const bundles = [];
let failed = 0;

for (const row of rows) {
  try {
    const { controlId, event, bundle, skipped, result } = await transformRow(row, client);
    bundles.push(bundle);
    const label = `${controlId} ${event.eventType} ${event.patient.mrn}`;
    if (!client) console.log(`PLANNED ${label}  ${bundle.entry.map((e) => `${e.request.method} ${decodeURIComponent(e.request.url)}`).join(' | ')}`);
    else if (result) console.log(`SENT    ${label}  ${result.entry.map((e) => `${e.response.status} ${e.response.location}`).join(' | ')}`);
    for (const s of skipped) console.log(`SKIPPED ${label}  ${s.resourceType}/${s.id}: ${s.reason}`);
  } catch (err) {
    failed++;
    console.error(`FAILED  ${row.control_id}: ${err.message}`);
  }
}

writeFileSync(values.out, bundles.map((b) => JSON.stringify(b)).join('\n') + '\n');
console.log(`\n${rows.length - failed} processed, ${failed} failed. Bundles: ${values.out}${client ? '' : ' (dry run; add --send to write to the FHIR store)'}`);
if (failed) process.exitCode = 1;
