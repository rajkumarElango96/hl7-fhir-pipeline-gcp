import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, validateAdt } from '@pipeline/hl7';
import { generateMessages, toBatchFile } from '../generator.js';

test('valid patients pass validation, malformed messages fail it', () => {
  const msgs = generateMessages({ patients: 2, malformed: 3, seed: 7 });
  assert.equal(msgs.length, 2 * 3 + 3);
  const results = msgs.map((m) => validateAdt(parseMessage(m)));
  assert.ok(results.slice(0, 6).every((errors) => errors.length === 0));
  assert.ok(results.slice(6).every((errors) => errors.length > 0));
});

test('batch file separates messages with a blank line', () => {
  const file = toBatchFile(generateMessages({ patients: 1, malformed: 0, seed: 1 }));
  assert.equal(file.trim().split(/\n\s*\n/).length, 3);
});
