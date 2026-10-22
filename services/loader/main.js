// Loader service (manual phase): batch file -> NDJSON, one raw row per message, for `bq load`.
// Usage: npm run load -- [--in data/sample.hl7] [--out data/raw.ndjson]
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '@pipeline/config';
import { toRawRows, toNdjson, RAW_SCHEMA } from './loader.js';

const { values } = parseArgs({
  options: {
    in: { type: 'string', default: 'data/sample.hl7' },
    out: { type: 'string', default: 'data/raw.ndjson' },
  },
});

const rows = toRawRows({ fileName: basename(values.in), text: readFileSync(values.in, 'utf8') });
writeFileSync(values.out, toNdjson(rows));

const cfg = loadConfig();
console.log(`${rows.length} messages -> ${values.out}`);
console.log('\nLoad into BigQuery:');
console.log(`  bq load --source_format=NEWLINE_DELIMITED_JSON ${cfg.rawDataset}.messages ${values.out} ${RAW_SCHEMA}`);
