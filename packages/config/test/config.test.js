import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, fhirStoreUrl } from '../index.js';

test('dataset names default, resource names come from the environment', () => {
  const cfg = loadConfig({ GCP_PROJECT: 'p1', GCP_REGION: 'asia-south1' });
  assert.equal(cfg.projectId, 'p1');
  assert.equal(cfg.rawDataset, 'raw');
  assert.equal(cfg.qualityDataset, 'quality');
  assert.equal(cfg.fhirStore, null);
});

test('FHIR store URL is built from config, never hard-coded', () => {
  const url = fhirStoreUrl({ projectId: 'p1', region: 'asia-south1', healthcareDataset: 'ds', fhirStore: 'store' });
  assert.equal(url, 'https://healthcare.googleapis.com/v1/projects/p1/locations/asia-south1/datasets/ds/fhirStores/store/fhir');
});
