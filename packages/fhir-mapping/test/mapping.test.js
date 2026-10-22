import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, toAdtEvent } from '@pipeline/hl7';
import { mapAdtToBundle, planBundle, sourceMessageTime, EXT_SOURCE_TIME } from '../src/index.js';
import { A01, A03, A08 } from '../../hl7/test/fixtures.js';

const eventFor = (raw) => toAdtEvent(parseMessage(raw));
const UUID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// What a stored resource looks like after a previous write.
const stored = (resourceType, id, versionId, fromRaw) => {
  const entry = mapAdtToBundle(eventFor(fromRaw)).entry.find((e) => e.resource.resourceType === resourceType);
  return { ...entry.resource, id, meta: { versionId } };
};

test('A01 on an empty store: conditional upserts keyed on facility-scoped identifiers', () => {
  const b = mapAdtToBundle(eventFor(A01));
  assert.equal(b.type, 'transaction');
  const [pat, enc] = b.entry;
  assert.equal(pat.request.method, 'PUT');
  assert.equal(pat.request.url, 'Patient?identifier=urn%3Asyn%3Aapollo%3Amrn%7CMRN100001');
  assert.equal(enc.request.url, 'Encounter?identifier=urn%3Asyn%3Aapollo%3Avisit%7CV9001');
  assert.equal(pat.resource.identifier[0].system, 'urn:syn:apollo:mrn');
  assert.deepEqual(pat.resource.name, [{ use: 'official', family: 'Sharma', given: ['Priya'] }]);
  assert.match(pat.fullUrl, UUID);
  assert.equal(enc.resource.subject.reference, pat.fullUrl);
  assert.equal(enc.resource.status, 'in-progress');
  assert.equal(enc.resource.class.code, 'IMP');
  assert.equal(enc.resource.period.end, undefined);
  assert.equal(sourceMessageTime(pat.resource), '2026-10-20T10:30:00+05:30');
});

test('the same identifier always gets the same fullUrl', () => {
  assert.equal(mapAdtToBundle(eventFor(A01)).entry[0].fullUrl, mapAdtToBundle(eventFor(A03)).entry[0].fullUrl);
});

test('no nulls or empty values reach FHIR', () => {
  const json = JSON.stringify(mapAdtToBundle(eventFor(A08.replace('+919800000000', ''))));
  assert.ok(!json.includes('null') && !json.includes('""') && !json.includes('[]') && !json.includes('{}'));
});

test('A08 only touches the Patient', () => {
  const b = mapAdtToBundle(eventFor(A08));
  assert.equal(b.entry.length, 1);
  assert.equal(b.entry[0].resource.telecom[0].value, '+919800000000');
});

test('A03 after A01: updates with If-Match on the stored version', () => {
  const current = { patient: stored('Patient', 'p1', '1', A01), encounter: stored('Encounter', 'e1', '1', A01) };
  const { bundle, skipped } = planBundle(eventFor(A03), current);
  assert.deepEqual(skipped, []);
  const [pat, enc] = bundle.entry;
  assert.deepEqual(pat.request, { method: 'PUT', url: 'Patient/p1', ifMatch: 'W/"1"' });
  assert.deepEqual(enc.request, { method: 'PUT', url: 'Encounter/e1', ifMatch: 'W/"1"' });
  assert.equal(enc.resource.status, 'finished');
  assert.equal(enc.resource.period.end, '2026-10-22T09:00:00+05:30');
});

// The known gap from the manual run: a late admit must not reopen a finished encounter.
test('out of order: a late A01 after A03 is skipped, the encounter stays finished', () => {
  const current = { patient: stored('Patient', 'p1', '3', A03), encounter: stored('Encounter', 'e1', '2', A03) };
  const { bundle, skipped } = planBundle(eventFor(A01), current);
  assert.equal(bundle.entry.length, 0);
  assert.deepEqual(skipped.map((s) => s.resourceType), ['Patient', 'Encounter']);
});

test('out of order: a late A08 does not overwrite newer demographics', () => {
  const current = { patient: stored('Patient', 'p1', '3', A03) };
  const { bundle, skipped } = planBundle(eventFor(A08), current);
  assert.equal(bundle.entry.length, 0);
  assert.equal(skipped[0].resourceType, 'Patient');
});

test('replaying the same message is a no-op', () => {
  const current = { patient: stored('Patient', 'p1', '1', A01), encounter: stored('Encounter', 'e1', '1', A01) };
  assert.equal(planBundle(eventFor(A01), current).bundle.entry.length, 0);
});

test('when the Patient write is skipped, the Encounter references the stored Patient', () => {
  // Patient already reflects a newer A08; the encounter has not been seen yet.
  const current = { patient: stored('Patient', 'p1', '2', A08) };
  const { bundle } = planBundle(eventFor(A01), current);
  assert.equal(bundle.entry.length, 1);
  assert.equal(bundle.entry[0].resource.subject.reference, 'Patient/p1');
  assert.equal(bundle.entry[0].resource.extension[0].url, EXT_SOURCE_TIME);
});
