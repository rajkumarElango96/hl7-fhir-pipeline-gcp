// Start all pipeline services in one terminal with prefixed output. Ctrl+C stops them all.
import { spawn } from 'node:child_process';

const services = ['mllp-gateway', 'parser-validator', 'fhir-mapper', 'fhir-writer'];
const colors = [36, 33, 35, 32];

const children = services.map((name, i) => {
  const child = spawn(process.execPath, [`services/${name}/index.js`], { env: process.env });
  const prefix = `\x1b[${colors[i]}m${name.padEnd(16)}\x1b[0m│ `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${prefix}exited (${code})`));
  return child;
});

const stop = () => children.forEach((c) => c.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
