# Architecture

The diagram is in the [README](../README.md#workflow-at-service-level).

## Flow (phase 1)
1. **Hospital EHR** (a separate system, outside GCP) uploads HL7v2 ADT batch files to the landing
   bucket with a service account that can only create objects there.
2. **Landing Bucket** (Cloud Storage, versioned) keeps every file unchanged, as
   `hospital=…/date=…/<file>.hl7`. It is the replay source.
3. **Eventarc** sees the new file and starts the **Orchestrator** (Cloud Workflows,
   `infra/workflow.yaml`). It passes only the file path and runs the jobs in order.
4. **Parser** (Cloud Run job) splits the file into messages and merges them unchanged into
   **Raw** (`raw.adt_messages`), keyed on a content hash.
5. **Validator** (Cloud Run job) checks that file's messages. Failures go to **Rejected** with a
   reason per rule; passes go to **Validated**.
6. **Transformer** (Cloud Run job) applies that file's validated messages oldest first to the
   **FHIR Store** (Cloud Healthcare API): conditional upserts on MRN and visit number, newest
   message (MSH-7) wins. Each outcome goes to `quality.fhir_results`.
7. The FHIR store streams into **Analytics** (BigQuery). **Looker Studio** reads it, plus the
   `quality.pipeline_health` view.

Phase 2: Pub/Sub ordered by MRN with a dead-letter topic between validator and transformer,
per-service accounts.

## Why these choices
| Decision | Reason |
|---|---|
| Hospital outside GCP, write-only upload | The source is an external system; it can drop files and nothing else. |
| Durable layer between every step (bucket → raw → validated → FHIR) | Any step can be re-run from the layer before it; failures stay local. |
| Orchestration for the batch steps | Few, ordered steps with one place that shows a file's progress. The jobs never call each other; only the sequence lives in the workflow. |
| Control separate from data | The workflow passes file paths; jobs read data from storage directly. |
| Validation separate from transformation | Different failure handling (quarantine vs retry) and independent reprocessing. |
| Idempotent at every step | Delivery is at-least-once: hash-keyed MERGE in BigQuery, conditional FHIR upserts, newest message wins, If-Match retries on concurrent writes. |
| FHIR store + BigQuery | FHIR store for interoperability; BigQuery for analytics, kept in sync by streaming. |
| Structured logs with MSH-10 | One correlation ID followed through every job. |

## PoC limits
Batches of hundreds of messages (each job sends one file's rows as a single BigQuery query
parameter); ≤ 50 rows on the dashboard. At real volume the jobs become Dataflow (Apache Beam)
pipelines, BigQuery writes go through load jobs into partitioned tables, and Pub/Sub buffers
writes to the quota-bound FHIR API. The shape stays the same.
