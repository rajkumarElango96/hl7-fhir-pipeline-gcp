// FHIR transformer service logic: one validated row -> one FHIR transaction.
// With a client: read current resources, apply the newest-message-wins plan, send, and retry
// on 409/412 (another writer changed the resource between the read and the write).
// Without a client (dry run): plan against an empty store.
import { parseMessage } from '@pipeline/hl7';
import { toAdtEvent } from './canonical.js';
import { planBundle, identifierSystem } from './mapping.js';

const MAX_ATTEMPTS = 3;

export async function transformRow(row, client) {
  const event = toAdtEvent(parseMessage(row.message));
  if (!client) {
    const { bundle } = planBundle(event);
    return { controlId: event.controlId, event, bundle, skipped: [], result: null };
  }

  for (let attempt = 1; ; attempt++) {
    const current = {
      patient: await client.findByIdentifier('Patient', identifierSystem(event.sendingFacility, 'mrn'), event.patient.mrn),
      encounter: event.eventType === 'A08' ? undefined
        : await client.findByIdentifier('Encounter', identifierSystem(event.sendingFacility, 'visit'), event.visit.visitNumber),
    };
    const { bundle, skipped } = planBundle(event, current);
    if (bundle.entry.length === 0) return { controlId: event.controlId, event, bundle, skipped, result: null };
    try {
      const result = await client.executeBundle(bundle);
      return { controlId: event.controlId, event, bundle, skipped, result };
    } catch (err) {
      const conflict = err.status === 409 || err.status === 412;
      if (!conflict || attempt >= MAX_ATTEMPTS) throw err;
    }
  }
}
