-- Pipeline health: where every landed file is, layer by layer.
-- Reconciled = every raw message ended up either validated or rejected.
-- Run once: bq query --use_legacy_sql=false < infra/views.sql
CREATE OR REPLACE VIEW quality.pipeline_health AS
WITH raw AS (
  SELECT file_name, COUNT(*) AS raw_messages, MIN(loaded_at) AS loaded_at
  FROM raw.adt_messages GROUP BY file_name
),
validated AS (
  SELECT file_name, COUNT(*) AS validated FROM quality.adt_validated GROUP BY file_name
),
rejected AS (
  SELECT file_name, COUNT(*) AS rejected FROM quality.adt_rejected GROUP BY file_name
),
fhir AS (
  SELECT file_name,
         COUNTIF(status = 'sent')    AS fhir_sent,
         COUNTIF(status = 'skipped') AS fhir_skipped,
         COUNTIF(status = 'failed')  AS fhir_failed
  FROM quality.fhir_results GROUP BY file_name
)
SELECT
  raw.file_name,
  -- hospital=<id>/ folder if present, otherwise the file-name prefix (<id>_<timestamp>.hl7)
  COALESCE(REGEXP_EXTRACT(raw.file_name, r'hospital=([^/]+)'),
           REGEXP_EXTRACT(raw.file_name, r'([^/]+)_\d{8}T\d{6}\.hl7$')) AS hospital,
  raw.loaded_at,
  raw.raw_messages,
  IFNULL(validated.validated, 0)  AS validated,
  IFNULL(rejected.rejected, 0)    AS rejected,
  IFNULL(fhir.fhir_sent, 0)       AS fhir_sent,
  IFNULL(fhir.fhir_skipped, 0)    AS fhir_skipped,
  IFNULL(fhir.fhir_failed, 0)     AS fhir_failed,
  raw.raw_messages = IFNULL(validated.validated, 0) + IFNULL(rejected.rejected, 0) AS reconciled
FROM raw
LEFT JOIN validated USING (file_name)
LEFT JOIN rejected  USING (file_name)
LEFT JOIN fhir      USING (file_name);

-- Patient-flow views over the streamed analytics tables come next, once their
-- schema has been checked against real data.

-- ---------------------------------------------------------------------------
-- Patient flow, read from the FHIR store's streaming export (analytics dataset).
-- Streaming appends a row for every version of a resource, so keep the latest
-- version of each Encounter. Times are cast through STRING so the view works
-- whether the export stores them as STRING or TIMESTAMP.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW analytics.encounters_current AS
WITH latest AS (
  SELECT *
  FROM analytics.Encounter
  WHERE TRUE
  QUALIFY ROW_NUMBER() OVER (PARTITION BY id ORDER BY CAST(meta.lastUpdated AS STRING) DESC) = 1
)
SELECT
  id                                                                   AS encounter_id,
  identifier[SAFE_OFFSET(0)].value                                     AS visit_number,
  UPPER(REGEXP_EXTRACT(identifier[SAFE_OFFSET(0)].system, r'urn:syn:([^:]+):')) AS hospital,
  status,
  class.code                                                           AS class_code,
  CASE class.code WHEN 'IMP' THEN 'Inpatient' WHEN 'EMER' THEN 'Emergency'
                  WHEN 'AMB' THEN 'Outpatient' ELSE class.code END     AS class,
  serviceType.coding[SAFE_OFFSET(0)].code                              AS service,
  SAFE_CAST(CAST(period.start AS STRING) AS TIMESTAMP)                 AS admit_time,
  SAFE_CAST(CAST(period.`end` AS STRING) AS TIMESTAMP)                 AS discharge_time
FROM latest;

-- One row per day, hospital and class: admissions and discharges (IST dates)
CREATE OR REPLACE VIEW analytics.daily_flow AS
WITH events AS (
  SELECT DATE(admit_time, 'Asia/Kolkata') AS day, hospital, class, 1 AS admissions, 0 AS discharges
  FROM analytics.encounters_current WHERE admit_time IS NOT NULL
  UNION ALL
  SELECT DATE(discharge_time, 'Asia/Kolkata'), hospital, class, 0, 1
  FROM analytics.encounters_current WHERE discharge_time IS NOT NULL
)
SELECT day, hospital, class, SUM(admissions) AS admissions, SUM(discharges) AS discharges
FROM events
GROUP BY day, hospital, class;

-- ---------------------------------------------------------------------------
-- Message journey: one row per HL7 message and what happened to it, end to end.
-- Filter by control_id (MSH-10) or MRN in Looker Studio to follow one message.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW quality.message_journey AS
SELECT
  raw.loaded_at,
  raw.file_name,
  COALESCE(v.control_id, r.control_id)        AS control_id,
  COALESCE(v.trigger_event, r.trigger_event)  AS trigger_event,
  COALESCE(v.mrn, r.mrn)                      AS mrn,
  v.message_time,
  CASE
    WHEN r.message_hash IS NOT NULL THEN 'rejected'
    WHEN f.status IS NOT NULL        THEN CONCAT('fhir_', f.status)
    WHEN v.message_hash IS NOT NULL  THEN 'validated'
    ELSE 'parsed'
  END                                         AS outcome,
  COALESCE(r.reason, f.detail)                AS detail,
  REPLACE(raw.message, '\r', '\n')            AS hl7
FROM raw.adt_messages raw
LEFT JOIN quality.adt_validated v USING (message_hash)
LEFT JOIN quality.adt_rejected  r USING (message_hash)
LEFT JOIN quality.fhir_results  f USING (message_hash);
