// One place for every GCP resource name. Values come from environment variables,
// optionally loaded from a .env file at the repo root (see .env.example).
// Nothing else in the code hard-codes a project, region, dataset or store name.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(ENV_FILE) && !process.env.PIPELINE_ENV_LOADED) {
  process.loadEnvFile(ENV_FILE); // existing environment variables win
  process.env.PIPELINE_ENV_LOADED = '1';
}

// key -> [environment variable, default]. A null default means it must be set.
const SPEC = {
  projectId: ['GCP_PROJECT', null],
  region: ['GCP_REGION', null],
  landingBucket: ['LANDING_BUCKET', null],
  rawDataset: ['BQ_RAW_DATASET', 'raw'],
  qualityDataset: ['BQ_QUALITY_DATASET', 'quality'],
  analyticsDataset: ['BQ_ANALYTICS_DATASET', 'analytics'],
  healthcareDataset: ['HEALTHCARE_DATASET', null],
  fhirStore: ['FHIR_STORE', null],
};

export function loadConfig(env = process.env) {
  return Object.fromEntries(Object.entries(SPEC).map(([key, [name, fallback]]) => [key, env[name] || fallback]));
}

// Throws one clear error listing every missing variable, e.g. requireConfig('projectId', 'fhirStore').
export function requireConfig(...keys) {
  const cfg = loadConfig();
  const missing = keys.filter((k) => !cfg[k]).map((k) => SPEC[k][0]);
  if (missing.length) {
    throw new Error(`Missing configuration: ${missing.join(', ')}. Set them in the environment or in .env (see .env.example).`);
  }
  return cfg;
}

// Base URL of the FHIR store in the Cloud Healthcare API.
// FHIR_BASE_URL overrides it (e.g. a local emulator or test server).
export function fhirStoreUrl(cfg) {
  if (!cfg && process.env.FHIR_BASE_URL) return process.env.FHIR_BASE_URL;
  cfg ??= requireConfig('projectId', 'region', 'healthcareDataset', 'fhirStore');
  return `https://healthcare.googleapis.com/v1/projects/${cfg.projectId}/locations/${cfg.region}`
    + `/datasets/${cfg.healthcareDataset}/fhirStores/${cfg.fhirStore}/fhir`;
}
