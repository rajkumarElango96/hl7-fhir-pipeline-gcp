# Architecture

## Data flow
```
hl7-simulator ──MLLP/TCP──► mllp-gateway ──► [hl7.raw]
                                                 │
                              parser-validator ◄─┘──► [hl7.parsed] ──► fhir-mapper ──► [fhir.bundles]
                                     │                                                    │
                                     └──► [hl7.dlq]                       fhir-writer ◄───┘──► HAPI FHIR
                                                                             │   │
                                                         [fhir.retry.*] ◄────┘   └──► [fhir.events]
                                                                                          │
                                                         ops-api (+ SQLite)   ◄── all topics ──► dashboard (WebSocket)
```
The message backbone is **Apache Kafka** (Redpanda was the first plan, but it has no native macOS build).
Each box is its own container and Node process. Stages talk only through topics.

## Services
| Service | Responsibility |
|---|---|
| **hl7-simulator** | Generates synthetic ADT flows (admit → update → discharge) with faker `en_IN` (Indian names, ABHA-style IDs). Can inject malformed, duplicate and out-of-order messages on demand. |
| **mllp-gateway** | TCP MLLP listener. Publishes the raw message to `hl7.raw`, keyed by the PID-3 MRN. Replies with ACK `AA` **only after Kafka acknowledges the write**, so delivery is durable and at-least-once. Replies `AE`/`AR` on framing or ID errors. |
| **parser-validator** | Parses HL7v2 (segments, fields, components, repetitions, escape sequences) and checks the required segments for each trigger event. Valid → `hl7.parsed`; invalid → `hl7.dlq` with a reason. |
| **fhir-mapper** | Pure functions that turn ADT into a FHIR transaction Bundle (Patient, Encounter, and Location/Practitioner as needed). Uses business identifiers so writes can be conditional. |
| **fhir-writer** | Posts bundles to HAPI. Has a control port (:7104) for chaos: pause, simulated outage. Stays idempotent by using conditional PUT on identifiers. Retries with exponential backoff through `fhir.retry.*` topics, then sends to the DLQ. Pauses its consumer while HAPI is down (backpressure). Emits domain events (`patient.admitted`, `patient.discharged`, …) to `fhir.events`. |
| **ops-api** | Fastify + SQLite (`node:sqlite`) read model built from Kafka. Tracks each message's lifecycle by MSH-10. Lists and replays DLQ messages, reports consumer lag, and pushes a live WebSocket feed. |
| **dashboard** | React + Vite. Shows the live pipeline, a message detail view (raw HL7 next to the FHIR JSON) and DLQ replay. Has chaos toggles (stop the writer, take HAPI down) to demo recovery. |

## Topics
| Topic | Key | Producer → Consumer |
|---|---|---|
| `hl7.raw` | MRN | gateway → parser-validator |
| `hl7.parsed` | MRN | parser-validator → fhir-mapper |
| `fhir.bundles` | MRN | fhir-mapper → fhir-writer |
| `fhir.retry.5s`, `fhir.retry.30s`, `fhir.retry.5m` | MRN | fhir-writer → fhir-writer |
| `hl7.dlq` | MRN | any stage → ops-api (replay goes back to the stage's source topic) |
| `fhir.events` | MRN | fhir-writer → downstream consumers, ops-api |

Message headers carry `correlation-id` (MSH-10), `source-stage`, `attempt` and `received-at`.

## HL7 → FHIR mapping (ADT)
| Trigger | Effect in FHIR |
|---|---|
| A01 Admit | Upsert Patient (PID); create Encounter `in-progress` (PV1, keyed by PV1-19 visit number) |
| A03 Discharge | Set Encounter to `finished` with `period.end` |
| A08 Update | Update Patient demographics, but only if MSH-7 is newer than the last applied update |

## Distributed-systems principles (each one must be demoable)
1. **Decoupled stages:** each stage scales independently with consumer groups.
2. **Per-patient ordering:** partition key = MRN.
3. **At-least-once + idempotent consumers:** dedupe on MSH-10 and use conditional FHIR writes.
4. **Out-of-order handling:** compare MSH-7 timestamps before applying A08 updates.
5. **Retry topics → DLQ → manual replay.**
6. **Backpressure:** pause and resume consumers when downstream is unhealthy.
7. **Observability:** correlation ID on every hop, pino logs, Prometheus metrics, consumer lag.
8. **Graceful shutdown** plus `/health` and `/ready` endpoints.

## Canonical ADT event
The parser converts HL7 into a plain JSON event (`eventType`, `controlId`, `messageTime`,
`patient{mrn, abha, name, birthDate, gender, address, phone}`, `visit{visitNumber, class,
location, attending, admitTime, dischargeTime}`). Downstream stages never see pipes and carets,
so a new source format would only need a new parser.

## Infrastructure (native, no Docker)
- Kafka 4 from Homebrew in KRaft mode (no ZooKeeper), listening on `localhost:9092`
- HAPI FHIR JPA starter (`java -jar ROOT.war`, H2 database) at `localhost:8080/fhir`
- Each service is a plain Node process, started together by `scripts/dev.js`
- Config comes from env vars: `KAFKA_BROKERS`, `FHIR_BASE_URL`, `MLLP_HOST`, `MLLP_PORT`

Hosting is decided later. Because config is all env vars, containerizing is a later, additive step.
