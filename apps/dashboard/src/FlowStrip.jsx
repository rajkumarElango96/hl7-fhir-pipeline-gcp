import { fmtMs } from './api.js';

// The pipeline as a row of stages. The number between two stages is the
// consumer lag: messages waiting on that topic for the next stage.
export default function FlowStrip({ stats }) {
  const c = stats?.counts ?? {};
  const lag = stats?.lag ?? {};
  const w = stats?.writer ?? {};

  const stages = [
    { key: 'gateway', name: 'MLLP gateway', sub: 'TCP :2575', value: c.received, unit: 'received' },
    { key: 'parser', name: 'Parser / validator', sub: 'hl7.raw', value: c.parsed, unit: 'parsed', lag: lag['parser-validator'] },
    { key: 'mapper', name: 'FHIR mapper', sub: 'hl7.parsed', value: c.mapped, unit: 'mapped', lag: lag['fhir-mapper'] },
    {
      key: 'writer', name: 'FHIR writer', sub: 'fhir.bundles', value: c.written, unit: 'written', lag: lag['fhir-writer'],
      state: !w.reachable ? 'bad' : w.paused || w.fhirOutage || w.retrying ? 'warn' : 'ok',
      note: !w.reachable ? 'offline' : w.paused ? 'paused' : w.retrying ? `retry #${w.retrying.attempt}` : null,
    },
    { key: 'hapi', name: 'HAPI FHIR', sub: 'R4 store', value: stats ? (stats.fhir.up ? 'Up' : 'Down') : '…', state: stats?.fhir?.up ? 'ok' : 'bad' },
  ];

  return (
    <section className="flow" aria-label="Pipeline stages">
      {stages.map((s, i) => (
        <div className="flow-item" key={s.key}>
          {i > 0 && <Arrow lag={s.lag ?? (s.key === 'hapi' ? null : 0)} />}
          <div className={`stage ${s.state ?? ''}`}>
            <div className="stage-name">{s.name}</div>
            <div className="stage-sub">{s.sub}</div>
            <div className="stage-value">{s.value ?? 0}</div>
            <div className="stage-unit">{s.note ?? s.unit ?? ''}</div>
          </div>
        </div>
      ))}
      <div className="flow-meta">
        <div className={`dlq-box ${c.dlq ? 'bad' : ''}`}>
          <span>DLQ</span>
          <strong>{c.dlq ?? 0}</strong>
        </div>
        <div className="latency">
          <span>Avg end-to-end</span>
          <strong>{fmtMs(c.avg_latency_ms)}</strong>
        </div>
      </div>
    </section>
  );
}

function Arrow({ lag }) {
  const backlog = lag > 0;
  return (
    <div className={`arrow ${backlog ? 'backlog' : ''}`} title="Consumer lag (messages waiting)">
      <span className="lag">{lag == null ? '' : backlog ? `${lag} waiting` : '0'}</span>
      <svg viewBox="0 0 40 10" preserveAspectRatio="none"><path d="M0 5h36M31 1l5 4-5 4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
    </div>
  );
}
