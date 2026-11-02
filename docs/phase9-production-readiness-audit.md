# Phase 9 Reliability and Production-Readiness Audit

**Audit date:** 2026-10-28  
**Repository:** `FlowWork-com/Main-Repo`  
**Supabase project:** `nhvmeahmwywhaxtnuehr` (`FlowWork Main DB`)  
**Scope:** reliability events, structured logging, database/RLS authorization, security advisories, recovery, performance, privacy, and release evidence.

This is an evidence-based audit, not a production-readiness certification. A successful smoke run or green CI does not replace checks marked **Failed**, **Partially verified**, or **Not verified**.

## Evidence captured

- The historical authenticated E2E smoke completed in [run 40684325233](https://github.com/FlowWork-com/Main-Repo/actions/runs/40684325233) against `cafceffe3171a9e1c7991c631d9f21bcf25763f0`, verifying authenticated access, the live planner → FinNLP review → planner refinement path, a persisted `proposed` plan, and no tool execution. However, the configured project reference `nhvmeahmwywhaxtnuehr` is FlowWork Main DB, which the dashboard labels **PRODUCTION**. Treat that run as a primary-project integration check, not evidence of environment isolation or a safe staging deployment. The connected organization currently exposes no separate staging project; a dedicated target is a blocking prerequisite for another smoke run.
- CI passed on `main` at `80f4dd8e4229e99b875e32c81faa1f50fcefdbae` in [run 40684665434](https://github.com/FlowWork-com/Main-Repo/actions/runs/40684665434), including typecheck, lint, unit tests, offline planner evaluation, build, Edge Function checks, local database/RLS tests, and container scan.
- PR #65 added request-level Edge Function observability. Its first post-merge CI run failed because Vitest attempted to load a Deno test file with a remote `https:` import. PR #66 fixed the issue by moving the helper test to Deno's `*_test.ts` convention and explicitly running it from Edge Function CI. PR #66 is merged at `0efe418d7047f32a0c2231d191b0b6f17aadd35e`; its validation passed in [run 40727101406](https://github.com/FlowWork-com/Main-Repo/actions/runs/40727101406).
- Supabase reported the project as `ACTIVE_HEALTHY`, running PostgreSQL 17, with 21 repository migrations applied.
- The live Edge Function inventory for FlowWork Main DB was checked on 2026-10-28. `plan-workflow` v31 pins source commit `18c3a35764d79ee9876ee771f7022910decd2e3b`; `execute-tool` v29, `advance-plan-run` v29 and `finnlp-integration` v28 pin `c3325c58eb8bd5cfa2223ab4c446a8c8a4afb7a6`. The deployed entrypoint source at those commits does not include the request-observability wrapper added in PR #65/#66. `google-workspace` is absent from this project's deployed function inventory. These are production deployment facts, not staging acceptance; do not deploy to this project as a staging workaround.
- A read-only check of the synthetic task configured in the historical smoke script found 3 proposed plan rows (versions 1–3), 0 workflow-plan runs, and 0 tool executions. The plans are consistent with repeated smoke runs against the production project. They were left intact; deleting test artifacts from production requires an explicit owner decision and approved cleanup procedure.
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
| Request-level observability | **Implemented in repo; not deployed to inspected runtime** | PRs #65/#66 add `x-request-id` and metadata-only completion events. The live Main DB inventory still pins earlier source commits for the four deployed core functions; their entrypoints do not include the wrapper. Deploy only to a distinct staging project after environment isolation is established, then verify request IDs and log shape there. |
| Durable provider usage/cost metrics | **Not verified / incomplete** | Provider/model ID, token usage, cost, retry counts, and latency are not consistently stored as a durable time series. Record costs only when supplied by provider usage or a clearly-labelled estimate; never invent a measured cost or accuracy score. |
| Supabase Auth leaked-password protection | **Deferred / plan-gated security limitation** | The project is on Supabase Free and the dashboard does not make leaked-password protection available. Do not attempt to bypass the plan restriction. Revisit after an upgrade or when an approved alternative is available; until then, keep this limitation visible in release risk acceptance. See the [Supabase guide](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). |
| Foreign-key indexes | **Failed / follow-up migration required** | The performance adviser reports 20 foreign keys without covering indexes. Add a reviewed migration with the Supabase CLI migration generator, check existing overlapping indexes first, run local database lint and pgTAP, and compare query plans. No live DDL was run for this audit. |
| RLS initplan optimization | **Failed / follow-up migration required** | The adviser flags two policies: `task_files` / `uploaders can remove their task file metadata` and `workspace_google_connections` / `users can read their own workspace google connection`. Rewrite `auth.uid()` as `(select auth.uid())` in a reviewed forward-only migration, then rerun advisors and RLS tests. |
| Unused indexes | **Not verified for removal** | The adviser reports 12 indexes as unused. A relatively new or quiet deployment may not have exercised them; remove none without workload/query-plan evidence. |
| Alerts and SLO thresholds | **Proposal documented; approval/implementation pending** | Candidate thresholds and service objectives are recorded in [Phase 9 operational controls proposal](phase9-operational-controls-proposal.md). No alert provider is configured by this document; release/on-call owners must approve thresholds and implement/test the alert path. |
| Retention and privacy policy | **Proposal documented; approval/implementation pending** | Candidate retention periods and deletion requirements are recorded in [Phase 9 operational controls proposal](phase9-operational-controls-proposal.md). The durations are proposals only, not current settings; data owner and privacy/legal review are required before implementation. |
| Recovery runbook | **Partially passed** | `docs/execution-recovery.md` covers stale tool executions and plan-run recovery. Validate recovery using synthetic staging data; an ambiguous timeout must remain paused until external effects are reconciled. |
| Invoice extraction live acceptance | **Not verified** | The authenticated smoke intentionally does not process an invoice fixture. Test a synthetic PDF/image through the normal approval gate. Groq has not been enabled for invoice extraction. |
| Finnhub integration live lifecycle | **Not verified** | The smoke confirmed a correctly scoped “not connected” status, not a real test credential's connect/read/replace/disconnect lifecycle. Test using a dedicated staging workspace and avoid logging the key. |
| Google OAuth live acceptance | **Not verified** | Verify OAuth callback/state/PKCE, refresh and revoke/disconnect, minimum scopes, and cross-workspace isolation using a dedicated test client. Never put tokens or authorization codes in logs. |
| Staging deployment / rollback | **Blocked / no isolated staging target** | The connected organization currently lists FlowWork Main DB (dashboard-labelled PRODUCTION) and the separate Invoice DB, but no dedicated staging project. The prior smoke workflow was pointed at Main DB production. A separate project must be provisioned/identified; deployment and smoke workflows must reject the known production/invoice refs; then deploy and test the exact SHA with a recovery point and named rollback owner. No deployment is being run against either current project. |

## Operational response checklist

1. **Provider outage:** search logs by `x-request-id`; use the fixed error code and duration for diagnosis. Never paste provider credentials, raw provider bodies, query parameters, or invoice contents into incident notes.
2. **Stuck plan run/step:** follow [Execution recovery](execution-recovery.md). Assume a timed-out non-idempotent action may have happened externally until reconciled; do not mint a new execution identity merely to retry.
3. **Credential exposure:** revoke the affected Groq/OAuth/Finnhub credential, rotate it in its server-side secret manager, verify no values appeared in logs, then rerun safe staging checks.
4. **Database or migration failure:** stop deployment, compare applied migration versions with the tested commit, restore from the approved recovery point if required, and use a reviewed forward fix. Do not rewrite workflow history.
5. **Security adviser finding:** verify actual grants, RLS behavior, function ACL/search path, in-function authorization, and negative tests before changing a policy. A warning alone is not proof of exploitability.

## Remaining release blockers

- **Deferred by decision:** leaked-password protection is unavailable on the current Supabase Free plan. Record explicit risk acceptance for releases where it remains unavailable, and revisit on plan upgrade; do not treat this item as resolved.
- Review and add the 20 missing foreign-key indexes and fix the two RLS initplan expressions through reviewed, generated migrations.
- Pass CI on the current follow-ups; provision/identify a dedicated staging Supabase project; deploy the reviewed exact release commit there; rerun staging smoke and integration acceptance. Do not point the staging workflows at FlowWork Main DB production or Invoice DB.
- Capture live invoice extraction acceptance and the Finnhub connection lifecycle; validate Google OAuth if included in the release.
- Decide and document initial alert thresholds, data-retention policy, and incident owner.
- Record provider/model/latency and provider-returned usage/cost for each relevant path without claiming unmeasured accuracy.

**Phase 9 is not complete while the remaining verification and performance work is open.** Leaked-password protection is deferred due to the current plan limitation and remains an explicit security risk, not a passed control. No live database schema, Auth setting, or provider secret was changed by this audit.


---

## 2026-11-02 staging follow-up audit

**Environment:** dedicated FlowWork Staging project `flfwtsxuvzyuotltfrbt` (`eu-west-1`).  
**Release commit:** `01ee69894894c8e8c246138bcb2ab4d1f4e41b8d`.  
**Scope:** read-only catalog, privilege, policy, migration, Edge Function inventory and runtime smoke review. No production database, Auth setting, or schema was modified by this follow-up.

This section supersedes the 2026-10-28 audit's *staging target blocked* statement for the dedicated staging environment only. The earlier FlowWork Main DB observations remain a historical production snapshot; this follow-up did not repeat a production audit or deploy to production.

### Staging release evidence

- [Main CI #41310646015](https://github.com/FlowWork-com/Main-Repo/actions/runs/41310646015) passed for the release commit.
- [Staging deployment #41311253544](https://github.com/FlowWork-com/Main-Repo/actions/runs/41311253544) succeeded for the same commit. It passed the staging target guard, exact-commit CI gate, migration review/dry-run/application, four required Edge Function deployments, and deployed revision recording. The optional Google Workspace deploy input was false/skipped.
- [Authenticated staging smoke #41440975402](https://github.com/FlowWork-com/Main-Repo/actions/runs/41440975402) passed on the same commit. The live planner → one FinNLP reviewer handoff → one planner revision saved a valid proposed plan. The run was not accepted; no worker run or tool execution was created. The task remained in Planning.
- The smoke job explicitly passed unauthenticated rejection for all four required functions, test-user identity, workspace/RLS access, scoped FinNLP status, plan persistence, refusal to start a run before human acceptance, and rejection of a missing/unowned worker run. Its FinNLP integration-status check reported **not connected**; this validates the status endpoint, not a live Finnhub credential lifecycle.
- The dedicated staging database reports 22 applied repository migrations. The four required functions are ACTIVE: `plan-workflow` v8, `execute-tool` v6, `advance-plan-run` v6, and `finnlp-integration` v6. No production deployment is inferred from this evidence.

### Staging security review

| Control | 2026-11-02 staging result | Evidence / interpretation |
|---|---|---|
| Public-schema table RLS | **Passed** | All 18 base/partitioned tables in `public` have RLS enabled. |
| Client access to OAuth/FinNLP secret metadata | **Passed** | `google_workspace_oauth_states` and `workspace_finnlp_connections` have RLS enabled, no policies, and no direct table privileges for `anon` or `authenticated`; the trusted service role retains required access. The two “RLS enabled, no policy” advisor findings are expected for these server-only tables, not a reason to grant client access. |
| Public `SECURITY DEFINER` ACL and search paths | **Passed for reviewed invariants** | 29 public SECURITY DEFINER functions were inventoried; none are executable by `anon`, none have an unpinned `search_path`, and 14 are executable by `authenticated`. |
| Authenticated callable RPC authorization | **Reviewed; CI coverage being strengthened** | All 14 authenticated-callable SECURITY DEFINER functions derive caller identity from `auth.uid()`. Thirteen also call `is_workspace_member` or directly inspect `workspace_members`; `create_workspace` is the deliberate exception because it creates a new workspace for the authenticated caller and inserts that caller as owner. The reviewed bodies validate the task, plan, run, file, template, or workspace resource before changing it. No cross-workspace bypass was identified in this read-only review. A new pgTAP assertion pins the exact allowed RPC inventory and these caller/membership guard patterns. |
| Secret-management RPCs | **Passed** | Finnhub/Google secret read, write, connect, disconnect, and delete RPCs remain unavailable to `anon` and `authenticated`; their required execution grants are restricted to `service_role`. |
| Direct client table writes | **Passed for current grants** | No `anon` direct table insert/update/delete grants. `authenticated` has no direct insert/update grants and only the `task_files` metadata delete grant; its RLS predicate requires both `uploaded_by = auth.uid()` and current workspace membership. A pgTAP assertion now preserves this narrow exception. |
| Invoice summary views | **Passed** | `invoice_extraction_confidence_summary` and `invoice_extraction_feedback_summary` use `security_invoker=true`, so their queries execute with caller privileges and underlying RLS remains applicable. |
| Self-approval protection | **Passed in repository tests; not altered here** | The existing approval check constraint and workflow RLS tests reject requester self-approval. No approval was created or accepted by the staging smoke. |
| SECURITY DEFINER adviser warnings | **Reviewed, not blanket-revoked** | Supabase reports 14 authenticated-callable SECURITY DEFINER functions. These are the intended authenticated workflow RPC surface; blanket revocation would break supported flows. Keep the explicit inventory, internal caller/resource checks, and negative tests. |
| Leaked-password protection | **Deferred / still open** | The staging project reports the Auth leaked-password-protection warning. The account's current Supabase Free-plan limitation remains unresolved; do not bypass it or describe the control as passed. |
| RLS initplan optimization | **Passed in staging** | The two reviewed policies now use scalar-subquery `(select auth.uid())`; the current security adviser no longer reports the earlier initplan warnings. |
| Foreign-key support indexes | **Passed in staging** | A catalog check comparing every public foreign-key column sequence with valid, non-partial index leading columns returned zero uncovered public foreign keys. The 20-index migration is applied. |
| Unused indexes | **No removal justified** | The performance adviser currently reports 33 unused indexes. This is a new/low-traffic staging environment; usage counters are not sufficient evidence to drop them. No index was removed. |

### Updated Phase 9 status after staging recheck

| Category | Current status | Remaining evidence/work |
|---|---|---|
| Planner and FinNLP reviewer path | **Passed in staging** | Smoke #41440975402 proves live planning/reviewer/refinement and persisted proposal. Capture provider/model IDs, latency and provider-returned usage from a supported source before claiming durable cost/quality metrics. |
| CI, migrations, RLS tests and container scan | **Passed for release commit** | Main CI #41310646015 passed; deployment #41311253544 passed its exact-commit gate and reviewed migrations. New RPC inventory tests are in the follow-up PR and still require CI. |
| Request observability | **Deployed to staging; verification in progress** | The diagnostic logging fixed the signing-key configuration finding; the successful smoke proves the planner endpoint works. Review the exact current log envelope/request correlation and ensure no secrets or provider payloads are emitted before marking the log-redaction audit fully passed. |
| Database/RLS/SECURITY DEFINER review | **Passed for inspected staging scope; regression tests being strengthened** | The catalog and function-body checks above found no identified cross-workspace bypass. The new pgTAP coverage must pass local/CI validation and remain part of future DB tests. This is not a production database re-audit. |
| Recovery runbook | **Documented; live recovery acceptance not verified** | Run the documented stuck-run/expired-lease/ambiguous external-effect cases on synthetic staging data. Do not fabricate success or auto-replay ambiguous non-idempotent work. |
| Invoice extraction live acceptance | **Not verified** | The smoke deliberately does not upload/process an invoice. A synthetic PDF/image must pass through the existing persisted high-risk approval gate with the separately validated provider. Groq planner/reviewer configuration does not imply invoice-provider readiness. |
| Finnhub live connection lifecycle | **Not verified** | Staging status reports not connected. Still required: dedicated test credential connect/validate/read/replace/disconnect and secret cleanup, with no key in logs. |
| Google OAuth live lifecycle | **Not verified / optional release scope** | Google Workspace deploy was skipped in this release workflow. If included in release scope, use a dedicated test OAuth client/account to verify callback state, PKCE, minimal scopes, refresh, revoke/disconnect and cross-workspace denial. |
| Alerts/SLOs | **Proposal only; approval/implementation pending** | No alert provider or paging path was configured by the proposal. Release/on-call owner must approve thresholds, implement and test the path. |
| Retention/privacy | **Proposal only; approval/implementation pending** | Candidate durations are not configured policies. Data owner and privacy/legal review must approve schedules and deletion behavior before implementation. |
| Production operational ownership | **Not verified** | Name release, on-call and rollback owners; record recovery point, rollback/forward-fix procedure and production risk acceptance before any production deployment. |
| Leaked-password protection | **Open plan-gated risk** | Keep explicitly recorded in release risk acceptance until enabled or replaced by a formally approved control. |

### Current remaining blockers

1. Complete regression CI for the expanded SECURITY DEFINER/RLS grant tests.
2. Run synthetic staging recovery tests for stale tool execution, expired leases, user pause/cancel and ambiguous external effects.
3. Complete invoice extraction acceptance with a synthetic PDF/image and the persisted approval gate; do not reuse the Groq planner/reviewer key or assume PDF compatibility.
4. Complete Finnhub connection lifecycle acceptance with a dedicated staging key; status endpoint alone is insufficient.
5. Decide whether Google OAuth is in the release scope; if yes, complete the dedicated OAuth lifecycle test.
6. Approve/implement alerting, on-call ownership and the privacy/retention policy.
7. Record actual provider/model identity, latency and usage/cost where returned; do not invent costs or accuracy metrics.
8. Keep leaked-password protection as an explicit open risk under the current plan limitation.

**Phase 9 remains incomplete.** The staging planner/reviewer vertical slice and core access-control checks are now evidenced, but live invoice/Finnhub/OAuth acceptance, recovery exercises, operational sign-off, alerting, retention and the leaked-password control remain open. This staging follow-up does not authorize production deployment.
