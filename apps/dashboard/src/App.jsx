import { useMemo, useState } from 'react';
import { useLive } from './api.js';
import FlowStrip from './FlowStrip.jsx';
import Controls from './Controls.jsx';
import MessageTable from './MessageTable.jsx';
import MessageDetail from './MessageDetail.jsx';

export default function App() {
  const { stats, rows, connected } = useLive();
  const [tab, setTab] = useState('all');
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');

  const dlqRows = useMemo(() => rows.filter((r) => r.status === 'dlq'), [rows]);
  const visible = useMemo(() => {
    const base = tab === 'dlq' ? dlqRows : rows;
    if (!query) return base;
    const q = query.toLowerCase();
    return base.filter((r) => [r.control_id, r.mrn, r.patient].some((v) => v?.toLowerCase().includes(q)));
  }, [tab, rows, dlqRows, query]);

  const retryingId = stats?.writer?.retrying?.controlId;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <svg viewBox="0 0 32 32" width="22" height="22"><path d="M5 16h6l2.5-7 5 14 2.5-7h6" stroke="currentColor" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <div>
            <h1>Pipeline Ops</h1>
            <p>HL7v2 ADT → Kafka → FHIR R4 · synthetic data only</p>
          </div>
        </div>
        <div className="pills">
          <Pill ok={connected} label={connected ? 'Live' : 'Reconnecting'} />
          <Pill ok={stats?.fhir?.up} label={`HAPI ${stats?.fhir?.up ? 'up' : 'down'}`} />
          <Pill
            ok={stats?.writer?.reachable && !stats.writer.paused && !stats.writer.fhirOutage}
            warn={stats?.writer?.paused || stats?.writer?.fhirOutage}
            label={writerLabel(stats?.writer)}
          />
        </div>
      </header>

      <FlowStrip stats={stats} />

      <div className="grid">
        <section className="panel list-panel">
          <div className="panel-head">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>
                Messages <span className="count">{rows.length}</span>
              </button>
              <button role="tab" aria-selected={tab === 'dlq'} className={tab === 'dlq' ? 'on' : ''} onClick={() => setTab('dlq')}>
                Dead-letter queue <span className={`count ${dlqRows.length ? 'bad' : ''}`}>{dlqRows.length}</span>
              </button>
            </div>
            <input className="search" placeholder="Search MRN, name, control ID" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <MessageTable rows={visible} selected={selected} onSelect={setSelected} retryingId={retryingId} emptyHint={tab === 'dlq' ? 'No messages in the DLQ. Send a few malformed ones from the controls.' : 'No messages yet. Send some synthetic patients.'} />
        </section>

        <aside className="side">
          <Controls stats={stats} />
          <MessageDetail id={selected} rows={rows} retryingId={retryingId} onReplayed={(id) => setSelected(id)} />
        </aside>
      </div>
    </div>
  );
}

function writerLabel(w) {
  if (!w) return 'Writer …';
  if (!w.reachable) return 'Writer offline';
  if (w.paused) return 'Writer paused';
  if (w.fhirOutage) return 'Outage injected';
  if (w.retrying) return 'Writer retrying';
  return 'Writer running';
}

function Pill({ ok, warn, label }) {
  return (
    <span className={`pill ${ok ? 'ok' : warn ? 'warn' : 'bad'}`}>
      <span className="dot" />
      {label}
    </span>
  );
}
