# Phase 9 Reliability and Production-Readiness Audit

**Audit date:** 2026-10-28  
**Repository:** `FlowWork-com/Main-Repo`  
**Supabase project:** `nhvmeahmwywhaxtnuehr` (`FlowWork Main DB`)  
**Scope:** reliability events, structured logging, database/RLS authorization, security advisories, recovery, performance, privacy, and release evidence.

This is an evidence-based audit, not a production-readiness certification. A successful smoke run or green CI does not replace checks marked **Failed**, **Partially verified**, or **Not verified**.

## Evidence captured

- The authenticated staging E2E smoke passed in [run 40684325233](https://github.com/FlowWork-com/Main-Repo/actions/runs/40684325233) against `cafceffe3171a9e1c7991c631d9f21bcf25763f0`. It verified authenticated user and workspace/task RLS access, the live planner → FinNLP review → planner refinement path, persisted a `proposed` plan, and confirmed no plan acceptance or tool execution occurred.
- CI passed on `main` at `80f4dd8e4229e99b875e32c81faa1f50fcefdbae` in [run 40684665434](https://github.com/FlowWork-com/Main-Repo/actions/runs/40684665434), including typecheck, lint, unit tests, offline planner evaluation, build, Edge Function checks, local database/RLS tests, and container scan.
- PR #65 added request-level Edge Function observability. Its first post-merge CI run failed because Vitest attempted to load a Deno test file with a remote `https:` import. PR #66 fixed the issue by moving the helper test to Deno's `*_test.ts` convention and explicitly running it from Edge Function CI. PR #66 is merged at `0efe418d7047f32a0c2231d191b0b6f17aadd35e`; its validation passed in [run 40727101406](https://github.com/FlowWork-com/Main-Repo/actions/runs/40727101406).
- Supabase reported the project as `ACTIVE_HEALTHY`, running PostgreSQL 17, with 21 repository migrations applied.
- Read-only catalog/privilege checks confirmed that `anon` and `authenticated` have no table privileges on `public.google_workspace_oauth_states` or `public.workspace_finnlp_connections`; `service_role` has the access required by the Edge Functions.
- A read-only database ACL check found zero public `SECURITY DEFINER` functions executable by `anon` (including through `PUBLIC` execute grants) and zero public `SECURITY DEFINER` functions without a pinned `search_path`. The Supabase adviser reports 14 functions executable by `authenticated`. These are intentional workflow RPCs in the current design; they must retain their in-function authentication, workspace membership, and resource authorization checks. The new pgTAP test locks down the main grant invariants, but it is not a substitute for reviewing every RPC body when changing one.
- The previous successful CI and smoke runs predate the observability entrypoint wrapper. Staging must be rerun against the exact post-fix release commit before production deployment. Do not use the earlier smoke as proof that the newly instrumented deployment is live.

## Audit categories

| Category | Status | Evidence / remaining work |
|---|---|---|
| Planner + FinNLP staging path | **Passed for the recorded run** | See smoke run above. Capture a new run against the release SHA and record the configured model IDs, latency, and provider-returned usage if available. |
| CI, offline planner evaluation, DB/RLS tests, container scan | **Passed on the merged CI-fix commit** | [Run 40727101406](https://github.com/FlowWork-com/Main-Repo/actions/runs/40727101406) passed typecheck, lint, tests, offline planner evaluation, build, Edge Function checks, local database lint, migration/RLS tests, and container scan. The earlier PR #65 regression was fixed in merged PR #66. |
| Service-role-only OAuth/FinNLP metadata | **Passed in privilege checks** | No direct `anon`/authenticated table privileges. The advisor's “RLS enabled, no policy” informational finding is expected for these server-only tables, and existing tests deny client reads/writes. The new pgTAP test preserves that contract. |
| SECURITY DEFINER grants and search paths | **Passed for checked invariants; function-by-function audit remains ongoing** | No anon-executable public definer functions and all inspected public definer functions pin their search path. Fourteen authenticated-callable functions remain; don't blanket-revoke them. Keep workspace/resource checks and negative tests when modifying any of these RPCs. |
| Request-level observability | **Implemented and CI-validated in merged PRs #65/#66** | Each request gets an `x-request-id` and a structured completion event with timestamp, function name, method, status, outcome, duration, and optional fixed-format error code. Request/response payloads, query values, auth headers, workspace IDs, and raw exceptions are not logged. Staging must still exercise the instrumented deployment. |
| Durable provider usage/cost metrics | **Not verified / incomplete** | Provider/model ID, token usage, cost, retry counts, and latency are not consistently stored as a durable time series. Record costs only when supplied by provider usage or a clearly-labelled estimate; never invent a measured cost or accuracy score. |
| Supabase Auth leaked-password protection | **Deferred / plan-gated security limitation** | The project is on Supabase Free and the dashboard does not make leaked-password protection available. Do not attempt to bypass the plan restriction. Revisit after an upgrade or when an approved alternative is available; until then, keep this limitation visible in release risk acceptance. See the [Supabase guide](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). |
| Foreign-key indexes | **Failed / follow-up migration required** | The performance adviser reports 20 foreign keys without covering indexes. Add a reviewed migration with the Supabase CLI migration generator, check existing overlapping indexes first, run local database lint and pgTAP, and compare query plans. No live DDL was run for this audit. |
| RLS initplan optimization | **Failed / follow-up migration required** | The adviser flags two policies: `task_files` / `uploaders can remove their task file metadata` and `workspace_google_connections` / `users can read their own workspace google connection`. Rewrite `auth.uid()` as `(select auth.uid())` in a reviewed forward-only migration, then rerun advisors and RLS tests. |
| Unused indexes | **Not verified for removal** | The adviser reports 12 indexes as unused. A relatively new or quiet deployment may not have exercised them; remove none without workload/query-plan evidence. |
| Alerts and SLO thresholds | **Not verified / incomplete** | No approved SLOs or alert thresholds were found in source. Propose thresholds for repeated provider failure, stuck leases, queue backlog, expired leases, and unusual error rates; label them proposed until the release owner approves them. |
| Retention and privacy policy | **Not verified / incomplete** | Confirm retention/deletion periods for plans, outputs, events, OAuth metadata, evidence, and request logs. Keep request logs metadata-only and avoid blanket collection of business content. |
| Recovery runbook | **Partially passed** | `docs/execution-recovery.md` covers stale tool executions and plan-run recovery. Validate recovery using synthetic staging data; an ambiguous timeout must remain paused until external effects are reconciled. |
| Invoice extraction live acceptance | **Not verified** | The authenticated smoke intentionally does not process an invoice fixture. Test a synthetic PDF/image through the normal approval gate. Groq has not been enabled for invoice extraction. |
| Finnhub integration live lifecycle | **Not verified** | The smoke confirmed a correctly scoped “not connected” status, not a real test credential's connect/read/replace/disconnect lifecycle. Test using a dedicated staging workspace and avoid logging the key. |
| Google OAuth live acceptance | **Not verified** | Verify OAuth callback/state/PKCE, refresh and revoke/disconnect, minimum scopes, and cross-workspace isolation using a dedicated test client. Never put tokens or authorization codes in logs. |
| Staging deployment / rollback | **Partially passed** | The gated deploy workflow and runbook exist. For each release, record the target project/environment, backup or recovery point, exact deployment SHA, deployed function versions, secret presence (never values), and named rollback owner. |

## Operational response checklist

1. **Provider outage:** search logs by `x-request-id`; use the fixed error code and duration for diagnosis. Never paste provider credentials, raw provider bodies, query parameters, or invoice contents into incident notes.
2. **Stuck plan run/step:** follow [Execution recovery](execution-recovery.md). Assume a timed-out non-idempotent action may have happened externally until reconciled; do not mint a new execution identity merely to retry.
3. **Credential exposure:** revoke the affected Groq/OAuth/Finnhub credential, rotate it in its server-side secret manager, verify no values appeared in logs, then rerun safe staging checks.
4. **Database or migration failure:** stop deployment, compare applied migration versions with the tested commit, restore from the approved recovery point if required, and use a reviewed forward fix. Do not rewrite workflow history.
5. **Security adviser finding:** verify actual grants, RLS behavior, function ACL/search path, in-function authorization, and negative tests before changing a policy. A warning alone is not proof of exploitability.

## Remaining release blockers

- **Deferred by decision:** leaked-password protection is unavailable on the current Supabase Free plan. Record explicit risk acceptance for releases where it remains unavailable, and revisit on plan upgrade; do not treat this item as resolved.
- Review and add the 20 missing foreign-key indexes and fix the two RLS initplan expressions through reviewed, generated migrations.
- Pass CI on the current observability follow-up and rerun staging smoke against the exact post-fix release commit.
- Capture live invoice extraction acceptance and the Finnhub connection lifecycle; validate Google OAuth if included in the release.
- Decide and document initial alert thresholds, data-retention policy, and incident owner.
- Record provider/model/latency and provider-returned usage/cost for each relevant path without claiming unmeasured accuracy.

**Phase 9 is not complete while the remaining verification and performance work is open.** Leaked-password protection is deferred due to the current plan limitation and remains an explicit security risk, not a passed control. No live database schema, Auth setting, or provider secret was changed by this audit.
