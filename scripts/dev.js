// Start all pipeline services + ops API + dashboard in one terminal with prefixed output.
// Ctrl+C stops them all. Dashboard: http://localhost:5173
import { spawn } from 'node:child_process';

const node = (file) => [process.execPath, [file]];
const processes = [
  ['mllp-gateway', ...node('services/mllp-gateway/index.js'), 36],
  ['parser-validator', ...node('services/parser-validator/index.js'), 33],
  ['fhir-mapper', ...node('services/fhir-mapper/index.js'), 35],
  ['fhir-writer', ...node('services/fhir-writer/index.js'), 32],
  ['ops-api', ...node('services/ops-api/index.js'), 34],
  ['dashboard', 'npm', ['run', 'dev', '-w', 'apps/dashboard', '--', '--clearScreen', 'false'], 37],
];

const children = processes.map(([name, cmd, args, color]) => {
  const child = spawn(cmd, args, { env: process.env });
  const prefix = `\x1b[${color}m${name.padEnd(16)}\x1b[0m│ `;
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
