// Builds pipeline-flow.svg / pipeline-flow.png: the simple box-and-arrow view.
// Usage: node docs/architecture/build-simple-diagram.mjs   (needs Google Chrome)
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const W = 1700;
const H = 960;
const OUT = fileURLToPath(new URL('.', import.meta.url));
const INK = '#2b2f36';
const SUB = '#6b7280';
const p = [];
const add = (s) => p.push(s);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function labels(cx, cy, name, service) {
  add(`<text x="${cx}" y="${cy - 2}" font-size="19" fill="${INK}" text-anchor="middle">${esc(name)}</text>`);
  if (service) add(`<text x="${cx}" y="${cy + 21}" font-size="13" fill="${SUB}" text-anchor="middle">${esc(service)}</text>`);
}

// Rectangle component, centred on (cx, cy).
function box(cx, cy, name, service, w = 190, h = 90) {
  add(`<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="5" fill="#fff" stroke="${INK}" stroke-width="1.6"/>`);
  labels(cx, cy, name, service);
}

// Vertical cylinder = data store.
function store(cx, cy, name, service, w = 170, h = 110) {
  const rx = w / 2;
  const ry = 13;
  const top = cy - h / 2;
  const bot = cy + h / 2;
  add(`<path d="M${cx - rx},${top} V${bot} A${rx},${ry} 0 0 0 ${cx + rx},${bot} V${top}" fill="#fff" stroke="${INK}" stroke-width="1.6"/>`);
  add(`<ellipse cx="${cx}" cy="${top}" rx="${rx}" ry="${ry}" fill="#fff" stroke="${INK}" stroke-width="1.6"/>`);
  labels(cx, cy + 8, name, service);
}

// Horizontal cylinder = queue.
function queue(cx, cy, name, service, w = 230, h = 80) {
  const rx = 18;
  const ry = h / 2;
  const l = cx - w / 2;
  const r = cx + w / 2;
  add(`<path d="M${r},${cy - ry} H${l} A${rx},${ry} 0 0 0 ${l},${cy + ry} H${r}" fill="#fff" stroke="${INK}" stroke-width="1.6"/>`);
  add(`<ellipse cx="${r}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#fff" stroke="${INK}" stroke-width="1.6"/>`);
  labels(cx - 8, cy, name, service);
}

function arrow(d, { dashed = false, label, lx, ly, anchor = 'start' } = {}) {
  add(`<path d="${d}" fill="none" stroke="${INK}" stroke-width="1.4" ${dashed ? 'stroke-dasharray="6 5"' : ''} marker-end="url(#arrow)"/>`);
  if (label) add(`<text x="${lx}" y="${ly}" font-size="13" fill="${SUB}" font-style="italic" text-anchor="${anchor}">${esc(label)}</text>`);
}

// Background grid, like a whiteboard tool.
add(`<defs>
  <pattern id="g-small" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20,0 H0 V20" fill="none" stroke="#efefef" stroke-width="1"/></pattern>
  <pattern id="g-big" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="url(#g-small)"/><path d="M100,0 H0 V100" fill="none" stroke="#e2e2e2" stroke-width="1"/></pattern>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${INK}"/></marker>
</defs>`);
add(`<rect width="${W}" height="${H}" fill="#fff"/><rect width="${W}" height="${H}" fill="url(#g-big)"/>`);
add(`<text x="40" y="52" font-size="22" font-weight="700" fill="${INK}">HL7v2 → FHIR pipeline (GCP)</text>`);

// Row 1: control
box(150, 160, 'Scheduler', 'Cloud Scheduler');
box(840, 160, 'Orchestrator', 'Cloud Workflows', 230);

// Row 2: land, load, validate
box(150, 400, 'Hospital EHR', 'simulator · Cloud Run job');
store(380, 400, 'Landing Bucket', 'Cloud Storage');
box(610, 400, 'Loader', 'Cloud Run job');
store(840, 400, 'Raw', 'BigQuery');
box(1070, 400, 'Validator', 'Cloud Run job');
store(1300, 400, 'Validated', 'BigQuery');

// Row 3: split
store(1070, 630, 'Rejected', 'BigQuery');
queue(1300, 630, 'Pub/Sub', 'ordered by MRN');
queue(1560, 630, 'Dead Letter', 'Pub/Sub', 190);

// Row 4: serve and show
box(1300, 860, 'FHIR Transformer', 'Cloud Run service', 220);
store(1070, 860, 'FHIR Store', 'Healthcare API');
store(840, 860, 'Analytics', 'BigQuery');
box(610, 860, 'Dashboard', 'Looker Studio + D3');

// Arrows
arrow('M150,205 V351');                                                     // scheduler -> EHR
arrow('M245,400 H291', { label: 'HL7 file', lx: 268, ly: 390, anchor: 'middle' });
arrow('M380,343 V160 H721', { label: 'file landed', lx: 395, ly: 250 });     // bucket -> orchestrator
arrow('M465,400 H511');                                                      // bucket -> loader
arrow('M780,205 V270 H610 V351', { dashed: true, label: 'run', lx: 620, ly: 262 });
arrow('M900,205 V270 H1070 V351', { dashed: true, label: 'run', lx: 1080, ly: 262 });
arrow('M705,400 H751');                                                      // loader -> raw
arrow('M925,400 H971');                                                      // raw -> validator
arrow('M1165,400 H1211', { label: 'valid', lx: 1188, ly: 390, anchor: 'middle' });
arrow('M1070,445 V561', { label: 'invalid', lx: 1080, ly: 515 });
arrow('M1300,463 V586', { label: 'publish', lx: 1310, ly: 530 });
arrow('M1433,630 H1461', { dashed: true });                                  // pubsub -> DLQ
arrow('M1300,670 V811', { label: 'push', lx: 1310, ly: 745 });
arrow('M1190,860 H1159', {});                                                // transformer -> FHIR store
arrow('M985,860 H929', { label: 'stream', lx: 957, ly: 850, anchor: 'middle' });
arrow('M755,860 H709');                                                      // analytics -> dashboard

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
${p.join('\n')}
</svg>
`;
const svgPath = `${OUT}pipeline-flow.svg`;
const pngPath = `${OUT}pipeline-flow.png`;
writeFileSync(svgPath, svg);
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
execFileSync(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', `--window-size=${W},${H}`,
  '--force-device-scale-factor=2', `--screenshot=${pngPath}`, `file://${svgPath}`], { stdio: 'ignore' });
console.log(`wrote ${svgPath}\nwrote ${pngPath}`);
