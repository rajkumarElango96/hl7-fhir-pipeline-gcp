// Minimal Cloud Healthcare API FHIR client: search by identifier, execute a transaction bundle.
// Auth: FHIR_TOKEN env var if set, otherwise `gcloud auth print-access-token`.
import { execFileSync } from 'node:child_process';
import { fhirStoreUrl } from '@pipeline/config';

function accessToken() {
  if (process.env.FHIR_TOKEN) return process.env.FHIR_TOKEN;
  const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
  if (!token) throw new Error('No access token: run `gcloud auth login` (Cloud Shell loses it after a restart)');
  return token;
}

export class FhirError extends Error {
  constructor(status, body) {
    super(`FHIR ${status}: ${body.issue?.map((i) => i.diagnostics).join('; ') || JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
  }
}

export function createFhirClient({ baseUrl = fhirStoreUrl(), token = accessToken() } = {}) {
  const call = async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new FhirError(res.status, json);
    return json;
  };

  return {
    // Current resource for an identifier, or undefined. (No _summary=count: Google's store does not support it.)
    async findByIdentifier(type, system, value) {
      const bundle = await call('GET', `/${type}?identifier=${encodeURIComponent(`${system}|${value}`)}`);
      return bundle.entry?.[0]?.resource;
    },
    executeBundle: (bundle) => call('POST', '', bundle),
  };
}
