#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="sqlite-viewer"
REGION="us-central1"
PROJECT="${PROJECT:-based-hardware-dev}"
FLAGS=("--allow-unauthenticated")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service)
      SERVICE_NAME="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --project)
      PROJECT="$2"
      shift 2
      ;;
    --no-public)
      FLAGS=()
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI not found. Install Google Cloud SDK first." >&2
  exit 1
fi

echo "Deploying $SERVICE_NAME to Cloud Run (region: $REGION, project: $PROJECT)..."

gcloud config set project "$PROJECT" >/dev/null

gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  "${FLAGS[@]}"

URL=$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)')

echo "Deployment complete. Service URL: $URL"
