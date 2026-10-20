// Readable HL7: one segment per line, separators dimmed, and each field
// labelled on hover with its HL7 position (e.g. PID-5).
export default function Hl7View({ raw }) {
  if (!raw) return <p className="hint">No raw message.</p>;
  const segments = raw.split(/\r\n|\r|\n/).filter(Boolean);
  return (
    <pre className="hl7 mono">
      {segments.map((seg, i) => {
        const fields = seg.split('|');
        const name = fields[0];
        return (
          <div key={i} className="seg">
            <span className="seg-name">{name}</span>
            {fields.slice(1).map((f, j) => {
              // MSH-1 is the separator itself, so MSH fields start one later.
              const pos = name === 'MSH' ? j + 2 : j + 1;
              return (
                <span key={j}>
                  <span className="sep">|</span>
                  {f && <span className="field" title={`${name}-${pos}`}>{f.split('^').map((c, k) => (k ? [<span key={k} className="sep">^</span>, c] : c))}</span>}
                </span>
              );
            })}
          </div>
        );
      })}
    </pre>
  );
}
