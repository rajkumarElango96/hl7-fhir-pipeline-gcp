// Minimal HL7v2 (pipe-delimited) parser.
// Message model: { delimiters, segments: [{ name, fields: string[] }] }
// fields[n] is HL7 field n (1-based, so fields[0] is the segment name).
// For MSH, fields[1] is the field separator and fields[2] the encoding characters,
// which keeps MSH numbering identical to the spec (MSH-9 = fields[9]).

export class Hl7ParseError extends Error {}

export function parseMessage(text) {
  if (typeof text !== 'string' || !text.startsWith('MSH')) {
    throw new Hl7ParseError('Message must start with an MSH segment');
  }
  const fieldSep = text[3];
  const [component, repetition, escape, subcomponent] = text.slice(4, 8);
  const delimiters = { field: fieldSep, component, repetition, escape, subcomponent };

  const segments = text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.split(fieldSep);
      const name = parts[0];
      if (!/^[A-Z][A-Z0-9]{2}$/.test(name)) throw new Hl7ParseError(`Bad segment name "${name}"`);
      const fields = name === 'MSH' ? ['MSH', fieldSep, ...parts.slice(1)] : parts;
      return { name, fields };
    });

  return { delimiters, segments };
}

export function getSegments(msg, name) {
  return msg.segments.filter((s) => s.name === name);
}

export function getSegment(msg, name) {
  return msg.segments.find((s) => s.name === name);
}

// Split one field into repetitions -> components (strings, unescaped).
export function repetitions(msg, segment, fieldIndex) {
  const raw = segment?.fields[fieldIndex];
  if (!raw) return [];
  if (segment.name === 'MSH' && fieldIndex <= 2) return [[raw]];
  const d = msg.delimiters;
  return raw.split(d.repetition).map((rep) => rep.split(d.component).map((c) => unescape(c, d)));
}

// Read a value by HL7 path, e.g. "PID-5.2" (field 5, component 2) or "MSH-10".
// Returns the first repetition; empty string when absent.
export function get(msg, path) {
  const m = /^([A-Z][A-Z0-9]{2})-(\d+)(?:\.(\d+))?$/.exec(path);
  if (!m) throw new Error(`Bad HL7 path "${path}"`);
  const [, segName, field, comp] = m;
  const reps = repetitions(msg, getSegment(msg, segName), Number(field));
  if (reps.length === 0) return '';
  return reps[0][(comp ? Number(comp) : 1) - 1] ?? '';
}

export function unescape(value, d) {
  if (!value.includes(d.escape)) return value;
  const e = d.escape;
  const map = { F: d.field, S: d.component, T: d.subcomponent, R: d.repetition, E: e };
  return value.replace(new RegExp(`\\${e}([FSTRE])\\${e}`, 'g'), (_, k) => map[k]);
}

export function escape(value, d = DEFAULT_DELIMITERS) {
  const e = d.escape;
  return String(value)
    .replaceAll(e, `${e}E${e}`)
    .replaceAll(d.field, `${e}F${e}`)
    .replaceAll(d.component, `${e}S${e}`)
    .replaceAll(d.subcomponent, `${e}T${e}`)
    .replaceAll(d.repetition, `${e}R${e}`);
}

export const DEFAULT_DELIMITERS = { field: '|', component: '^', repetition: '~', escape: '\\', subcomponent: '&' };
