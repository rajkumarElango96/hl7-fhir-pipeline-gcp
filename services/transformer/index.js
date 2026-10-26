// FHIR transformer (Cloud Run job): validated messages of one file -> FHIR store.
// Messages are applied oldest first. Newest-message-wins makes re-runs and late arrivals
// safe, and each outcome is recorded in quality.fhir_results for the pipeline-health view.
const { tableRef, ensureTable, queryRows, mergeRows } = require('../../lib/bigquery')
const { findByIdentifier, executeBundle }             = require('../../lib/fhir')
const { parseMessage }                                = require('../../lib/hl7')
const { toAdtEvent }                                  = require('./canonical')
const { planBundle, identifierSystem }                = require('./mapping')
const createLogger                                    = require('../../lib/log')
const {
  INPUT_FILE, BQ_QUALITY_DATASET, VALIDATED_TABLE, FHIR_RESULTS_TABLE, requireConfig,
} = require('../../config')

const log = createLogger('transformer')

const MAX_ATTEMPTS = 3 // for 409/412: another writer changed the resource between read and write

const RESULTS_SCHEMA = [
  { name: 'message_hash',  type: 'STRING' },
  { name: 'file_name',     type: 'STRING' },
  { name: 'control_id',    type: 'STRING' },
  { name: 'trigger_event', type: 'STRING' },
  { name: 'mrn',           type: 'STRING' },
  { name: 'status',        type: 'STRING' },   // sent | skipped | failed
  { name: 'detail',        type: 'STRING' },
  { name: 'processed_at',  type: 'TIMESTAMP' },
]

// Current Patient (and Encounter, unless A08) as stored, looked up by business identifier
async function currentResources(event) {
  const patient = await findByIdentifier('Patient', identifierSystem(event.sendingFacility, 'mrn'), event.patient.mrn)
  const encounter = event.eventType === 'A08'
    ? undefined
    : await findByIdentifier('Encounter', identifierSystem(event.sendingFacility, 'visit'), event.visit.visitNumber)
  return { patient, encounter }
}

// One message -> one FHIR transaction. Returns { status, detail }.
async function transformMessage(message) {
  const event = toAdtEvent(parseMessage(message))

  for (let attempt = 1; ; attempt++) {
    const { bundle, skipped } = planBundle(event, await currentResources(event))
    if (!bundle.entry.length) return { status: 'skipped', detail: `stored data is newer: ${skipped.join(', ')}` }

    try {
      const result = await executeBundle(bundle)
      const writes = (result.entry ?? []).map(e => `${e.response?.status} ${e.response?.location}`)
      return { status: 'sent', detail: [...writes, ...skipped.map(s => `skipped ${s}`)].join(' | ') }
    } catch (err) {
      const conflict = err.status === 409 || err.status === 412
      if (!conflict || attempt >= MAX_ATTEMPTS) throw err
      log.warn('Write conflict, retrying', { controlId: event.controlId, attempt })
    }
  }
}

async function main() {
  requireConfig('GCP_PROJECT', 'HEALTHCARE_DATASET', 'FHIR_STORE', 'INPUT_FILE')
  log.info('Transforming file', { file: INPUT_FILE })

  const rows = await queryRows(
    `SELECT message_hash, file_name, control_id, trigger_event, mrn, message
     FROM ${tableRef(BQ_QUALITY_DATASET, VALIDATED_TABLE)}
     WHERE file_name = @file
     ORDER BY message_time`,
    { file: INPUT_FILE },
  )

  const results = []
  for (const row of rows) {
    let outcome
    try {
      outcome = await transformMessage(row.message)
    } catch (err) {
      outcome = { status: 'failed', detail: err.message }
    }
    const logFields = { file: INPUT_FILE, controlId: row.control_id, trigger: row.trigger_event, detail: outcome.detail }
    outcome.status === 'failed' ? log.error('FHIR write failed', logFields) : log.info(`FHIR ${outcome.status}`, logFields)

    results.push({
      message_hash:  row.message_hash,
      file_name:     row.file_name,
      control_id:    row.control_id,
      trigger_event: row.trigger_event,
      mrn:           row.mrn,
      ...outcome,
      processed_at:  new Date().toISOString(),
    })
  }

  // A re-run replaces only earlier failures. A message already written stays 'sent', even
  // though the re-run (correctly) skips it as already stored.
  await ensureTable(BQ_QUALITY_DATASET, FHIR_RESULTS_TABLE, RESULTS_SCHEMA)
  await mergeRows(BQ_QUALITY_DATASET, FHIR_RESULTS_TABLE, RESULTS_SCHEMA, results, 'message_hash',
    { updateWhen: "T.status = 'failed'" })

  const count  = status => results.filter(r => r.status === status).length
  const failed = count('failed')
  log.info('Transformed file', { file: INPUT_FILE, messages: rows.length, sent: count('sent'), skipped: count('skipped'), failed })

  // A failed write is usually transient: exit non-zero so Cloud Run retries the job
  if (failed) process.exitCode = 1
}

main().catch(err => {
  log.error(`Transformer failed: ${err.message}`, { file: INPUT_FILE })
  process.exitCode = 1
})
