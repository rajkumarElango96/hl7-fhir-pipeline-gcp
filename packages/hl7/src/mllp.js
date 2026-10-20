// MLLP framing: <VT> message <FS><CR>
export const VT = 0x0b;
export const FS = 0x1c;
export const CR = 0x0d;

export function frame(message) {
  return Buffer.concat([Buffer.from([VT]), Buffer.from(message, 'utf8'), Buffer.from([FS, CR])]);
}

// Stateful decoder for a TCP stream. Call push(chunk); onMessage fires once per full frame.
export function createDecoder(onMessage) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const start = buffer.indexOf(VT);
        if (start === -1) {
          buffer = Buffer.alloc(0);
          return;
        }
        const end = buffer.indexOf(FS, start + 1);
        if (end === -1 || end + 1 >= buffer.length) {
          buffer = buffer.subarray(start);
          return;
        }
        onMessage(buffer.subarray(start + 1, end).toString('utf8'));
        buffer = buffer.subarray(end + (buffer[end + 1] === CR ? 2 : 1));
      }
    },
  };
}
