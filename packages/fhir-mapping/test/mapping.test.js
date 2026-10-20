import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, toAdtEvent } from '@pipeline/hl7';
import { mapAdtToBundle, SYSTEMS } from '../src/index.js';
import { A01, A03, A08 } from '../../hl7/test/fixtures.js';

const bundleFor = (raw) => mapAdtToBundle(toAdtEvent(parseMessage(raw)));

test('A01 -> transaction with conditional Patient + Encounter upserts', () => {
  const b = bundleFor(A01);
  assert.equal(b.type, 'transaction');
  const [pat, enc] = b.entry;
  assert.equal(pat.request.method, 'PUT');
  assert.equal(pat.request.url, `Patient?identifier=${encodeURIComponent(SYSTEMS.mrn)}|MRN100001`);
  assert.deepEqual(pat.resource.name, [{ use: 'official', family: 'Sharma', given: ['Priya'] }]);
  assert.equal(pat.resource.identifier[1].system, SYSTEMS.abha);
  assert.deepEqual(pat.resource.address[0].line, ['12 MG Road']);
  assert.equal(enc.resource.status, 'in-progress');
  assert.equal(enc.resource.class.code, 'IMP');
  assert.equal(enc.resource.subject.reference, pat.fullUrl);
  assert.equal(enc.resource.period.end, undefined);
});

test('A03 finishes the encounter', () => {
  const enc = bundleFor(A03).entry[1].resource;
  assert.equal(enc.status, 'finished');
  assert.equal(enc.period.end, '2026-10-22T09:00:00+05:30');
});

test('A08 only touches the Patient', () => {
  const b = bundleFor(A08);
  assert.equal(b.entry.length, 1);
  assert.equal(b.entry[0].resource.telecom[0].value, '+919800000000');
});
