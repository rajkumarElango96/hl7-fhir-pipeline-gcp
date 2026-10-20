# Roadmap

| # | Milestone | Done when | Status |
|---|---|---|---|
| M0 | Context docs, repo skeleton, native infra | Kafka on :9092 and HAPI `/fhir/metadata` reachable | ✅ |
| M1 | `packages/hl7` parser + `packages/fhir-mapping` with unit tests | `npm test` passes on fixture messages | ✅ |
| M2 | End-to-end happy path: simulator → gateway → parser → mapper → writer → HAPI | After a burst, Patients and Encounters are in HAPI; replaying creates no duplicates | ✅ |
| M3 | Reliability: retry topics, write DLQ, out-of-order A08, health endpoints | Killing HAPI mid-burst makes lag grow, then drain with zero duplicates; failed writes dead-letter after N tries | ⏭️ skipped for now |
| M4 | ops-api + dashboard + chaos toggles | Live flow, HL7↔FHIR side-by-side view, DLQ replay and chaos toggles all work in the UI | ✅ |
| M5 | Polish + deploy | Prometheus metrics, README with diagram and demo GIF, hosted demo URL (host TBD) | |

## What M4 added
- **ops-api** (`services/ops-api`): a consumer group that reads every topic and builds a per-message timeline in SQLite, keyed by MSH-10. A message's status comes from the stage timestamps it has collected, so it's correct whatever order topics are read in. Deleting `.local/ops.db` and resetting the `ops-api` group rebuilds it from Kafka.
- REST: `/api/stats` (stage counts, consumer lag per group, writer + HAPI health), `/api/messages`, `/api/messages/:id`, `POST /api/messages/:id/replay` (optionally with corrected HL7), `POST /api/simulate`, `POST /api/chaos`, `/api/fhir/:type/:id`. Live updates on `/ws`.
- **fhir-writer** control port: pause/resume the consumer, and inject a HAPI outage. On failure it retries in place with backoff (0.5 s → 5 s), so order is kept and lag builds visibly.
- **Simulator** is now a module with a `malformed` option (missing PV1-19, no MR identifier, unsupported trigger).
- **Dashboard** (`apps/dashboard`): flow strip with lag between stages, message table, detail panel (timeline, HL7 ↔ FHIR, canonical event, resources as stored in HAPI), DLQ editor with "replay as is / replay edited", chaos toggles.

## Known gaps (M3 work)
- A write that HAPI rejects permanently (e.g. a 4xx) is retried forever and blocks its partition. It should go to a write DLQ after N attempts.
- In-place retry holds the consumer. An outage longer than about 5 minutes can exceed `max.poll.interval.ms` and trigger a rebalance. Retry topics would fix this.
- A08 messages aren't checked against MSH-7, so a late A08 can overwrite newer data.
- Lag is computed from committed offsets, so it can lag reality by the auto-commit interval (about 5 s).

## Future ideas (out of scope for now)
- More message types: ORU^R01 (lab results), SIU (scheduling), ORM/OML (orders)
- ABDM-style consent-based sharing of records (for Eka Care)
- Master Patient Index / record linkage across hospitals
