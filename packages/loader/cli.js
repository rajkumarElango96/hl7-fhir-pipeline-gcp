// Manual-phase loader: turn a batch file into NDJSON (one row per message) for `bq load`.
// Usage: npm run prepare-raw -- data/sample.hl7 [--out data/sample.ndjson]
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '@pipeline/config';
import { toRawRows, toNdjson, RAW_SCHEMA } from './index.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
const input = positionals[0];
if (!input) {
  console.error('Usage: npm run prepare-raw -- <batch.hl7> [--out file.ndjson]');
  process.exit(1);
}

const out = values.out ?? input.replace(/\.[^.]+$/, '') + '.ndjson';
const rows = toRawRows({ fileName: basename(input), text: readFileSync(input, 'utf8') });
writeFileSync(out, toNdjson(rows));

const cfg = loadConfig();
console.log(`wrote ${rows.length} messages to ${out}`);
console.log('\nLoad into BigQuery:');
console.log(`  bq load --source_format=NEWLINE_DELIMITED_JSON ${cfg.rawDataset}.messages ${out} ${RAW_SCHEMA}`);
