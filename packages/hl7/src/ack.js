import { randomUUID } from 'node:crypto';
import { get, escape } from './parse.js';

// HL7 timestamps in this project are local Indian time (IST, UTC+05:30), matching hl7ToIso.
const IST_OFFSET_MS = 330 * 60_000;

export function hl7Timestamp(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// Build an ACK for a parsed message. code: AA (accept), AE (error), AR (reject).
// `msg` may be null when the inbound message could not be parsed at all.
export function buildAck(msg, code, text = '') {
  const trigger = msg ? get(msg, 'MSH-9.2') : '';
  const controlId = msg ? get(msg, 'MSH-10') : '';
  const msh = [
    'MSH', '^~\\&', 'PIPELINE', 'PIPELINE',
    msg ? get(msg, 'MSH-3') : '', msg ? get(msg, 'MSH-4') : '',
    hl7Timestamp(), '', `ACK^${trigger}^ACK`, randomUUID().slice(0, 20), 'P', '2.5',
  ].join('|');
  const msa = ['MSA', code, controlId, escape(text)].join('|');
  return `${msh}\r${msa}\r`;
}
