#!/usr/bin/env bash
# Builds the pipeline image and deploys everything that runs it:
#   3 Cloud Run jobs (parser, validator, transformer), the workflow, and the
#   "file landed" Eventarc trigger. Safe to re-run: it updates what already exists.
#
# Prerequisites (done once, see README "GCP setup"): APIs enabled, landing bucket,
# BigQuery datasets, FHIR store, and the hl7-pipeline service account.
#
# Usage, from the repo root (Cloud Shell or a machine with gcloud):
#   PROJECT=hl7-fhir-pipeline BUCKET=<landing-bucket> FHIR_STORE=<store-id> ./infra/deploy.sh
set -euo pipefail

: "${PROJECT:?set PROJECT}"
: "${BUCKET:?set BUCKET (landing bucket name)}"
: "${FHIR_STORE:?set FHIR_STORE (FHIR store ID)}"
REGION="${REGION:-asia-south1}"
HC_DATASET="${HC_DATASET:-hl7-fhir-pipeline-landing-fhir}"
SA="hl7-pipeline@${PROJECT}.iam.gserviceaccount.com"
REPO="pipeline"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/pipeline:latest"
WORKFLOW="hl7-pipeline"
TRIGGER="hl7-file-landed"

gcloud config set project "$PROJECT" >/dev/null
echo "== Project $PROJECT, region $REGION, bucket gs://$BUCKET"

echo "== APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  workflows.googleapis.com workflowexecutions.googleapis.com eventarc.googleapis.com pubsub.googleapis.com \
  bigquery.googleapis.com healthcare.googleapis.com storage.googleapis.com logging.googleapis.com

echo "== Permissions the orchestration needs (on top of the setup roles)"
for role in roles/run.jobsExecutorWithOverrides roles/run.viewer roles/workflows.invoker; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" \
    --role="$role" --condition=None >/dev/null
done

echo "== Cloud Build permissions"
# New projects run Cloud Build as the Compute Engine default service account, which
# cannot read the uploaded source or push the image until it has the builder role.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.builder" --condition=None >/dev/null

echo "== Container registry"
gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION"

echo "== Build image $IMAGE"
gcloud builds submit --tag "$IMAGE" .

ENV_VARS="GCP_PROJECT=${PROJECT},GCP_REGION=${REGION},LANDING_BUCKET=${BUCKET},HEALTHCARE_DATASET=${HC_DATASET},FHIR_STORE=${FHIR_STORE}"

for job in parser validator transformer; do
  echo "== Deploy job: $job"
  gcloud run jobs deploy "$job" \
    --image="$IMAGE" \
    --region="$REGION" \
    --command=node \
    --args="services/${job}/index.js" \
    --service-account="$SA" \
    --set-env-vars="$ENV_VARS" \
    --tasks=1 \
    --max-retries=2 \
    --task-timeout=10m
done

echo "== Deploy workflow: $WORKFLOW"
gcloud workflows deploy "$WORKFLOW" \
  --source=infra/workflow.yaml \
  --location="$REGION" \
  --service-account="$SA"

echo "== Eventarc service agent"
# Eventarc checks the bucket with its own Google-managed account. On a new project that
# account may exist without its role yet, and trigger creation fails on storage.buckets.get.
gcloud beta services identity create --service=eventarc.googleapis.com --project="$PROJECT" >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-eventarc.iam.gserviceaccount.com" \
  --role="roles/eventarc.serviceAgent" --condition=None >/dev/null

# Cloud Storage announces new files through Pub/Sub as its own service agent
GCS_AGENT="service-${PROJECT_NUMBER}@gs-project-accounts.iam.gserviceaccount.com"
# IAM sometimes reports this Google-managed account as missing even when the grant exists,
# so a failure here is a warning, not a stop (trigger creation below verifies it anyway).
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${GCS_AGENT}" --role="roles/pubsub.publisher" --condition=None >/dev/null \
  || echo "WARNING: could not grant Pub/Sub Publisher to ${GCS_AGENT}; continuing"

echo "== Trigger: new file in gs://$BUCKET -> $WORKFLOW"
if ! gcloud eventarc triggers describe "$TRIGGER" --location="$REGION" >/dev/null 2>&1; then
  gcloud eventarc triggers create "$TRIGGER" \
    --location="$REGION" \
    --destination-workflow="$WORKFLOW" \
    --destination-workflow-location="$REGION" \
    --event-filters="type=google.cloud.storage.object.v1.finalized" \
    --event-filters="bucket=$BUCKET" \
    --service-account="$SA"
fi

cat <<MSG

Deployed. Upload a file to gs://$BUCKET and follow it:
  gcloud workflows executions list $WORKFLOW --location=$REGION --limit=5
  gcloud logging read 'jsonPayload.service=~"parser|validator|transformer"' --limit=20 --format='value(jsonPayload)'
MSG
