# e2e-sales-genos-relay

Internal relay service that lets Google Apps Script call the Intuit GenOS API
without direct access to Intuit's private network.

```
Apps Script  →  POST /generate (X-Relay-Api-Key)
             ←  GenOS chat/completions JSON (unchanged)

relay service  →  IDPS (fetch app_secret)
               →  Intuit Identity (exchange credentials → IAM ticket)
               →  GenOS endpoint (PrivateAuth+ header)
```

## Why this exists

GenOS sits behind Intuit Private Auth. The app secret must be fetched from IDPS,
which requires a trusted-network identity — impossible from Google Apps Script.
This relay runs inside IKS on the Intuit network, fetches the secret on startup,
and forwards authenticated requests to GenOS on behalf of Apps Script.

## Deployment checklist

Before first deploy, complete these steps:

### 1. Register the service in DevPortal

- Create a new asset: `Intuit.sbseganalyticsds.e2esalesgenosrelay`
- Note the numeric asset ID — set `ASSET_ID` in `msaas-config.yaml` and `config.py`
- Enable Private Auth and get the `idps_policy_id` — set it as `IDPS_POLICY_ID`

### 2. Grant the relay read access to the e2eautomationsales app secret

In IDPS/DevPortal, grant `e2e-sales-genos-relay`'s policy read access to:

```
managed-items/api-security/private-auth/preProd/appsecret
```

(AppId: `Intuit.sbseganalyticsds.e2eautomationsales`, Credential Id: `28623192314815246000`)

### 3. Create the deployment repo

Create `github.intuit.com/SBSEGAnalyticsDS/e2e-sales-genos-relay-deployment` and
update `deploy_repo` in `msaas-config.yaml`.

### 4. Set IKS cluster / ArgoCD values

Update all `REPLACE_ME` placeholders in `msaas-config.yaml` with values from the
IKS onboarding ticket.

### 5. Generate and store the relay API key

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

Store this as a K8s secret named `relay-api-key` in each namespace and inject it
as the `RELAY_API_KEY` env var. **Never commit this value.**

### 6. Update Apps Script

In `Code.js`, replace `GENOS_E2E_ENDPOINT` with the relay's ingress URL and
set `RELAY_API_KEY` (stored in Apps Script Properties Service, not hardcoded).
See `src/appsscript/Code.js` — the changes are already in place, referencing
`RELAY_ENDPOINT` and `RELAY_API_KEY` constants.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `APP_ENV` | yes | `local` / `e2e` / `qal` / `prd` |
| `RELAY_API_KEY` | yes | Secret key Apps Script sends in `X-Relay-Api-Key` |
| `IDPS_POLICY_ID` | yes (non-local) | IDPS policy ID from DevPortal |
| `ASSET_ID` | yes (local only) | Numeric asset ID for local IDPS auth |
| `INTUIT_APP_ID` | no | Defaults to `Intuit.sbseganalyticsds.e2eautomationsales` |
| `APP_SECRET_PATH` | no | Defaults to the pre-prod IDPS path |
| `GENOS_ENDPOINT` | no | Override the GenOS target URL |
| `GENOS_EXPERIENCE_ID` | no | Override the GenOS experience registration |
| `LOG_LEVEL` | no | `DEBUG` / `INFO` (default `INFO`) |

## Running locally

```bash
cd src/relay_service

# Install deps (requires Intuit Artifactory on UV_DEFAULT_INDEX for idps-sdk)
uv sync

# Set required env vars
export APP_ENV=local
export ASSET_ID=<your numeric asset id>
export RELAY_API_KEY=dev-only-key

# Run
uv run uvicorn app.start:app --reload --port 8080
```

Health check: `curl http://localhost:8080/health/full`

Test proxy (replace key and payload):

```bash
curl -X POST http://localhost:8080/generate \
  -H "Content-Type: application/json" \
  -H "X-Relay-Api-Key: dev-only-key" \
  -d '{"messages":[{"role":"user","content":"ping"}],"temperature":0.1,"max_tokens":50}'
```

## Auth flow detail

1. **IDPS** — `idps_utils.get_app_secret()` calls `IdpsClientFactory` with the
   service's `policy_id` (or `asset_id` locally) to read the app secret at
   `managed-items/api-security/private-auth/preProd/appsecret`. Cached in
   process memory for the container's lifetime.

2. **Intuit Identity** — `_fetch_iam_ticket()` POSTs to
   `identityinternal-e2e.api.intuit.com` with a service-only header
   (`intuit_appid` + `intuit_app_secret`) and a test-user GraphQL mutation
   (standard pre-prod pattern used by agentfordashappv3 and siblings). Returns a
   `legacyAuthId` + `accessToken`. Cached with a 55-minute TTL.

3. **GenOS** — `_build_auth_header()` assembles the full PrivateAuth+ string:
   ```
   Intuit_IAM_Authentication intuit_appid='...',intuit_app_secret='...',
     intuit_token_type='IAM-Ticket',intuit_userid=...,intuit_token=...
   ```
   This format matches `get_auth_header()` in `agentfordashappv3/app/service/auth.py`.

## Error taxonomy

| HTTP status from relay | `error` field | Meaning |
|---|---|---|
| 502 | `idps_failure` | IDPS secret fetch or IAM ticket exchange failed |
| 4xx/5xx (from GenOS) | `genos_error` | GenOS returned a non-200; `detail` has the body |
| 504 | `network_error` | GenOS request timed out |
| 502 | `network_error` | Other network failure reaching GenOS |

Apps Script checks `resp.getResponseCode()` and falls back to the template
TLDR on any non-200.
