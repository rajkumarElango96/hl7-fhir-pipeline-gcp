// Minimal client for the Cloud Healthcare API FHIR store.
// Auth comes from the runtime identity (the hl7-pipeline service account on Cloud Run,
// or your gcloud application-default login locally). No tokens are handled in code.
const { GoogleAuth }    = require('google-auth-library')
const { FHIR_BASE_URL } = require('../config')

const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' })

async function request(method, path, body) {
  const client = await auth.getClient()
  try {
    const res = await client.request({
      url:          `${FHIR_BASE_URL}${path}`,
      method,
      data:         body,
      headers:      { 'Content-Type': 'application/fhir+json' },
      responseType: 'text', // the store answers application/fhir+json, which the client won't parse itself
    })
    return parseJson(res.data)
  } catch (err) {
    const status  = err.response?.status
    const details = parseJson(err.response?.data)?.issue?.map(i => i.diagnostics).join('; ')
    const error   = new Error(`FHIR ${status ?? 'request'} failed: ${details || err.message}`)
    error.status  = status
    throw error
  }
}

function parseJson(data) {
  if (typeof data !== 'string') return data
  try {
    return data ? JSON.parse(data) : {}
  } catch {
    return { raw: data }
  }
}

// Current resource for a business identifier, or undefined.
// (Searching rather than _summary=count: Google's FHIR store does not support the latter.)
async function findByIdentifier(type, system, value) {
  const bundle = await request('GET', `/${type}?identifier=${encodeURIComponent(`${system}|${value}`)}`)
  return bundle.entry?.[0]?.resource
}

const executeBundle = bundle => request('POST', '', bundle)

module.exports = { findByIdentifier, executeBundle }
