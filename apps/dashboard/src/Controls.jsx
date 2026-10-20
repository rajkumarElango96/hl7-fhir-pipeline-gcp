import { useState } from 'react';
import { api } from './api.js';

export default function Controls({ stats }) {
  const [patients, setPatients] = useState(5);
  const [malformed, setMalformed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const w = stats?.writer ?? {};

  const send = async () => {
    setBusy(true);
    setNote('');
    try {
      const r = await api('/api/simulate', { method: 'POST', body: { patients, malformed } });
      setNote(`Sent ${r.sent} messages, ${r.accepted} ACKed.`);
    } catch (err) {
      setNote(err.message);
    } finally {
      setBusy(false);
    }
  };

  const chaos = (body) => api('/api/chaos', { method: 'POST', body }).catch((err) => setNote(err.message));

  return (
    <section className="panel controls">
      <h2>Send synthetic traffic</h2>
      <div className="row">
        <label>
          Patients
          <input type="number" min="1" max="200" value={patients} onChange={(e) => setPatients(Number(e.target.value))} />
        </label>
        <label>
          Malformed
          <input type="number" min="0" max="50" value={malformed} onChange={(e) => setMalformed(Number(e.target.value))} />
        </label>
        <button className="primary" disabled={busy} onClick={send}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
      <p className="hint">Each patient sends admit (A01), update (A08) and discharge (A03). Malformed messages are ACKed by the gateway but rejected by the validator.</p>
      {note && <p className="note">{note}</p>}

      <h2>Chaos</h2>
      <Toggle
        label="Pause FHIR writer"
        hint="Writer stops consuming; a backlog builds on fhir.bundles."
        on={!!w.paused}
        disabled={!w.reachable}
        onChange={(v) => chaos({ paused: v })}
      />
      <Toggle
        label="Simulate HAPI outage"
        hint="Every write fails; the writer retries the same message with backoff so order is kept."
        on={!!w.fhirOutage}
        disabled={!w.reachable}
        onChange={(v) => chaos({ fhirOutage: v })}
      />
      {w.retrying && (
        <p className="note warn">
          Retrying <code>{w.retrying.controlId}</code> (attempt {w.retrying.attempt}): {w.retrying.error}
        </p>
      )}
    </section>
  );
}

function Toggle({ label, hint, on, disabled, onChange }) {
  return (
    <div className="toggle-row">
      <div>
        <div className="toggle-label">{label}</div>
        <div className="hint">{hint}</div>
      </div>
      <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
        <span />
      </button>
    </div>
  );
}
