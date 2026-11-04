# Phase 9 Operational Controls — Proposal

**Status:** proposal for release-owner review; not approved policy  
**Scope:** service-level indicators, alert thresholds, data retention, and live integration acceptance  
**Important:** this document does not configure an alert provider, delete data, alter retention settings, or imply that any live integration has passed.

## 1. Alert and SLO proposal

Use the structured edge_request_finished events added by the request observability helper as the starting point. They include request ID, function, HTTP status/outcome, duration, and a bounded error code. The events intentionally omit request bodies, response bodies, auth headers, query parameters, workspace IDs, and raw exceptions.

These thresholds are initial candidates for a low-volume staging deployment. They should be tuned against real traffic before they become production SLOs; when traffic is too low, use consecutive failures and absolute stuck-work counts rather than percentage-only alerts.

**Implementation preparation checked 2026-11-04:** the durable, payload-free provider-call records are merged in code and can supply provider/stage/outcome/latency and returned usage where available, but they have not yet been confirmed live in FlowWork Staging. No alert backend, query, notification destination, schedule, or threshold has been configured or activated. After owner approval, choose the alert backend and validate its signals in staging before enabling notifications.

| Signal | Proposed trigger | Response |
|---|---|---|
| Edge Function server errors | At least 20 requests and more than 5% 5xx over 5 minutes; page/escalate if above 10% for 10 minutes | Group by function, outcome and bounded error code; investigate provider outage vs application fault |
| Provider failures | Three consecutive failures for the same configured provider/model, or a 10% failure rate with at least 20 calls in 10 minutes | Verify provider status/quota and configuration; do not log credentials or raw provider responses |
| Planner latency | p95 duration exceeds twice the rolling 7-day baseline for 15 minutes with at least 20 calls | Separate planner, FinNLP review and provider timings before changing model assignments |
| Stuck plan run | A run/step remains active beyond its recorded lease expiry plus 5 minutes | Follow docs/execution-recovery.md; reconcile external effects before retrying an ambiguous tool operation |
| Expired execution leases | Any unexplained expired lease remains unreconciled for more than 10 minutes | Inspect run/step history and idempotency identity; do not mint a new execution to force a retry |
| Secret cleanup pending | Any credentialCleanupPending result remains unresolved after 15 minutes | Retry cleanup under privileged server credentials and record only a fixed error code |
| Database/resource pressure | Sustained usage above 80% of a plan/resource limit for 15 minutes; critical at 90% | Check current Supabase usage and adviser findings before capacity or index changes |
| Unexpected auth/RLS failures | A sustained rise in 401/403 or 42501 errors relative to the 7-day baseline | Distinguish expected authorization denials from regressions; never weaken RLS solely to reduce alerts |

**Proposed service objectives for owner discussion:**
- At least 99% of valid, non-caller-error Edge Function requests complete without an application-side 5xx over a rolling 30-day window.
- At least 99% of eligible plan-run steps reach a terminal state or a documented waiting-for-approval state within 5 minutes of their scheduled execution time, excluding external provider outages and explicit user pauses.
- 100% of high-risk tool executions have a persisted approval record before execution; this is a safety invariant, not an availability target.
- 100% of logged request events remain metadata-only and free of raw credentials, auth material, invoice contents, and unredacted provider responses.

Before adopting the availability objectives, define how provider outages, client errors, cancellations, user approval waits, and maintenance windows are excluded. A successful test run alone is not a production SLO measurement.

## 2. Data retention proposal

The following are candidate defaults for review, not current settings. The release owner and the relevant privacy/legal stakeholder must approve the periods and any jurisdiction/customer-specific requirements before implementation. Deletion must be tested in staging and must account for backups and replicas.

| Data class | Proposed default | Required behavior / caveat |
|---|---|---|
| Edge request logs | 30 days | Metadata-only; no request/response payloads, query values, authorization headers, raw exception messages, invoice contents, or tokens |
| Expired OAuth state and transient PKCE material | Expire at the existing flow TTL; clean orphaned state/secrets within 24 hours | The authorization state is single-use and short-lived. Ensure failure/expiry cleanup is idempotent and does not expose a verifier |
| Connected provider credentials | Until user disconnects or the credential is revoked | On disconnect, remove the connection row and secret; alert on failed cleanup and retry safely |
| Completed invoice extraction output and uploaded document | 90 days after task completion, unless the user deletes it sooner or an approved business policy requires a shorter period | Treat documents and extracted fields as sensitive business data; do not retain provider prompts/responses by default |
| Workflow plans, execution results, and event history | 180 days after task completion | Preserve minimal audit metadata needed to explain approvals and execution outcomes; confirm whether longer audit retention is required |
| User/workspace deletion | Trigger deletion or de-identification of app-managed data according to an approved deletion workflow | Document cascading effects, Vault cleanup, storage objects, and backup expiry; never claim that backups are purged immediately without proof |
| Database backups and provider-side logs | Governed by configured Supabase/provider settings and contractual terms | Record the actual configured retention separately; an application purge does not guarantee backup/provider-log deletion |

Do not implement these candidates in a migration until the data owner approves them. Where retention applies to financial records, contractual evidence or statutory records, the approved schedule may differ.

**Implementation preparation checked 2026-11-04:** no TTL, scheduled purge, or retention migration has been added. The provider-call metric table exists in code and has relational cleanup when its task is deleted, but that is not a retention schedule and it has not yet been proven live in FlowWork Staging. After approval, specify retention and backup treatment, implement an auditable staging-only deletion path, and test it before production use.

## 3. Live acceptance evidence required before production

Automated mocked provider tests establish request construction and error handling; they do not prove that the production secrets, provider account, OAuth consent screen, or live provider behavior are configured correctly.

### Invoice extraction
- Use a synthetic invoice fixture with no real customer or supplier data.
- Verify the configured provider/model accepts the current PDF file-part format and image payload format.
- Execute only through the existing high-risk approval gate; assert no provider request occurs before persisted approval.
- Check field-level output, absent/low-confidence values, arithmetic mismatch warnings, reviewRequired: true, and human-review status.
- Verify provider usage metadata if returned, but never infer a measured accuracy score from the model-reported confidence estimate.
- Confirm the original invoice bytes, API key, raw provider response, and prompt are not emitted into logs.

### Finnhub connection lifecycle
- Use a dedicated staging workspace and a valid test credential supplied through the normal UI flow.
- Verify connect validates the key before saving it, status reveals no credential/secret reference, a real company-news request returns bounded data, replacement is scoped to that workspace/member, and disconnect removes the connection and secret.
- Verify rejected keys, throttling, provider outage, and secret-cleanup failure fail closed and produce only bounded error codes in logs.
- Do not paste the key in GitHub, chat, workflow inputs, screenshots, or incident logs.

### Google OAuth lifecycle
- Use a dedicated test OAuth client and account, not a personal or production user account.
- Verify callback state is single-use, PKCE is enforced, requested scopes are minimal, refresh works, cross-workspace access is denied, and disconnect removes the connection and associated Vault secret.
- Exercise revoked consent and cleanup failure; resolve any pending secret cleanup.
- If Gmail access is in scope, test its separate explicit read-only consent independently from Drive.
- Never store authorization codes, tokens, client secrets or sensitive provider bodies in test artifacts.

### Release smoke and rollback
- Rerun the authenticated staging smoke on the exact post-merge release SHA; record the SHA, workflow run, configured model IDs, outcomes, latency and provider-returned usage where available.
- Verify the plan remains proposed and no tool executes before explicit persisted approval.
- Record deployed Edge Function revisions, required secret presence (never values), recovery point, rollback owner, and result.
- Do not use the earlier smoke run from before the observability wrapper as acceptance evidence for a newer release.

## 4. Sign-off record

Before calling Phase 9 complete, fill in:
- **Release owner:** pending
- **Operational/on-call owner:** pending
- **SLO/alert thresholds approved on:** pending
- **Retention schedule and deletion behavior approved on:** pending
- **Live invoice extraction run:** pending
- **Live Finnhub lifecycle run:** not verified — the smoke returned a scoped `not connected` status; no real credential lifecycle or news retrieval was run.
- **Live Google OAuth run:** not verified — optional Google Workspace deployment was skipped in the staging deployment; decide explicitly whether it is excluded from the release.
- **Post-merge staging smoke run and exact SHA:** PASS — [run 41440975402](https://github.com/FlowWork-com/Main-Repo/actions/runs/41440975402), commit `01ee69894894c8e8c246138bcb2ab4d1f4e41b8d`. The live planner + one FinNLP review/refinement pass persisted plan `088861d6-8492-48f4-94d1-ac47ad8bcaf0` (valid, proposed); no run or tool execution was created. The planner Edge Function completed in 8,334 ms. Provider model ID and provider-returned usage/cost were not captured.
- **Known risk acceptance for Free-plan leaked-password protection:** must remain explicit until the control is enabled or an approved mitigation replaces it

Repository regression PRs #88 and #89 are merged, but their tests do not satisfy these live acceptance or owner-signoff fields. The current repo view in this checkout shows no open PRs; any stale PR references should be treated as historical notes rather than active work. A fresh staging deployment is still required before provider metrics or any other live acceptance can be treated as confirmed.

No alerting, retention behavior, provider credentials, or production database settings are changed by this proposal.
