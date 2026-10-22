// Validator service (manual phase): raw rows -> validated rows + rejected rows.
// Usage: npm run validate -- [--in data/raw.ndjson] [--validated data/validated.ndjson] [--rejected data/rejected.ndjson]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '@pipeline/config';
import { validateRow, VALIDATED_SCHEMA, REJECTED_SCHEMA } from './validator.js';

const { values } = parseArgs({
  options: {
    in: { type: 'string', default: 'data/raw.ndjson' },
    validated: { type: 'string', default: 'data/validated.ndjson' },
    rejected: { type: 'string', default: 'data/rejected.ndjson' },
  },
});

const rawRows = readFileSync(values.in, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const out = { validated: [], rejected: [] };
for (const raw of rawRows) {
  const { status, row } = validateRow(raw);
  out[status].push(row);
  console.log(`${status === 'validated' ? 'VALID   ' : 'REJECTED'} #${raw.msg_no} ${row.control_id ?? '-'} ${row.trigger_event ?? ''}${row.reason ? `  ${row.reason}` : ''}`);
}

const ndjson = (rows) => (rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : '');
writeFileSync(values.validated, ndjson(out.validated));
writeFileSync(values.rejected, ndjson(out.rejected));

const cfg = loadConfig();
console.log(`\n${out.validated.length} validated -> ${values.validated}, ${out.rejected.length} rejected -> ${values.rejected}`);
console.log('\nLoad into BigQuery:');
console.log(`  bq load --source_format=NEWLINE_DELIMITED_JSON ${cfg.qualityDataset}.validated ${values.validated} ${VALIDATED_SCHEMA}`);
console.log(`  bq load --source_format=NEWLINE_DELIMITED_JSON ${cfg.qualityDataset}.rejected ${values.rejected} ${REJECTED_SCHEMA}`);
