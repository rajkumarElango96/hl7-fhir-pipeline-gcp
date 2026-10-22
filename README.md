# HL7v2 ADT → FHIR R4 on Google Cloud

A proof of concept of a healthcare data pipeline: a regional analytics hub receives **HL7v2 ADT**
feeds (admit, update, discharge) from hospitals running a legacy EHR, lands them unchanged,
quarantines records that miss mandatory fields, converts the rest to **FHIR R4**, and reports
weekly patient flow.

**Small data, big-data shape.** The data is tiny on purpose (7 messages in the sample, at most
15 patients per generated batch, at most 50 rows on the dashboard). The components and their
wiring are the ones you would use at scale. All data is synthetic.

![Pipeline flow](docs/architecture/pipeline-flow.png)

Design notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

| Step | State |
|---|---|
| 1–2 Project, APIs, landing bucket | done by hand |
| 3 Raw load to BigQuery | done by hand (with a workaround, now replaced by `npm run prepare-raw`) |
| 4 Validation in BigQuery SQL | done by hand: found a generator bug (fixed, see findings) |
| 5–6 FHIR store + streaming to BigQuery | created; streaming **not yet verified with data** |
| 7 FHIR bundles to the store | pre-flight done; bundles not yet sent |
| 8 Analytics tables, 9 Looker Studio dashboard | not started |

## Repository

npm workspaces, plain Node.js JavaScript (ES modules, Node 22+). No GCP calls in the code yet:
everything is pure, tested logic that the manual run (and later Cloud Run jobs) uses.

| Package | What it does |
|---|---|
| `packages/synthetic` | The "legacy EHR": HL7 v2.5 ADT batch files (A01 → A08 → A03 per patient, plus malformed messages) |
| `packages/hl7` | Parser (CR, LF or CRLF), batch splitter (by MSH), structure-aware validator, ADT → canonical event |
| `packages/loader` | Batch file → one raw row per message with a SHA-256 hash, as NDJSON for `bq load` |
| `packages/fhir-mapping` | Canonical event → FHIR transaction Bundle, with the "newest message wins" guard |
| `packages/config` | Every GCP resource name, from environment variables or `.env` |

```bash
npm install
npm test                                     # 32 tests
cp .env.example .env                         # then fill in bucket and FHIR store
npm run generate -- --patients 2 --malformed 1 --seed 42 --out data/sample.hl7
npm run prepare-raw -- data/sample.hl7       # writes data/sample.ndjson and prints the bq load command
```

## Manual run

Environment used: project `hl7-fhir-pipeline`, region `asia-south1` for everything, BigQuery datasets
`raw`, `quality`, `analytics`, Healthcare dataset `hl7-fhir-pipeline-landing-fhir`, FHIR R4 store with
*update-create* and *referential integrity* enabled, streaming to `analytics` (Analytics V2 schema).
The Healthcare service agent needs **BigQuery Data Editor** and **BigQuery Job User** for streaming.

```bash
gcloud storage cp data/sample.hl7 gs://$LANDING_BUCKET/hospital=mixed/date=$(date +%F)/sample.hl7
npm run prepare-raw -- data/sample.hl7
bq load --source_format=NEWLINE_DELIMITED_JSON raw.messages data/sample.ndjson \
  msg_no:INTEGER,file_name:STRING,message:STRING,message_hash:STRING,loaded_at:TIMESTAMP
```

Expected after validation: **6 rows in `quality.validated`, 1 in `quality.rejected`** (missing PV1-19).

Mandatory rules (same in the BigQuery SQL and in `packages/hl7`):
- segments required by the message structure: MSH, EVN, PID, PV1 (for both `ADT_A01` and `ADT_A03`)
- MSH-7 timestamp, MSH-9 = ADT with trigger A01/A03/A08, MSH-10 control ID
- PID-3 with an MR identifier, PID-5.1 family name
- PV1-2 patient class, PV1-19 visit number

## Findings from the manual run

| # | Finding | Resolution |
|---|---|---|
| 1 | BigQuery does not keep file row order, so loading a file line by line loses which segment belongs to which message. | **Fixed in code.** `splitMessages()` splits on MSH itself; `npm run prepare-raw` writes one row per message, so no line numbering is needed. |
| 2 | HL7 separates segments with CR; the file needed converting before loading. | **Fixed.** The parser and splitter accept CR, LF and CRLF. Messages are stored with CR. |
| 3 | Validation rejected 3 messages instead of 1. The 2 extra were A08s with no PV1 segment, but A08 uses the `ADT_A01` structure, which requires PV1. | **Fixed.** The generator includes PV1 in A08 and declares `ADT_A03` for A03. The validator checks required segments per structure. Tests cover A08 without PV1, missing PV1-19 and missing PID. |
| 4 | City and state did not match (e.g. Belagavi, Uttarakhand). | **Fixed.** Each hospital draws patients from nearby cities with matching state and PIN prefix. |
| 5 | Resource names differed from the plan ("dataset not found", "datastore not found"). | **Fixed.** All names live in `packages/config` / `.env`; nothing is hard-coded. |
| 6 | Cloud Shell lost credentials after a restart. | Documented below. |
| 7 | Google's FHIR store does not support `_summary=count`. | Documented below. |

## Troubleshooting

- **401 `CREDENTIALS_MISSING` in Cloud Shell after a restart:** `gcloud auth print-access-token` comes back empty. Run `gcloud auth login` (and `gcloud config set project hl7-fhir-pipeline`).
- **401 when opening a FHIR URL in the browser:** expected. The API needs an OAuth bearer token; test with `curl -H "Authorization: Bearer $(gcloud auth print-access-token)" …` instead.
- **`_summary=count` returns "not supported yet":** count by searching and counting `entry` items (fine at this size), or count rows in the BigQuery `analytics` tables.
- **"dataset not found" / "datastore not found":** check `HEALTHCARE_DATASET` and `FHIR_STORE` in `.env` against the console, and that the region is `asia-south1`.

## FHIR mapping

| HL7 | FHIR |
|---|---|
| PID-3 (MR) | `Patient.identifier`, system `urn:syn:<hospital>:mrn` (e.g. `urn:syn:aiims:mrn`) |
| PID-3 (ABHA) | `Patient.identifier`, system `https://healthid.ndhm.gov.in` |
| PID-5, PID-7, PID-8, PID-11, PID-13 | `name`, `birthDate`, `gender`, `address`, `telecom` |
| PV1-19 | `Encounter.identifier`, system `urn:syn:<hospital>:visit` |
| PV1-2 (I/O/E) | `Encounter.class` IMP / AMB / EMER |
| PV1-44 / PV1-45 (fallback MSH-7) | `Encounter.period` start / end (+05:30) |
| A01 / A03 | `Encounter.status` in-progress / finished (A08 updates the Patient only) |
| MSH-7, MSH-10 | extensions `source-message-time`, `source-control-id` on every resource |

One transaction bundle per message. On an empty store, both resources are conditional PUTs on their
identifier (`|` encoded as `%7C`); the Encounter's `subject` points at the Patient's `urn:uuid` fullUrl,
which is a stable UUID derived from the identifier. Null and empty values are removed.

**Newest message wins.** A plain PUT always overwrites, so a late A01 would reopen a finished
encounter. `planBundle(event, current)` compares the incoming MSH-7 with the `source-message-time`
stored on the current resource:
- nothing stored → conditional PUT (create)
- stored is older → `PUT Patient/{id}` with `If-Match: W/"{versionId}"`
- stored is newer or the same message → skipped (reported in `skipped`)

## Known gaps

- The transformer that uses `planBundle` (search current resources by identifier, POST the bundle,
  retry on 409/412 version conflicts) is not built yet; step 7 is still manual.
- Validation rules exist twice: BigQuery SQL from the manual run and `packages/hl7`. The plan is one
  source: a rules table that generates the SQL, or the validator running as the Cloud Run job.
- Streaming from the FHIR store to BigQuery is configured but not verified with data.
- Pub/Sub ordering by MRN reduces out-of-order delivery but does not remove it; the MSH-7 guard is what
  guarantees correctness.

## Scale path

The same shape at real volume: Cloud Run jobs become Dataflow (Apache Beam) pipelines, the bucket and
BigQuery tables are partitioned by date and hospital, Cloud Workflows orchestrates the batch steps, and
Pub/Sub with a dead-letter topic sits in front of the quota-bound FHIR API.

The first version of this project (Kafka, MLLP, HAPI FHIR, React ops dashboard) is tagged `v0-kafka-fhir`.
