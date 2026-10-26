#!/usr/bin/env bash
# One-time GCP setup for a fresh project: everything deploy.sh expects to exist.
#   - APIs
#   - landing bucket (versioned, private)
#   - BigQuery datasets raw, quality, analytics
#   - Healthcare dataset + FHIR R4 store (update-create on, streaming to analytics)
#   - service account hl7-pipeline with the roles the jobs need
#   - service account hospital-sender: can only create files in the landing bucket
# Safe to re-run: each step skips what already exists.
#
# Usage: PROJECT=<project-id> ./infra/setup.sh
#   optional: REGION (asia-south1), BUCKET (<project>-landing), HC_DATASET (hl7-fhir), FHIR_STORE (fhir-r4)
set -euo pipefail

: "${PROJECT:?set PROJECT}"
REGION="${REGION:-asia-south1}"
BUCKET="${BUCKET:-${PROJECT}-landing}"
HC_DATASET="${HC_DATASET:-hl7-fhir}"
FHIR_STORE="${FHIR_STORE:-fhir-r4}"
PIPE_SA="hl7-pipeline@${PROJECT}.iam.gserviceaccount.com"
SENDER_SA="hospital-sender@${PROJECT}.iam.gserviceaccount.com"

gcloud config set project "$PROJECT" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
ME="$(gcloud config get-value account 2>/dev/null)"

echo "== APIs"
gcloud services enable storage.googleapis.com bigquery.googleapis.com healthcare.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com

echo "== Landing bucket gs://$BUCKET"
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 \
  || gcloud storage buckets create "gs://$BUCKET" --location="$REGION" \
       --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://$BUCKET" --versioning >/dev/null

echo "== BigQuery datasets"
for ds in raw quality analytics; do
  bq --location="$REGION" show "$PROJECT:$ds" >/dev/null 2>&1 || bq --location="$REGION" mk --dataset "$PROJECT:$ds"
done

echo "== Healthcare dataset $HC_DATASET and FHIR store $FHIR_STORE"
gcloud healthcare datasets describe "$HC_DATASET" --location="$REGION" >/dev/null 2>&1 \
  || gcloud healthcare datasets create "$HC_DATASET" --location="$REGION"

# The Healthcare service agent writes the streaming export into BigQuery
HC_AGENT="service-${PROJECT_NUMBER}@gcp-sa-healthcare.iam.gserviceaccount.com"
for role in roles/bigquery.dataEditor roles/bigquery.jobUser; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$HC_AGENT" \
    --role="$role" --condition=None >/dev/null
done

if ! gcloud healthcare fhir-stores describe "$FHIR_STORE" --dataset="$HC_DATASET" --location="$REGION" >/dev/null 2>&1; then
  # REST call, because it sets update-create and BigQuery streaming in one request
  curl -sf -X POST \
    -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H "Content-Type: application/json" \
    "https://healthcare.googleapis.com/v1/projects/$PROJECT/locations/$REGION/datasets/$HC_DATASET/fhirStores?fhirStoreId=$FHIR_STORE" \
    -d "{
      \"version\": \"R4\",
      \"enableUpdateCreate\": true,
      \"disableReferentialIntegrity\": false,
      \"streamConfigs\": [{
        \"bigqueryDestination\": {
          \"datasetUri\": \"bq://$PROJECT.analytics\",
          \"schemaConfig\": { \"schemaType\": \"ANALYTICS_V2\", \"recursiveStructureDepth\": 2 }
        }
      }]
    }" >/dev/null
fi

echo "== Service account $PIPE_SA (runs the pipeline)"
gcloud iam service-accounts describe "$PIPE_SA" >/dev/null 2>&1 \
  || gcloud iam service-accounts create hl7-pipeline --display-name="HL7 FHIR pipeline"
for role in roles/bigquery.dataEditor roles/bigquery.jobUser roles/eventarc.eventReceiver roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$PIPE_SA" \
    --role="$role" --condition=None >/dev/null
done
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$PIPE_SA" \
  --role=roles/storage.objectViewer >/dev/null
gcloud healthcare datasets add-iam-policy-binding "$HC_DATASET" --location="$REGION" \
  --member="serviceAccount:$PIPE_SA" --role=roles/healthcare.fhirResourceEditor >/dev/null

echo "== Service account $SENDER_SA (the hospital: create files only)"
gcloud iam service-accounts describe "$SENDER_SA" >/dev/null 2>&1 \
  || gcloud iam service-accounts create hospital-sender --display-name="Hospital EHR outbound sender"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$SENDER_SA" \
  --role=roles/storage.objectCreator >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$SENDER_SA" --member="user:$ME" \
  --role=roles/iam.serviceAccountTokenCreator >/dev/null

cat <<MSG

Setup done. Next:
  PROJECT=$PROJECT BUCKET=$BUCKET HC_DATASET=$HC_DATASET FHIR_STORE=$FHIR_STORE ./infra/deploy.sh
MSG
