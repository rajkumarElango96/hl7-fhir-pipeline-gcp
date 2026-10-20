import { useEffect, useState } from 'react';
import { api, fmtTime, msBetween, fmtMs } from './api.js';
import Hl7View from './Hl7View.jsx';
import { STATUS_LABEL } from './MessageTable.jsx';

const VIEWS = [
  { key: 'compare', label: 'HL7 ↔ FHIR' },
  { key: 'canonical', label: 'Canonical event' },
  { key: 'stored', label: 'Stored in HAPI' },
];

export default function MessageDetail({ id, rows, retryingId, onReplayed }) {
  const [detail, setDetail] = useState(null);
  const [view, setView] = useState('compare');
  const summary = rows.find((r) => r.control_id === id);
  // Refetch whenever the live row moves to a new stage.
  const version = summary ? `${summary.status}-${summary.updated_at}` : '';

  useEffect(() => {
    if (!id) return;
    let live = true;
    api(`/api/messages/${encodeURIComponent(id)}`).then((d) => live && setDetail(d)).catch(() => live && setDetail(null));
    return () => { live = false; };
  }, [id, version]);

  if (!id) {
    return (
      <section className="panel detail placeholder">
        <p>Select a message to see its journey through the pipeline, the original HL7 next to the FHIR it became, and what HAPI stored.</p>
      </section>
    );
  }
  if (!detail) return <section className="panel detail"><p className="hint">Loading…</p></section>;

  const status = detail.control_id === retryingId && detail.status !== 'written' ? 'retrying' : detail.status;

  return (
    <section className="panel detail">
      <div className="detail-head">
        <div>
          <h2>{detail.patient ?? 'Unknown patient'} <span className="trigger">{detail.trigger}</span></h2>
          <p className="mono sub">{detail.control_id} · {detail.mrn ?? 'no MRN'} · {detail.facility ?? ''}</p>
        </div>
        <span className={`status s-${status}`}>{STATUS_LABEL[status]}</span>
      </div>

      <Timeline d={detail} />

      {detail.status === 'dlq' ? (
        <DlqEditor detail={detail} onReplayed={onReplayed} />
      ) : (
        <>
          <div className="tabs small" role="tablist">
            {VIEWS.map((v) => (
              <button key={v.key} role="tab" aria-selected={view === v.key} className={view === v.key ? 'on' : ''} onClick={() => setView(v.key)}>
                {v.label}
              </button>
            ))}
          </div>
          {view === 'compare' && (
            <div className="compare">
              <div>
                <h3>HL7v2 in</h3>
                <Hl7View raw={detail.raw_hl7} />
              </div>
              <div>
                <h3>FHIR transaction out</h3>
                {detail.bundle ? <Json value={detail.bundle} /> : <p className="hint">Not mapped yet.</p>}
              </div>
            </div>
          )}
          {view === 'canonical' && (detail.canonical ? <Json value={detail.canonical} /> : <p className="hint">Not parsed yet.</p>)}
          {view === 'stored' && <Stored result={detail.fhir_result} />}
        </>
      )}
    </section>
  );
}

function Timeline({ d }) {
  const steps = [
    ['Received', d.received_at],
    ['Parsed', d.parsed_at],
    ['Mapped', d.mapped_at],
    ['Written', d.written_at],
  ];
  if (d.status === 'dlq') steps.splice(1, 3, ['Dead-lettered', d.dlq_at]);
  return (
    <ol className="timeline">
      {steps.map(([label, at], i) => (
        <li key={label} className={at ? 'done' : ''}>
          <span className="t-label">{label}</span>
          <span className="t-time mono">{at ? fmtTime(at) : '—'}</span>
          {i > 0 && at && <span className="t-delta mono">+{fmtMs(msBetween(steps[i - 1][1], at))}</span>}
        </li>
      ))}
    </ol>
  );
}

function DlqEditor({ detail, onReplayed }) {
  const [raw, setRaw] = useState(detail.raw_hl7.replace(/\r/g, '\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const replay = async (edited) => {
    setBusy(true);
    setError('');
    try {
      const r = await api(`/api/messages/${encodeURIComponent(detail.control_id)}/replay`, {
        method: 'POST',
        body: edited ? { raw } : {},
      });
      onReplayed(r.controlId);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dlq">
      <div className="reason">
        <strong>Why it was rejected</strong>
        <span>{detail.dlq_reason}</span>
      </div>
      <label className="editor-label" htmlFor="hl7-edit">Fix the message, then replay it into <code>hl7.raw</code></label>
      <textarea id="hl7-edit" className="mono" spellCheck={false} value={raw} onChange={(e) => setRaw(e.target.value)} rows={8} />
      {error && <p className="note bad">{error}</p>}
      <div className="row end">
        <button disabled={busy} onClick={() => replay(false)}>Replay as is</button>
        <button className="primary" disabled={busy} onClick={() => replay(true)}>Replay edited</button>
      </div>
    </div>
  );
}

function Stored({ result }) {
  const [resources, setResources] = useState(null);
  useEffect(() => {
    if (!result?.resources) return;
    let live = true;
    Promise.all(
      result.resources.map((r) => {
        const [type, id] = r.location.split('/');
        return api(`/api/fhir/${type}/${id}`).catch((err) => ({ error: err.message, ref: `${type}/${id}` }));
      }),
    ).then((list) => live && setResources(list));
    return () => { live = false; };
  }, [result]);

  if (!result) return <p className="hint">Not written to HAPI yet.</p>;
  return (
    <div>
      <p className="hint">
        Domain event <code>{result.type}</code> · {result.resources.map((r) => `${r.status} ${r.location}`).join(' · ')}
      </p>
      <p className="hint">Below is the current version of each resource in HAPI (later messages may have updated it).</p>
      {resources ? resources.map((r, i) => <Json key={i} value={r} />) : <p className="hint">Loading…</p>}
    </div>
  );
}

function Json({ value }) {
  return <pre className="json mono">{JSON.stringify(value, null, 2)}</pre>;
}
