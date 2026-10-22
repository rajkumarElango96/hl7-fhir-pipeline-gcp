import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRawRows } from '../index.js';
import { A01, A03, A08 } from '../../hl7/test/fixtures.js';

test('one row per message with a content hash, independent of line endings', () => {
  const text = `${A01.replace(/\r/g, '\r\n')}\n\n${A08.replace(/\r/g, '\n')}\n${A03}`;
  const rows = toRawRows({ fileName: 'batch.hl7', text, loadedAt: new Date('2026-10-21T00:00:00Z') });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.msg_no), [1, 2, 3]);
  assert.equal(rows[0].message, A01);
  assert.match(rows[0].message_hash, /^[0-9a-f]{64}$/);
  assert.equal(rows[0].loaded_at, '2026-10-21T00:00:00.000Z');
});

test('reloading the same file gives the same hashes (idempotent load key)', () => {
  const a = toRawRows({ fileName: 'x', text: `${A01}\n\n${A03}` }).map((r) => r.message_hash);
  const b = toRawRows({ fileName: 'x', text: `${A01}\r\n\r\n${A03}` }).map((r) => r.message_hash);
  assert.deepEqual(a, b);
});
