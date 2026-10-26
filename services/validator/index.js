// Validator (Cloud Run job): raw rows of one file -> validated + rejected layers.
// Failures are data problems, so they are quarantined with a reason, never retried.
// Idempotent: both tables are keyed on the message hash.
const { tableRef, ensureTable, queryRows, mergeRows } = require('../../lib/bigquery')
const { validateRow }                                 = require('./rules')
const createLogger                                    = require('../../lib/log')
const {
  INPUT_FILE, BQ_RAW_DATASET, BQ_QUALITY_DATASET, RAW_TABLE, VALIDATED_TABLE, REJECTED_TABLE, requireConfig,
} = require('../../config')

const log = createLogger('validator')

const COMMON = [
  { name: 'message_hash',  type: 'STRING' },
  { name: 'file_name',     type: 'STRING' },
  { name: 'msg_no',        type: 'INT64' },
  { name: 'control_id',    type: 'STRING' },
  { name: 'trigger_event', type: 'STRING' },
  { name: 'mrn',           type: 'STRING' },
]

const VALIDATED_SCHEMA = [
  ...COMMON,
  { name: 'message_time', type: 'TIMESTAMP' },
  { name: 'message',      type: 'STRING' },
  { name: 'validated_at', type: 'TIMESTAMP' },
]

const REJECTED_SCHEMA = [
  ...COMMON,
  { name: 'rules',       type: 'STRING' },
  { name: 'reason',      type: 'STRING' },
  { name: 'message',     type: 'STRING' },
  { name: 'rejected_at', type: 'TIMESTAMP' },
]

async function main() {
  requireConfig('GCP_PROJECT', 'INPUT_FILE')
  log.info('Validating file', { file: INPUT_FILE })

  const rawRows = await queryRows(
    `SELECT message_hash, file_name, msg_no, message
     FROM ${tableRef(BQ_RAW_DATASET, RAW_TABLE)}
     WHERE file_name = @file`,
    { file: INPUT_FILE },
  )

  const validated = []
  const rejected  = []
  for (const raw of rawRows) {
    const { status, row } = validateRow(raw)
    if (status === 'validated') {
      validated.push(row)
    } else {
      rejected.push(row)
      log.warn('Message rejected', { file: INPUT_FILE, controlId: row.control_id, reason: row.reason })
    }
  }

  await ensureTable(BQ_QUALITY_DATASET, VALIDATED_TABLE, VALIDATED_SCHEMA)
  await ensureTable(BQ_QUALITY_DATASET, REJECTED_TABLE, REJECTED_SCHEMA)
  await mergeRows(BQ_QUALITY_DATASET, VALIDATED_TABLE, VALIDATED_SCHEMA, validated, 'message_hash')
  await mergeRows(BQ_QUALITY_DATASET, REJECTED_TABLE, REJECTED_SCHEMA, rejected, 'message_hash')

  log.info('Validated file', { file: INPUT_FILE, messages: rawRows.length, validated: validated.length, rejected: rejected.length })
}

main().catch(err => {
  log.error(`Validator failed: ${err.message}`, { file: INPUT_FILE })
  process.exitCode = 1
})
