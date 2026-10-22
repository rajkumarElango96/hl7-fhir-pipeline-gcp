// Split a batch file into individual HL7 messages without relying on line order from
// any other system (BigQuery does not keep file row order). A message starts at each MSH.
//  - accepts CR, LF and CRLF segment separators (and mixtures)
//  - drops blank lines and the HL7 batch envelope segments (FHS, BHS, BTS, FTS)
//  - lines before the first MSH are kept as their own "message" so they are rejected
//    downstream instead of silently disappearing
import { createHash } from 'node:crypto';

const ENVELOPE = /^(FHS|BHS|BTS|FTS)\|/;

export function splitMessages(text) {
  const messages = [];
  let current = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line.trim() || ENVELOPE.test(line)) continue;
    if (line.startsWith('MSH') || current === null) {
      current = [];
      messages.push(current);
    }
    current.push(line);
  }
  // Store messages in the HL7-standard form: segments joined by \r.
  return messages.map((segments) => segments.join('\r'));
}

// SHA-256 of the normalised message: the idempotency key for loading.
export function messageHash(message) {
  return createHash('sha256').update(message, 'utf8').digest('hex');
}
