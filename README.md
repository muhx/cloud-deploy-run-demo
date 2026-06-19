# cloud-deploy-run-demo

A reference project that takes you **from zero to a publicly reachable, IAP-gated Cloud Run service** — with a fully automated CI/CD pipeline.

Push to `main` (or a `v*` tag) → GitHub Actions builds a Docker image → pushes to Artifact Registry → creates a Google Cloud Deploy release → auto-deploys to **staging** → waits for approval → **canary** rollout to **production**. Every service is exposed to the internet but sits behind **Identity-Aware Proxy (IAP)**, so only authorized Google identities can reach it.

The app itself is a minimal **Next.js 16** "Hello World" that also displays the requester's IP and the deployed git commit.

---

## Architecture

```
 git push (main / v*)               GitHub Actions
        │                    ┌─────────────────────────────┐
        └───────────────────▶│ publish: build + push image │
                             │ deploy:  create CD release  │
                             └──────────────┬──────────────┘
                                            │ (keyless: Direct WIF)
                  ┌─────────────────────────▼────────────────────────────┐
                  │              Google Cloud Deploy                     │
                  │   pipeline: muhx-cloud-deploy-run-demo-pipeline      │
                  │                                                      │
                  │   ┌──────────┐   approval    ┌──────────────────┐    │
                  │   │ staging  │──────────────▶│ production       │    │
                  │   │ (auto)   │   gate        │ canary 50→75→100 │    │
                  │   └────┬─────┘               └────────┬─────────┘    │
                  └────────┼──────────────────────────────┼──────────────┘
                           ▼                              ▼
                    Cloud Run (stg)               Cloud Run (prd)
                    ingress: all                  ingress: all
                    IAP: enabled                  IAP: enabled
                    minScale: 0                   minScale: 0
                           │                              │
                           └────────── IAP gate ──────────┘
                                          │
                            domain:mile.cloud identities only
```

---

## Repository layout

```
.
├── app/                      # Next.js 16 App Router
│   ├── layout.tsx
│   └── page.tsx              # shows Hello World + client IP + commit SHA
├── lib/
│   └── get-ip.ts             # resolves client IP from forwarding headers
├── Dockerfile                # multi-stage, standalone output, runs on $PORT (3000)
├── next.config.ts            # output: standalone; bakes COMMIT_SHA into the bundle
├── skaffold.yaml             # Cloud Deploy render config (staging/production profiles)
├── clouddeploy.yaml          # delivery pipeline + staging/production targets
├── svc/
│   ├── deploy-stg.yaml       # Cloud Run service manifest — staging
│   └── deploy-prd.yaml       # Cloud Run service manifest — production
├── .github/workflows/
│   └── publish.yml           # build → push → create Cloud Deploy release
├── .dockerignore
└── .gcloudignore             # trims the Cloud Deploy release source upload
```

---

## Prerequisites

- A GCP project (this guide uses `id-rd-sa-muhamad-rohman`, number `327481442371`)
- `gcloud` CLI authenticated with Owner/Editor (or equivalent admin) on the project
- A GitHub repo (`muhx/cloud-deploy-run-demo`) and the `gh` CLI
- Docker (for local image testing) and Node.js 24+
- An organization-managed Google domain for IAP access (`mile.cloud`)

Set these shell variables — every command below uses them:

```bash
export PROJECT=id-rd-sa-muhamad-rohman
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
export REGION=us-central1
export REPO=muhx/cloud-deploy-run-demo        # owner/repo
export GAR_REPO=muhx                          # Artifact Registry repository id
export IMAGE=cloud-deploy-run-demo            # image + Cloud Deploy placeholder name
export PIPELINE=muhx-cloud-deploy-run-demo-pipeline
export RUNTIME_SA=demo-cr-runner@${PROJECT}.iam.gserviceaccount.com
export EXEC_SA=${PROJECT_NUMBER}-compute@developer.gserviceaccount.com   # Cloud Deploy execution SA
export WIF_POOL=github
export WIF_PROVIDER=muhx                       # provider whose condition matches your repo owner
export ACCESS_DOMAIN=mile.cloud                # who may pass IAP
```

---

## Setup from zero

### 1. Enable the APIs

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  clouddeploy.googleapis.com \
  iap.googleapis.com \
  iamcredentials.googleapis.com \
  --project="$PROJECT"
```

### 2. Create the Artifact Registry repository

```bash
gcloud artifacts repositories create "$GAR_REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --project="$PROJECT"
```

Image path becomes: `us-central1-docker.pkg.dev/$PROJECT/$GAR_REPO/$IMAGE`.

### 3. Set up Workload Identity Federation (keyless, Direct WIF)

Direct WIF lets GitHub Actions authenticate to GCP with **no service-account keys and no impersonation** — the GitHub OIDC token is mapped directly to IAM principals.

```bash
# Pool
gcloud iam workload-identity-pools create "$WIF_POOL" \
  --location=global --project="$PROJECT" \
  --display-name="GitHub Actions"

# Provider — scoped to your GitHub org/owner via attributeCondition
gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER" \
  --location=global --project="$PROJECT" \
  --workload-identity-pool="$WIF_POOL" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository_owner == 'muhx'"
```

The principal for this repo (used in all bindings below):

```bash
export PRINCIPAL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/attribute.repository/${REPO}"
```

> The full provider resource name (for the GitHub variable) is:
> `projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}`

### 4. Grant the WIF principal push + release permissions

```bash
# Push images to Artifact Registry
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="$PRINCIPAL" --role="roles/artifactregistry.writer" --condition=None

# Create Cloud Deploy releases
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="$PRINCIPAL" --role="roles/clouddeploy.releaser" --condition=None

# Create + write the Cloud Deploy source-staging bucket on first release
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="$PRINCIPAL" --role="roles/storage.admin" --condition=None
```

> `--condition=None` is required when the project IAM policy already contains conditional bindings (otherwise `add-iam-policy-binding` refuses to run non-interactively).

### 5. Create the Cloud Run runtime service account

This is the identity the running service uses.

```bash
gcloud iam service-accounts create demo-cr-runner \
  --project="$PROJECT" --display-name="Cloud Run runtime SA"
# grant it whatever your app needs (e.g. roles/secretmanager.secretAccessor, etc.)
```

### 6. Configure GitHub repository variables

The workflow reads these (Settings → Secrets and variables → Actions → **Variables**):

| Variable | Value |
|----------|-------|
| `GCP_PROJECT_ID` | `id-rd-sa-muhamad-rohman` |
| `GAR_LOCATION` | `us-central1` |
| `GAR_REPOSITORY` | `muhx` |
| `GCP_WIF_PROVIDER` | `projects/327481442371/locations/global/workloadIdentityPools/github/providers/muhx` |

```bash
gh variable set GCP_PROJECT_ID --repo "$REPO" --body "$PROJECT"
gh variable set GAR_LOCATION   --repo "$REPO" --body "$REGION"
gh variable set GAR_REPOSITORY --repo "$REPO" --body "$GAR_REPO"
gh variable set GCP_WIF_PROVIDER --repo "$REPO" \
  --body "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}"
```

### 7. Create the Cloud Deploy pipeline + targets

`clouddeploy.yaml` defines the pipeline (staging → production) and the two Cloud Run targets. Production uses a **canary** strategy (50% → 75% → 100%) and **requires manual approval**.

```bash
gcloud deploy apply --file=clouddeploy.yaml --region="$REGION" --project="$PROJECT"
```

Re-run this whenever `clouddeploy.yaml` changes.

### 8. Grant the Cloud Deploy execution service account permissions

Cloud Deploy itself runs as the **Compute Engine default SA** (the execution SA). It renders manifests and deploys to Cloud Run.

```bash
# Run pipeline jobs
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$EXEC_SA" --role="roles/clouddeploy.jobRunner" --condition=None

# Deploy to Cloud Run
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$EXEC_SA" --role="roles/run.developer" --condition=None

# Act as the runtime SA the service runs under
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --project="$PROJECT" \
  --member="serviceAccount:$EXEC_SA" --role="roles/iam.serviceAccountUser"

# The release creator (WIF principal) must be able to act as the execution SA
gcloud iam service-accounts add-iam-policy-binding "$EXEC_SA" --project="$PROJECT" \
  --member="$PRINCIPAL" --role="roles/iam.serviceAccountUser"
```

### 9. Enable IAP (public ingress, gated access)

The service manifests already set `ingress: all` + `run.googleapis.com/iap-enabled: 'true'`. Wire up the IAM so IAP can invoke the service and your users can pass the gate.

```bash
# Create the IAP service agent (P4SA)
CLOUDSDK_CORE_DISABLE_PROMPTS=1 gcloud beta services identity create \
  --service=iap.googleapis.com --project="$PROJECT"
export IAP_SA="service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com"

# IAP must be allowed to invoke the Cloud Run services
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$IAP_SA" --role="roles/run.invoker" --condition=None

# Who may pass IAP — entire domain in this demo
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="domain:${ACCESS_DOMAIN}" --role="roles/iap.httpsResourceAccessor" --condition=None
```

> These are project-level grants, so they cover both staging and production. To scope access per-service instead, use:
> `gcloud beta iap web add-iam-policy-binding --resource-type=cloud-run --service=<svc> --region=$REGION --member=... --role=roles/iap.httpsResourceAccessor`

### 10. First deploy

Commit and push to `main`:

```bash
git add -A && git commit -m "Initial deploy" && git push origin main
```

This triggers the workflow:
1. **publish** — builds the image (with `COMMIT_SHA` baked in) and pushes `:<sha>` + `:latest`.
2. **deploy** — runs `gcloud deploy releases create`, which auto-deploys to **staging**.

Watch it:

```bash
gh run watch "$(gh run list --repo "$REPO" --limit 1 --json databaseId --jq '.[0].databaseId')" --repo "$REPO"
```

### 11. Promote to production

Production is gated by approval and rolls out as a canary.

```bash
REL=$(gcloud deploy releases list --delivery-pipeline="$PIPELINE" --region="$REGION" --project="$PROJECT" --limit=1 --format='value(name.basename())')

gcloud deploy releases promote --release="$REL" \
  --delivery-pipeline="$PIPELINE" --region="$REGION" --project="$PROJECT"

# Approve the pending production rollout (or use the Cloud Deploy console)
gcloud deploy rollouts list --release="$REL" --delivery-pipeline="$PIPELINE" --region="$REGION" --project="$PROJECT"
gcloud deploy rollouts approve <ROLLOUT_NAME> --release="$REL" \
  --delivery-pipeline="$PIPELINE" --region="$REGION" --project="$PROJECT"
```

---

## Verifying the IAP gate

An unauthenticated request should be redirected to Google sign-in (HTTP 302), never reach the app:

```bash
URL=$(gcloud run services describe cloud-deploy-run-demo-stg --region="$REGION" --project="$PROJECT" --format='value(status.url)')
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$URL"     # → HTTP 302
```

To call it programmatically as an authorized identity, send an IAP ID token in the `Authorization: Bearer` header (see [IAP programmatic access](https://cloud.google.com/iap/docs/authentication-howto)).

---

## CI/CD trigger reference

The workflow (`.github/workflows/publish.yml`) runs on:

| Trigger | Behavior |
|---------|----------|
| Push to `main` | build → push → release → staging auto-deploy |
| Tag `v*` | same as above |
| Manual (`workflow_dispatch`) | optional `custom_tag` input; uncheck **push** for a build-only dry run (skips GCP auth + deploy) |

Production always waits for manual approval before the canary rollout.

---

## Configuration notes

**Image / port** — The Next.js standalone server listens on `$PORT`. The Dockerfile sets `PORT=3000`; Cloud Run sets `PORT` to the manifest `containerPort` (3000). Keep these aligned.

**Networking** — Services attach to VPC `vpc-net` / subnet `subnet-iow` (same project) with `vpc-access-egress: all-traffic`. Ingress is `all` so IAP (a Google-managed front end) can reach them; IAP enforces auth.

**Cost (scale-to-zero)** — Both services set `autoscaling.knative.dev/minScale: '0'`, so there are **no billed instances when idle**. CPU is throttled outside requests (Cloud Run default) and startup-cpu-boost is off. Trade-off: a cold start on the first request after idle (the manifests use a generous 240s startup probe). Set `minScale: '1'` on a service if you must avoid cold starts (always-on instance, billable).

**Image substitution** — `svc/*.yaml` use the placeholder `image: cloud-deploy-run-demo`. The workflow's `gcloud deploy releases create --images=cloud-deploy-run-demo=<GAR image>:<sha>` swaps in the real, SHA-pinned image at release time. The placeholder name must match `IMAGE_PLACEHOLDER` in the workflow.

---

## Troubleshooting

**`iam.serviceAccounts.getAccessToken denied` during auth** — You're using WIF *with* service-account impersonation but the principal can't impersonate the SA. Either grant `roles/iam.workloadIdentityUser` on that SA, or switch to **Direct WIF** (drop `service_account:` from the auth step — this repo uses Direct WIF).

**`Adding a binding without specifying a condition ... is prohibited`** — The project policy has conditional bindings. Append `--condition=None` to `gcloud projects add-iam-policy-binding`.

**`gcloud beta services identity create` hangs / errors as "not interactive"** — Prefix with `CLOUDSDK_CORE_DISABLE_PROMPTS=1`.

**Release fails to upload source** — The WIF principal needs `roles/storage.admin` (the default `deploy-artifacts` bucket is created on first release).

**Production rollout stuck** — It's waiting for approval. Approve via the Cloud Deploy console or `gcloud deploy rollouts approve`.

**`git rev-parse` fails in CI** — The repo needs at least one commit before the workflow can compute a SHA.

---

## Local development

```bash
npm install
npm run dev            # http://localhost:3000

# Production build / Docker
docker build --build-arg COMMIT_SHA=$(git rev-parse --short HEAD) -t cloud-deploy-run-demo .
docker run --rm -p 3000:3000 cloud-deploy-run-demo
```
