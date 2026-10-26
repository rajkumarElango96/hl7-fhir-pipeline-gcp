const { BigQuery }                = require('@google-cloud/bigquery')
const { GCP_PROJECT, GCP_REGION } = require('../config')

const bigquery = new BigQuery({ projectId: GCP_PROJECT, location: GCP_REGION })

// Fully qualified, quoted table name for SQL
const tableRef = (datasetId, tableId) => `\`${GCP_PROJECT}.${datasetId}.${tableId}\``

// schema: [{ name, type }] with types STRING, INT64 or TIMESTAMP
async function ensureTable(datasetId, tableId, schema) {
  const table    = bigquery.dataset(datasetId).table(tableId)
  const [exists] = await table.exists()
  if (!exists) await table.create({ schema })
}

async function queryRows(sql, params = {}) {
  const [rows] = await bigquery.query({ query: sql, params, location: GCP_REGION })
  return rows
}

// Idempotent write. Inserts rows whose key is not in the table yet, so re-running a step
// adds nothing. With { update: true } rows that already exist are refreshed instead.
// Rows travel as one query parameter: fine for PoC batches (hundreds of rows, well under
// BigQuery's request size limit). At real volume this becomes a load job into a staging table.
async function mergeRows(datasetId, tableId, schema, rows, key, { update = false } = {}) {
  if (!rows.length) return 0

  const columns   = schema.map(c => c.name)
  const setClause = columns.filter(c => c !== key).map(c => `${c} = S.${c}`).join(', ')
  const sql = `
    MERGE ${tableRef(datasetId, tableId)} T
    USING UNNEST(@rows) S
    ON T.${key} = S.${key}
    ${update ? `WHEN MATCHED THEN UPDATE SET ${setClause}` : ''}
    WHEN NOT MATCHED THEN INSERT (${columns.join(', ')}) VALUES (${columns.map(c => `S.${c}`).join(', ')})`

  const types = { rows: [Object.fromEntries(schema.map(c => [c.name, c.type]))] }
  const [job] = await bigquery.createQueryJob({
    query:    sql,
    params:   { rows: rows.map(row => toParam(row, schema)) },
    types,
    location: GCP_REGION,
  })
  await job.getQueryResults()

  const [metadata] = await job.getMetadata()
  return Number(metadata.statistics?.query?.numDmlAffectedRows ?? 0)
}

// Keep only schema columns, in order; wrap timestamps so BigQuery types them correctly
function toParam(row, schema) {
  return Object.fromEntries(schema.map(({ name, type }) => {
    const value = row[name] ?? null
    return [name, type === 'TIMESTAMP' && value !== null ? BigQuery.timestamp(new Date(value)) : value]
  }))
}

module.exports = { tableRef, ensureTable, queryRows, mergeRows }
