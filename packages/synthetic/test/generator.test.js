import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, validateAdt, get, getSegment, splitMessages } from '@pipeline/hl7';
import { generateMessages, toBatchFile, DEFECTS } from '../generator.js';

const parsed = (msgs) => msgs.map(parseMessage);

// Issue 3: 2 patients + 1 malformed must give 6 valid and 1 rejected.
test('2 patients + 1 malformed -> 6 valid, 1 rejected', () => {
  const results = parsed(generateMessages({ patients: 2, malformed: 1, seed: 42 })).map(validateAdt);
  assert.equal(results.filter((e) => e.length === 0).length, 6);
  assert.equal(results.filter((e) => e.length > 0).length, 1);
});

test('every defect breaks exactly one rule', () => {
  const msgs = parsed(generateMessages({ patients: 0, malformed: DEFECTS.length, seed: 3 }));
  for (const [i, msg] of msgs.entries()) assert.equal(validateAdt(msg).length, 1, DEFECTS[i].name);
});

test('A08 keeps PV1 and every message declares the right structure', () => {
  for (const msg of parsed(generateMessages({ patients: 3, malformed: 0, seed: 5 }))) {
    assert.ok(getSegment(msg, 'PV1'), `${get(msg, 'MSH-9.2')} has PV1`);
    const expected = get(msg, 'MSH-9.2') === 'A03' ? 'ADT_A03' : 'ADT_A01';
    assert.equal(get(msg, 'MSH-9.3'), expected);
  }
});

// Issue 4: city, state and PIN code agree.
test('city, state and PIN prefix are consistent', () => {
  const known = { Belagavi: ['Karnataka', '590'], Chennai: ['Tamil Nadu', '600'], 'New Delhi': ['Delhi', '110'], Noida: ['Uttar Pradesh', '201'] };
  for (const msg of parsed(generateMessages({ patients: 15, malformed: 0, seed: 11 }))) {
    const [city, state, pin] = [get(msg, 'PID-11.3'), get(msg, 'PID-11.4'), get(msg, 'PID-11.5')];
    assert.match(pin, /^\d{6}$/);
    if (known[city]) assert.deepEqual([state, pin.slice(0, 3)], known[city], city);
  }
});

test('events per patient are in time order: A01 < A08 < A03', () => {
  const msgs = parsed(generateMessages({ patients: 4, malformed: 0, seed: 9 }));
  for (let i = 0; i < msgs.length; i += 3) {
    const times = msgs.slice(i, i + 3).map((m) => get(m, 'MSH-7'));
    assert.deepEqual([...times].sort(), times);
  }
});

test('batch file round-trips through the loader split', () => {
  const msgs = generateMessages({ patients: 2, malformed: 1, seed: 1 });
  assert.deepEqual(splitMessages(toBatchFile(msgs)), msgs);
});
