// CLI: node services/hl7-simulator/index.js [--patients 3] [--malformed 0] [--seed 42]
import { parseArgs } from 'node:util';
import { createLogger } from '@pipeline/common';
import { simulate } from './simulator.js';

const log = createLogger('hl7-simulator');
const { values } = parseArgs({
  options: {
    patients: { type: 'string', default: '3' },
    malformed: { type: 'string', default: '0' },
    seed: { type: 'string' },
  },
});

const summary = await simulate({
  patients: Number(values.patients),
  malformed: Number(values.malformed),
  seed: values.seed,
  onSent: (info) => log.info(info, 'sent'),
});
log.info(summary, 'done');
