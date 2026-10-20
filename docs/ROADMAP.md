# Roadmap

| # | Milestone | Done when | Status |
|---|---|---|---|
| M0 | Context docs, repo skeleton, native infra | Kafka on :9092 and HAPI `/fhir/metadata` reachable | ✅ |
| M1 | `packages/hl7` parser + `packages/fhir-mapping` with unit tests | `npm test` passes on fixture messages | ✅ |
| M2 | End-to-end happy path: simulator → gateway → parser → mapper → writer → HAPI | After a burst, Patients and Encounters are in HAPI; replaying creates no duplicates | ✅ |
| M3 | Reliability: retry topics, DLQ, replay, out-of-order A08, backpressure, health endpoints | Killing HAPI mid-burst makes lag grow, then drain with zero duplicates; malformed messages land in the DLQ and replay cleanly | |
| M4 | ops-api + dashboard + chaos toggles | Live flow, HL7↔FHIR side-by-side view, DLQ replay and chaos toggles all work in the UI | |
| M5 | Polish + deploy | Prometheus metrics, README with diagram and demo GIF, hosted demo URL (host TBD) | |

## Known gaps after M2
- If HAPI is down, `fhir-writer` throws and retries the same message forever. There are no retry topics or DLQ yet (M3).
- A08 messages aren't checked against MSH-7, so a late A08 can overwrite newer data (M3).
- `hl7.dlq` exists, but nothing reads it yet (M3/M4).

## Future ideas (out of scope for now)
- More message types: ORU^R01 (lab results), SIU (scheduling), ORM/OML (orders)
- ABDM-style consent-based sharing of records (for Eka Care)
- Master Patient Index / record linkage across hospitals
