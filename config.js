// Every setting in one place. Values come from environment variables
// (set on the Cloud Run jobs), or from a local .env file when present.
const fs   = require('node:fs')
const path = require('node:path')

const envFile = path.join(__dirname, '.env')
if (fs.existsSync(envFile)) process.loadEnvFile(envFile)

const env = (name, fallback) => process.env[name] || fallback

const GCP_PROJECT        = env('GCP_PROJECT')
const GCP_REGION         = env('GCP_REGION', 'asia-south1')
const HEALTHCARE_DATASET = env('HEALTHCARE_DATASET')
const FHIR_STORE         = env('FHIR_STORE')

const config = {
  GCP_PROJECT,
  GCP_REGION,
  LANDING_BUCKET:     env('LANDING_BUCKET'),

  // BigQuery: one durable layer per step
  BQ_RAW_DATASET:     env('BQ_RAW_DATASET', 'raw'),
  BQ_QUALITY_DATASET: env('BQ_QUALITY_DATASET', 'quality'),
  RAW_TABLE:          env('RAW_TABLE', 'adt_messages'),
  VALIDATED_TABLE:    env('VALIDATED_TABLE', 'adt_validated'),
  REJECTED_TABLE:     env('REJECTED_TABLE', 'adt_rejected'),
  FHIR_RESULTS_TABLE: env('FHIR_RESULTS_TABLE', 'fhir_results'),

  // Cloud Healthcare API
  HEALTHCARE_DATASET,
  FHIR_STORE,
  FHIR_BASE_URL: env('FHIR_BASE_URL',
    `https://healthcare.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${GCP_REGION}`
    + `/datasets/${HEALTHCARE_DATASET}/fhirStores/${FHIR_STORE}/fhir`),

  // Set by the workflow on each job run: the landed object, e.g. hospital=SYNH-CHN/date=2026-10-24/x.hl7
  INPUT_FILE: env('INPUT_FILE'),

  // HL7 timestamps from the hospitals carry Indian time
  HL7_TZ_OFFSET: env('HL7_TZ_OFFSET', '+05:30'),
}

// Fail fast with one clear message, e.g. requireConfig('LANDING_BUCKET', 'INPUT_FILE')
function requireConfig(...names) {
  const missing = names.filter(name => !config[name])
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')} (see .env.example)`)
}

module.exports = { ...config, requireConfig }
