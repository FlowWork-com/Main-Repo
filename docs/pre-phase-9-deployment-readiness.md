# Pre-Phase 9 integration and deployment readiness

## Purpose and scope

This is a deployment gate for the **existing** FlowWork roles and integrations. It does not add, rename, or replace any repository role, and it does not turn ChatGPT, Codex, Claude, DeepSeek, Gemini, or Devin into new production runtime agents.

The repository currently has these relevant server-side paths:

- `plan-workflow`: the main planner, with one optional bounded FinNLP financial-review handoff and one planner revision.
- `execute-tool`: canonical tool dispatch and execution, including the configured invoice extractor and registered FinNLP tools.
- `advance-plan-run`: bounded durable plan-run worker.
- `finnlp-integration`: authenticated workspace/member-scoped Finnhub credential connection.
- `google-workspace`: Google OAuth connection and server-side secret storage.

This document is a runbook, **not evidence that a production deployment has occurred**. The repository integration available for this review cannot read Supabase project secrets or prove that a deployed environment is healthy. Record real results from the target staging project before lifting the Phase 9 hold.

## 1. Preflight: repository and project

- [ ] Confirm the intended commit is on `main`; capture its SHA.
- [ ] Confirm required GitHub checks passed on that exact SHA, including frontend/type checks, unit tests, offline planner evaluation, Edge Function tests, database/RLS tests, container build, and security scan.
- [ ] Confirm the Supabase project reference and environment (staging first). Never run production migrations while targeting a staging or local project by mistake.
- [ ] Confirm a recent database backup/recovery point and a named operator responsible for rollback.
- [ ] Confirm the frontend hosting environment uses the matching Supabase project URL and **public anon key only**.
- [ ] Confirm the exact production frontend origin(s) for `APP_ORIGINS`; do not leave local origins as the effective hosted allowlist.
- [ ] Confirm there are no unreviewed schema migrations or unexpected changes between the tested commit and the release commit.

## 2. Server-side configuration inventory

Set custom values as Supabase Edge Function secrets, or confirm them in the target project's secret manager. Do not print secret values into logs, CI output, chat, or PRs. Use a private, untracked environment file only if using the CLI's supported env-file workflow.

### Platform/runtime configuration

| Variable | Required for | Deployment rule |
|---|---|---|
| `APP_ORIGINS` | All browser-facing Edge Functions using the shared origin parser | Comma-separated exact HTTPS origins for the deployed frontend; no paths or wildcard origins. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Edge Functions that use Supabase clients | Confirm the platform-provided values are present and belong to the intended project. The service-role key is server-only and must never be exposed to the browser. |

### Main planner

- [ ] `FLOWWORK_PLANNER_PROVIDER=openai-compatible`
- [ ] `FLOWWORK_PLANNER_BASE_URL=https://api.groq.com/openai/v1` (selected staging profile; use only the trusted HTTPS Groq endpoint)
- [ ] `FLOWWORK_PLANNER_MODEL=openai/gpt-oss-120b`
- [ ] `FLOWWORK_PLANNER_API_KEY=<server-side-secret>`
- [ ] Do not enable `FLOWWORK_PLANNER_ALLOW_MOCK=true` in staging acceptance or production.

### FinNLP reviewer

- [ ] `FLOWWORK_FINNLP_REVIEW_PROVIDER=openai-compatible`
- [ ] `FLOWWORK_FINNLP_REVIEW_BASE_URL=https://api.groq.com/openai/v1` (selected staging profile; use only the trusted HTTPS Groq endpoint)
- [ ] `FLOWWORK_FINNLP_REVIEW_MODEL=qwen/qwen3.8-27b`
- [ ] `FLOWWORK_FINNLP_REVIEW_API_KEY=<server-side-secret>`

FinNLP is a verifier/financial-language decoder, not the main planner, not an authorization authority, and not a source of truth without independent evidence. Preserve the one-review/one-revision bound. Groq currently lists `qwen/qwen3.8-27b` as a preview model; keep this profile staging-only until a production-listed model passes the same strict-schema contract and evaluation. See [Groq supported models](https://console.groq.com/docs/models) and [Strict Structured Outputs](https://console.groq.com/docs/structured-outputs).

### Invoice extraction

- [ ] `FLOWWORK_INVOICE_PROVIDER=openai-compatible`
- [ ] `FLOWWORK_INVOICE_BASE_URL=<separate validated provider endpoint>`
- [ ] `FLOWWORK_INVOICE_MODEL=<approved-vision-model-id>`
- [ ] `FLOWWORK_INVOICE_API_KEY=<separate server-side secret>`

The selected Groq key configures only the planner and FinNLP reviewer in this staging profile. Do not reuse it for invoice extraction or point the current invoice adapter at Groq until an explicit provider adapter and PDF/image fixture-based contract tests pass. Do not enable Gemini by changing only this base URL; Gemini also requires an explicit provider adapter and fixture-based contract tests.

### Optional integrations

Google Workspace, only if enabled for this release:

- [ ] `FLOWWORK_GOOGLE_CLIENT_ID`
- [ ] `FLOWWORK_GOOGLE_CLIENT_SECRET`
- [ ] `FLOWWORK_GOOGLE_REDIRECT_URI` exactly matches the Google OAuth client registration and the deployed `google-workspace` function URL.
- [ ] `FLOWWORK_GOOGLE_APP_REDIRECT_URL` is the trusted HTTPS frontend origin/path expected by the OAuth handler.

Finnhub is connected per workspace/member through the authenticated `finnlp-integration` flow. Do not substitute a global browser-side Finnhub key. Validate connection, replacement, and disconnect behavior using a test workspace.

## 3. Migration and Edge Function deployment

### Recommended gated GitHub Actions deployment

Use `.github/workflows/deploy-supabase-staging.yml` from the `main` branch only. Before dispatching it:

1. Create a GitHub Actions environment named `staging` and configure required reviewers/environment protection.
2. Add the environment variable `SUPABASE_STAGING_PROJECT_REF` with the approved staging project's 20-character reference.
3. Add environment secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`. Never print or commit their values.
4. Configure the provider and integration secrets in the **staging Supabase project's secret manager**. At minimum, configure `APP_ORIGINS`, the planner provider/model/base URL/API key, the FinNLP reviewer provider/model/base URL/API key, and the invoice provider/model/base URL/API key. Add the Google OAuth variables only if Google Workspace is in scope.
5. Confirm a recent recovery point/backup, confirm the project reference identifies staging (not production or Invoice DB), and confirm CI passed for the exact `main` commit.
6. Run **Actions → Deploy Supabase staging**, keep Google Workspace disabled unless it is in scope, and select `yes` for the explicit deployment confirmation.

The workflow verifies successful `Frontend CI` on the exact commit, displays the migration list and dry-run plan, applies repository migrations without seed data, deploys `plan-workflow`, `execute-tool`, `advance-plan-run`, and `finnlp-integration`, and deploys `google-workspace` only when explicitly selected. It is manual-only, runs against the configured staging environment, excludes the separate Invoice DB reference, and does not set or print provider secret values.

A deployment run is not a successful release by itself: execute the live acceptance tests in section 4 and record the evidence before lifting the Phase 9 hold.

### Manual CLI fallback

Run these commands from a clean checkout after confirming the project reference. Replace the placeholder locally; never commit the project reference if it is sensitive for your deployment process.

```sh
npx supabase login
npx supabase link --project-ref <STAGING_PROJECT_REF>

# Review the pending migrations and target project before applying.
npx supabase migration list
npx supabase db push

# Deploy the existing functions; do not introduce a new function/role for this gate.
npx supabase functions deploy plan-workflow
npx supabase functions deploy execute-tool
npx supabase functions deploy advance-plan-run
npx supabase functions deploy finnlp-integration
npx supabase functions deploy google-workspace
```

Deploy `google-workspace` only if the integration is in scope for the release. Apply the repository's normal migration review and backup process before `db push`. Do not manually edit production tables to force a green check.

After configuring secrets, verify **names/presence only** through the project's secret manager or the CLI's secret listing; never echo values. Ensure the intended server-side secret set is available to the relevant Edge Functions. The code intentionally fails closed for missing planner/reviewer/invoice provider configuration.

## 4. Staging acceptance tests

Use synthetic goals, a dedicated test workspace, and non-sensitive invoice fixtures. Never use a real customer's private invoice as a smoke-test payload.

| Check | Expected result | Evidence to record |
|---|---|---|
| Planner — ordinary goal | Authenticated member receives a schema-valid plan using only registered tool IDs/versions; missing config fails with a sanitized setup error. | Pass/fail, commit SHA, configured model ID, latency, sanitized error code if failed. |
| Planner + FinNLP — financial ambiguity | Exactly one FinNLP review and at most one planner revision; ambiguity/missing period/currency/accounting basis is surfaced. Without independent sources, the result must not claim factual verification. | Review invoked count, revision count, limitation/clarification result, latency and usage. |
| FinNLP evidence handling | Only source IDs actually supplied by the tool are accepted; untrusted snippets are labelled as unverified; timeout/malformed/provider errors do not leak keys or raw provider bodies. | Test case IDs, pass/fail, sanitized failure code. |
| Invoice extraction | Existing approval gate is required; known fixture returns structured fields; absent/ambiguous values remain null or low-confidence and never auto-approve a workflow action. | Fixture ID, field-level score, latency and usage; no invoice contents in logs. |
| Finnhub integration | Authenticated workspace member can connect, retrieve bounded/sanitized company-news records (or an honest empty result), replace, and disconnect; another workspace cannot access the connection. | Test workspace IDs only where safe, pass/fail, sanitized result count. |
| Google OAuth (if enabled) | Redirect URI matches exactly; state is single-use/expiring; token material remains server-side; non-members cannot access the connection. | OAuth flow pass/fail, no tokens or authorization codes in evidence. |
| Plan-run safety | A user starts an accepted plan; dependencies gate step claims; worker processes at most one bounded step per invocation; failures/ambiguous side effects pause for review and are not automatically replayed. | Run/step IDs, transition outcomes, pause reason, sanitized event timeline. |
| Authorization and RLS | Unauthenticated requests fail; cross-workspace requests fail; privileged RPCs remain service-role-only; no client can bypass approvals or write execution/evidence state directly. | Existing database/RLS test results plus staging negative-test outcomes. |
| Observability | Provider/model ID, request outcome, latency and available usage/cost are captured without secrets, raw private payloads, or unsupported accuracy claims. | A sanitized per-path run record and usage snapshot. |

For live tests, record whether usage/cost was returned by the provider or estimated; do not invent a cost value when usage data is unavailable. CI mocks are useful regression evidence but do not count as a live-provider smoke test.

## 5. Release and rollback gate

Do not lift the Phase 9 hold until all required staging checks pass and the release owner records the evidence. Any failed or unrun check is a blocker, not an implicit pass.

- [ ] Required CI is green on the release SHA.
- [ ] Migrations and deployed function versions are confirmed against the same release SHA.
- [ ] Provider configuration is confirmed without exposing secret values.
- [ ] Planner, FinNLP, and invoice paths pass live staging tests.
- [ ] Finnhub passes connection/authorization and bounded-data tests.
- [ ] Google OAuth passes if it is part of this release.
- [ ] Run/step recovery, RLS, approvals, and cross-workspace denial tests pass.
- [ ] Monitoring/usage evidence is recorded and the release owner explicitly signs off.

If a smoke test fails, stop rollout. Revert the affected Edge Function to the last known-good code where supported, disable the affected optional integration if that is a safe supported configuration, and preserve run/step/evidence history for investigation. Treat database migrations as forward-only unless a reviewed rollback migration exists; do not assume reverting application code reverses a schema change. For ambiguous external side effects, reconcile the real-world result before retrying anything.

## 6. Phase boundary and AI-provider scope

This gate deploys only the current runtime paths. OpenAI remains assigned to the existing planner, FinNLP reviewer, and invoice extractor. ChatGPT/Codex/Claude/DeepSeek/Devin remain engineering checkpoints as documented in the AI roster. Gemini remains a future candidate for the existing invoice-extraction path only, after a dedicated adapter and evaluation.

No new runtime roles, recursive multi-model debate, autonomous approvals, or provider expansion are part of this deployment. Phase 9+ feature work remains on hold until the gate above is evidenced.
