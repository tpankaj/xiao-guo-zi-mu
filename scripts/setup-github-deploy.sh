#!/usr/bin/env bash
# One-time setup: lets GitHub Actions (tpankaj/xiao-guo-zi-mu, main branch only)
# deploy to Firebase via Workload Identity Federation — no long-lived keys.
set -euo pipefail

PROJECT=xiao-guo-zimu
REPO=tpankaj/xiao-guo-zi-mu
SA=github-deployer
SA_EMAIL="$SA@$PROJECT.iam.gserviceaccount.com"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project "$PROJECT"

gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SA" --project "$PROJECT" --display-name "GitHub Actions deployer"

for role in \
  roles/firebasehosting.admin \
  roles/cloudfunctions.admin \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/secretmanager.viewer \
  roles/artifactregistry.admin \
  roles/cloudbuild.builds.editor \
  roles/serviceusage.serviceUsageConsumer \
  roles/firebase.viewer; do
  # A freshly created service account can take a minute to become visible to IAM.
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if gcloud projects add-iam-policy-binding "$PROJECT" \
        --member "serviceAccount:$SA_EMAIL" --role "$role" --condition=None --quiet >/dev/null 2>&1; then
      echo "granted $role"; break
    fi
    [ "$attempt" = 12 ] && { echo "failed to grant $role" >&2; exit 1; }
    echo "waiting for service account to propagate ($role, attempt $attempt)..."; sleep 10
  done
done

gcloud iam workload-identity-pools describe github --location global --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create github --location global --project "$PROJECT" \
    --display-name "GitHub Actions"

gcloud iam workload-identity-pools providers describe github --workload-identity-pool github \
  --location global --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc github \
    --workload-identity-pool github --location global --project "$PROJECT" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository == '$REPO' && assertion.ref == 'refs/heads/main'"

# The new service account / pool can take a minute or two to propagate.
for attempt in $(seq 1 18); do
  if gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project "$PROJECT" \
      --role roles/iam.workloadIdentityUser \
      --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO" \
      --quiet >/dev/null 2>&1; then
    echo "granted roles/iam.workloadIdentityUser to $REPO"; break
  fi
  [ "$attempt" = 18 ] && { echo "failed to bind workloadIdentityUser; re-run with the command un-silenced to see the error" >&2; exit 1; }
  echo "waiting for propagation (workloadIdentityUser, attempt $attempt)..."; sleep 10
done

echo "Done. Provider: projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github"
