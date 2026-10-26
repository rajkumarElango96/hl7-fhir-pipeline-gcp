// Parser (Cloud Run job): landed batch file -> one row per HL7 message in the raw layer.
// Messages are stored unchanged (ELT); the validator reads the fields later.
// Idempotent: rows are keyed on a hash of the message, so re-running adds nothing.
const { readTextGcs }                  = require('../../lib/storage')
const { ensureTable, mergeRows }       = require('../../lib/bigquery')
const { splitMessages, messageHash }   = require('../../lib/hl7')
const createLogger                     = require('../../lib/log')
const {
  LANDING_BUCKET, INPUT_FILE, BQ_RAW_DATASET, RAW_TABLE, requireConfig,
} = require('../../config')

const log = createLogger('parser')

const RAW_SCHEMA = [
  { name: 'message_hash', type: 'STRING' },
  { name: 'file_name',    type: 'STRING' },
  { name: 'msg_no',       type: 'INT64' },
  { name: 'message',      type: 'STRING' },
  { name: 'loaded_at',    type: 'TIMESTAMP' },
]

// Batch text -> raw rows. A message repeated inside the same file is kept once.
function toRawRows(fileName, text) {
  const loadedAt = new Date().toISOString()
  const rows     = new Map()
  splitMessages(text).forEach((message, i) => {
    const hash = messageHash(message)
    if (!rows.has(hash)) {
      rows.set(hash, { message_hash: hash, file_name: fileName, msg_no: i + 1, message, loaded_at: loadedAt })
    }
  })
  return [...rows.values()]
}

async function main() {
  requireConfig('GCP_PROJECT', 'LANDING_BUCKET', 'INPUT_FILE')
  log.info('Parsing file', { file: INPUT_FILE })

  const text = await readTextGcs(LANDING_BUCKET, INPUT_FILE)
  const rows = toRawRows(INPUT_FILE, text)

  await ensureTable(BQ_RAW_DATASET, RAW_TABLE, RAW_SCHEMA)
  const inserted = await mergeRows(BQ_RAW_DATASET, RAW_TABLE, RAW_SCHEMA, rows, 'message_hash')

  log.info('Parsed file', {
    file:            INPUT_FILE,
    messages:        rows.length,
    inserted,
    alreadyLoaded:   rows.length - inserted,
  })
}

main().catch(err => {
  log.error(`Parser failed: ${err.message}`, { file: INPUT_FILE })
  process.exitCode = 1
})
