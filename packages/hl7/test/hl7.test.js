import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMessage, get, toAdtEvent, validateAdt, hl7Timestamp, escape, DEFAULT_DELIMITERS,
  splitMessages, messageHash,
} from '../src/index.js';
import { A01, A03, A08, A08_WITHOUT_PV1, A01_MISSING_VISIT, A01_WITHOUT_PID } from './fixtures.js';

const errorsFor = (raw) => validateAdt(parseMessage(raw));

test('parses MSH with spec-aligned field numbers', () => {
  const msg = parseMessage(A01);
  assert.equal(get(msg, 'MSH-9.1'), 'ADT');
  assert.equal(get(msg, 'MSH-9.2'), 'A01');
  assert.equal(get(msg, 'MSH-10'), 'MSG0001');
  assert.equal(get(msg, 'PID-5.1'), 'Sharma');
  assert.equal(get(msg, 'PV1-19'), 'V9001');
});

test('unescapes HL7 escape sequences', () => {
  const raw = `MSH|^~\\&|A|B|C|D|20260101||ADT^A08|X|P|2.5\rPID|1||M1^^^F^MR||O${escape('|Brien^', DEFAULT_DELIMITERS)}^Sean`;
  assert.equal(get(parseMessage(raw), 'PID-5.1'), 'O|Brien^');
});

// Issue 2: segment separators can be CR, LF or CRLF.
test('parser accepts CR, LF and CRLF segment separators', () => {
  for (const sep of ['\r', '\n', '\r\n']) {
    const msg = parseMessage(A01.replace(/\r/g, sep));
    assert.equal(get(msg, 'PV1-19'), 'V9001', `separator ${JSON.stringify(sep)}`);
  }
});

// Issue 1: split by MSH, independent of line endings, blank lines or load order.
test('splitMessages finds messages by MSH regardless of line endings', () => {
  const batch = `FHS|^~\\&\r\n${A01.replace(/\r/g, '\n')}\n\n\n${A03.replace(/\r/g, '\r\n')}\r${A08}\nFTS|1\n`;
  const msgs = splitMessages(batch);
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs.map((m) => get(parseMessage(m), 'MSH-10')), ['MSG0001', 'MSG0002', 'MSG0003']);
  assert.ok(msgs.every((m) => !m.includes('\n')), 'normalised to \\r');
  assert.equal(msgs[0], A01);
});

test('lines before the first MSH become their own message instead of being dropped', () => {
  const msgs = splitMessages(`garbage line\n${A01}`);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0], 'garbage line');
});

test('message hash is stable across line-ending styles', () => {
  const [a] = splitMessages(A01.replace(/\r/g, '\n'));
  const [b] = splitMessages(A01.replace(/\r/g, '\r\n'));
  assert.equal(messageHash(a), messageHash(b));
});

test('valid A01, A08 and A03 pass validation', () => {
  for (const raw of [A01, A08, A03]) assert.deepEqual(errorsFor(raw), []);
});

// Issue 3: structure-aware validation.
test('A08 without PV1 is rejected: ADT_A01 requires the segment', () => {
  const errors = errorsFor(A08_WITHOUT_PV1);
  assert.deepEqual(errors.map((e) => [e.rule, e.field]), [['segment', 'PV1']]);
});

test('missing PV1-19 is rejected as a required field', () => {
  const errors = errorsFor(A01_MISSING_VISIT);
  assert.deepEqual(errors.map((e) => [e.rule, e.field]), [['required_field', 'PV1-19']]);
});

test('missing PID is reported once, not once per PID field', () => {
  const errors = errorsFor(A01_WITHOUT_PID);
  assert.deepEqual(errors.map((e) => [e.rule, e.field]), [['segment', 'PID']]);
});

test('A01 becomes a canonical event with both identifiers', () => {
  const ev = toAdtEvent(parseMessage(A01));
  assert.equal(ev.eventType, 'A01');
  assert.equal(ev.patient.mrn, 'MRN100001');
  assert.equal(ev.patient.abha, '12-3456-7890-1234');
  assert.equal(ev.patient.gender, 'female');
  assert.equal(ev.patient.birthDate, '1990-02-15');
  assert.equal(ev.visit.location, 'WARD3-R12-B2');
  assert.equal(ev.visit.admitTime, '2026-10-20T10:25:00+05:30');
});

test('A03 carries the discharge time; it falls back to MSH-7 when PV1-45 is empty', () => {
  assert.equal(toAdtEvent(parseMessage(A03)).visit.dischargeTime, '2026-10-22T09:00:00+05:30');
  const noPv145 = A03.replace(/\|20261022090000$/, '');
  assert.equal(toAdtEvent(parseMessage(noPv145)).visit.dischargeTime, '2026-10-22T09:00:00+05:30');
});

test('hl7Timestamp writes IST time', () => {
  assert.equal(hl7Timestamp(new Date('2026-10-20T04:55:00Z')), '20261020102500');
});
