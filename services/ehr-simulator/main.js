// EHR simulator service (the "legacy hospital system"): writes a batch file of HL7v2 ADT messages.
// Usage: npm run simulate -- [--patients 2] [--malformed 1] [--seed 42] [--out data/sample.hl7]
// POC limit: at most 15 patients (45 messages) and 5 malformed per batch.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { generateMessages, toBatchFile } from './generator.js';

const { values } = parseArgs({
  options: {
    patients: { type: 'string', default: '2' },
    malformed: { type: 'string', default: '1' },
    seed: { type: 'string' },
    out: { type: 'string', default: `data/adt-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.hl7` },
  },
});

const patients = Math.min(Number(values.patients), 15);
const malformed = Math.min(Number(values.malformed), 5);
const messages = generateMessages({ patients, malformed, seed: values.seed });

mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, toBatchFile(messages));
console.log(`wrote ${messages.length} messages (${patients} patients x 3 + ${malformed} malformed) to ${values.out}`);
