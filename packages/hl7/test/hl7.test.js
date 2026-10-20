import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, get, toAdtEvent, validateAdt, buildAck, frame, createDecoder, escape, DEFAULT_DELIMITERS } from '../src/index.js';
import { A01, A03 } from './fixtures.js';

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

test('A03 carries the discharge time', () => {
  const ev = toAdtEvent(parseMessage(A03));
  assert.equal(ev.eventType, 'A03');
  assert.equal(ev.visit.dischargeTime, '2026-10-22T09:00:00+05:30');
});

test('validation reports missing PV1-19 and MRN', () => {
  const bad = A01.replace('MRN100001^^^APOLLO-SYN^MR~', '').replace('V9001', '');
  const errors = validateAdt(parseMessage(bad));
  assert.ok(errors.some((e) => e.includes('PID-3')));
  assert.ok(errors.some((e) => e.includes('PV1-19')));
});

test('ACK echoes the control id', () => {
  const ack = parseMessage(buildAck(parseMessage(A01), 'AA'));
  assert.equal(get(ack, 'MSA-1'), 'AA');
  assert.equal(get(ack, 'MSA-2'), 'MSG0001');
});

test('MLLP decoder handles split and joined frames', () => {
  const got = [];
  const dec = createDecoder((m) => got.push(m));
  const both = Buffer.concat([frame('one'), frame('two')]);
  dec.push(both.subarray(0, 4));
  dec.push(both.subarray(4));
  assert.deepEqual(got, ['one', 'two']);
});
