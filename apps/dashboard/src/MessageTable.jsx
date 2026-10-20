import { fmtTime, msBetween, fmtMs } from './api.js';

export const STATUS_LABEL = { received: 'Received', parsed: 'Parsed', mapped: 'Mapped', written: 'In FHIR', dlq: 'DLQ', retrying: 'Retrying' };

export default function MessageTable({ rows, selected, onSelect, retryingId, emptyHint }) {
  if (!rows.length) return <p className="empty">{emptyHint}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Patient</th>
            <th>MRN</th>
            <th>Status</th>
            <th className="num">End-to-end</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const status = r.control_id === retryingId && r.status !== 'written' ? 'retrying' : r.status;
            return (
              <tr key={r.control_id} className={selected === r.control_id ? 'sel' : ''} onClick={() => onSelect(r.control_id)}>
                <td className="mono">{fmtTime(r.received_at ?? r.updated_at)}</td>
                <td><span className="trigger">{r.trigger ?? '?'}</span></td>
                <td className="name">{r.patient ?? '—'}</td>
                <td className="mono">{r.mrn ?? '—'}</td>
                <td>
                  <span className={`status s-${status}`}>{STATUS_LABEL[status]}</span>
                  {r.replay_count > 0 && <span className="replayed" title="Replayed from the DLQ">↻{r.replay_count}</span>}
                </td>
                <td className="num mono">{status === 'written' ? fmtMs(msBetween(r.received_at, r.written_at)) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
