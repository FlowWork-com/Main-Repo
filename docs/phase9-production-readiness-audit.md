# Phase 9 Reliability and Production-Readiness Audit

**Evidence refreshed:** 2026-11-02  
**Repository release commit tested:** `01ee69894894c8e8c246138bcb2ab4d1f4e41b8d`  
**Environment audited:** FlowWork Staging — `flfwtsxuvzyuotltfrbt` (`eu-west-1`)  
**Production boundary:** FlowWork Main DB `nhvmeahmwywhaxtnuehr` and Invoice DB `tlhznghnfdwpilhfjyyu` remain forbidden staging targets.

This is an evidence-based staging and security audit, **not a production-readiness certification**. A passing smoke run proves only the exercised path. Items marked failed, partially verified, proposed, or not verified remain open.

## Executive result

The authenticated staging planning vertical slice now passes against the reviewed main commit. The live planner and one FinNLP financial-language review/refinement pass persisted a valid proposed plan. The safety boundary also passed: the plan remained unaccepted, the task remained in `Planning`, the worker rejected a missing/unowned run, and no tool executed.

Phase 9 is **not complete**. The remaining gaps include dependency vulnerability triage, operational alerting and approved retention policy, full workflow-correlated metrics, live invoice extraction and optional integration acceptance, a deeper RPC/threat-model review, and the explicitly deferred leaked-password control.

## Evidence captured

### Release and staging deployment

- Main CI passed for release commit `01ee69894894c8e8c246138bcb2ab4d1f4e41b8d`: [run 41310646015](https://github.com/FlowWork-com/Main-Repo/actions/runs/41310646015).
- The reviewed commit deployed successfully to the dedicated FlowWork Staging project. Migration review, dry-run, migration application, required Edge Function deployment, and revision recording all passed: [deployment run 41311253544](https://github.com/FlowWork-com/Main-Repo/actions/runs/41311253544).
- The staging project reported `ACTIVE_HEALTHY`, PostgreSQL 17.11, region `eu-west-1`.
- The staging database reports 22 repository migrations applied, including `20261028170900_phase9_performance_indexes_rls_initplan`.
- Current live inventory on 2026-11-02: `plan-workflow` ACTIVE v8, `execute-tool` ACTIVE v6, `advance-plan-run` ACTIVE v6, `finnlp-integration` ACTIVE v6, and `google-workspace` ACTIVE v4. Google Workspace was not selected for the latest deployment workflow; its presence does not prove OAuth acceptance.

### Authenticated staging smoke

- The post-merge authenticated staging smoke passed: [run 41440975402](https://github.com/FlowWork-com/Main-Repo/actions/runs/41440975402), on the exact release commit above.
- Its log records successful checks for: unauthenticated rejection by all four required functions; test-user identity; workspace membership and RLS; authenticated FinNLP integration-status response; live planner plus one FinNLP review/refinement pass; rejection of starting a run before human acceptance; rejection of a missing/unowned worker run; and no tool execution.
- The successful proposed plan is `088861d6-8492-48f4-94d1-ac47ad8bcaf0`, version 1, validation status `valid`, decision `proposed`. Its task remains `Planning`.
- Read-only staging verification after the run found one proposed plan, zero plan runs, and zero tool executions for the synthetic task. The plan was not accepted and no execution was dispatched.
- The planner Edge Function emitted a metadata-only completion event with status 200 and duration 8,334 ms for the planner/review/refinement request. The provider model ID and provider-returned token/cost usage were not included in the acceptance evidence.
- The FinNLP integration-status endpoint returned a scoped `not connected` status. This smoke therefore did **not** test a real Finnhub connection or company-news retrieval.
- The signing-key configuration failure seen in earlier smoke run #9 was resolved by adding `FLOWWORK_PLAN_SIGNING_KEY` to the Edge Function secret set; the successful run proves the runtime can now sign and persist the proposal. Secret values were not read or recorded.

### Database, grants, RLS and performance checks

Read-only catalog checks on FlowWork Staging on 2026-11-02 reported:

- 18/18 public base tables have RLS enabled; no public base table is missing RLS.
- Two RLS-enabled tables have no policies: `google_workspace_oauth_states` and `workspace_finnlp_connections`. This is intentional server-only storage: `anon` and `authenticated` have no table privileges, while `service_role` has the required access. The `RLS Enabled No Policy` adviser finding is informational for this design, not a reason to add client policies.
- 29 public `SECURITY DEFINER` functions were found. None is executable by `anon`; every one has a function-level configuration that pins `search_path`. Fourteen are executable by `authenticated`, which is the source of the Supabase adviser warning. The workflow-facing RPCs are intentionally authenticated entry points; their in-function identity, membership, task/plan/run and state checks must remain covered by dedicated tests. Server-side secret-management and worker-claim RPCs remain service-role-only.
- The expanded security-boundary pgTAP suite (PR #84, merged) additionally pins the exact 14-function authenticated SECURITY DEFINER inventory, requires caller identity via `auth.uid()`, checks workspace membership for scoped RPCs (with `create_workspace` as the deliberate exception), preserves the narrow direct-write grant surface, and requires invoice summary views to use `security_invoker=true`.
- 38/38 foreign-key constraints have a valid covering index. The 20-index performance migration is applied in staging.
- The two policies flagged by the earlier initplan audit now use `(select auth.uid())`: `task_files` uploader deletion and `workspace_google_connections` own-connection read.
- The current performance adviser reports 33 unused indexes. This is a low-traffic/new staging project; do not drop them from adviser output alone. Require workload/query-plan evidence and review the impact on FK checks and recovery/worker paths before considering removal.

These checks establish catalog and grant invariants, not a proof that every line of every definer function is vulnerability-free. Any change to a definer RPC still requires function-specific review and negative tests for anon, non-members, wrong task/plan/run, and unauthorized state transitions.

## Audit categories

| Category | Status | Evidence / remaining work |
|---|---|---|
| Dedicated staging isolation | **Passed for this release** | Manual deployment workflow targets `flfwtsxuvzyuotltfrbt`; production and Invoice DB refs are explicitly blocked. Keep the same guard on all future staging paths. |
| CI, offline planner evaluation, Edge Function checks, SQL/RLS tests, container scan | **Passed on release SHA** | See main CI run 41310646015. |
| Authenticated planner + FinNLP review/refinement path | **Passed for the synthetic no-tool path** | Smoke run 41440975402 persisted a valid proposed plan. Model ID, token usage and cost were not captured. |
| Approval boundary and worker denial | **Passed for the negative pre-execution path** | Unaccepted plan could not start a run; missing/unowned worker run rejected; zero tool executions. Positive approval, worker progression and tool execution are outside this smoke. |
| RLS, client grants and server-only metadata | **Passed for catalog invariants and exercised RLS path** | 18/18 public tables have RLS. The two no-policy tables have no client grants. Keep function-specific authorization tests. |
| SECURITY DEFINER ACLs/search paths | **Passed for current catalog and reviewed function bodies; negative-test matrix remains partial** | 29 public definer functions; 0 anon-executable; all pin search_path; 14 authenticated-callable functions reviewed on 2026-11-02. Caller identity and workspace/resource checks, row locks and state/version checks are present in reviewed mutation paths. Secret and worker claim/finish RPCs remain service-role-only. `task_approvals_no_self_approval` is currently `NOT VALID` in staging (new/changed rows are protected; historical rows are not yet validated). Staging preflight found zero historical violations; PR #85 is merged; its branch CI passed the full local migration/RLS suite in [run 41454115958](https://github.com/FlowWork-com/Main-Repo/actions/runs/41454115958). The forward-only validation migration is now on `main` but has not yet been deployed to staging; do not treat the historical-record check as complete until the staging deployment and `convalidated` check pass. Membership-level access on prompt-template and plan decisions still needs product-owner confirmation. |
| FK indexes and RLS initplan optimization | **Passed in staging** | 38/38 FKs covered; migration 20261028170900 applied; both flagged auth.uid policies now use scalar subqueries. |
| Unused index recommendations | **Not actionable yet** | 33 adviser findings. Do not remove without production-like workload and query-plan evidence. |
| Request-level observability and redaction | **Partially passed** | `edge_request_finished` logs include request ID, function, method, status/outcome, duration and bounded error code; no bodies, query strings, authorization headers, workspace IDs or raw provider errors. PR #80 adds a fixed, redacted persistence diagnostic. These events do not yet provide a complete task→plan→run→step→execution correlation record. |
| Durable reliability/provider metrics | **Partially verified / incomplete** | Durable task/run/step/execution records exist and request latency is logged. Provider/model identity, token usage/cost, retry/idempotency rates, approval wait and verification outcomes are not yet consistently available as a durable time series. Do not infer missing values. |
| Operational alerts and SLOs | **Proposal only; approval/implementation pending** | Candidate thresholds and SLOs remain in `docs/phase9-operational-controls-proposal.md`. No alert provider or tested paging route is evidenced. Release/on-call owners must approve and implement. |
| Retention and deletion policy | **Proposal only; approval/implementation pending** | Candidate periods remain proposals, not live retention settings. Data owner and privacy/legal approval plus staging deletion tests are required. |
| Recovery runbook | **Partially passed** | `docs/execution-recovery.md` documents stale execution and plan-run recovery and explicitly forbids blind retries/fabricated success. Perform a synthetic staging recovery exercise and record outcomes. |
| Threat model | **Documented; verification partial** | `docs/phase9-threat-model.md` maps the main threat classes to current controls, code/test evidence and residual tests. It is an engineering threat model, not an external penetration test; several live staging exercises and owner risk decisions remain open. |
| Dependency / supply-chain audit | **Open — triage required** | The initial 2026-11-02 npm audit reported 13 findings (11 moderate, 2 high). PR #82 updated the two high-severity dev-only transitive packages (`undici` 8.11.2→8.12.3 via `jsdom`, and `zod` 4.6.5→4.6.7 via `eslint-plugin-react-hooks`) using preview-confirmed compatible versions. The updated audit reports 11 moderate and zero high findings; full CI passed on the lockfile update in [run 41453952868](https://github.com/FlowWork-com/Main-Repo/actions/runs/41453952868). The 11 moderate ESLint/TypeScript-ESLint/minimatch findings remain open; proposed fixes require broader or major version changes and must be reviewed separately. Trivy's image scan passing does not resolve npm dependency findings. |
| Supabase Auth leaked-password protection | **Deferred / plan-gated risk** | The security adviser still reports it disabled. It was unavailable on the current Supabase Free plan in prior dashboard review. Do not bypass the plan restriction; keep explicit release risk acceptance until enabled or an approved mitigation is adopted. |
| Live invoice extraction acceptance | **Not verified** | Use synthetic PDF/image fixtures through the existing approval gate. Confirm provider/model compatibility, null/low-confidence values, arithmetic warnings and human-review status. Groq planner/FinNLP configuration is not proof of an invoice vision provider. |
| Finnhub live lifecycle | **Not verified** | The smoke returned `not connected`; no connect/replace/company-news/disconnect lifecycle was exercised with a dedicated staging credential. |
| Google OAuth live acceptance | **Not verified / optional scope** | No OAuth lifecycle test was run. The latest deployment skipped the optional Google Workspace deployment input. If included in a release, test callback/state/PKCE, minimal scopes, refresh, revocation, cross-workspace denial and Vault cleanup using a dedicated test client. |
| Operational ownership and sign-off | **Pending** | Release owner, on-call owner, approved SLO thresholds, retention approval and known-risk acceptance are not recorded. |

## Recovery and incident response checklist

1. **Provider/planner failure:** use `x-request-id`, function name, fixed error code and duration. Never attach credentials, provider response bodies, invoice contents or raw prompt payloads to incident notes.
2. **Missing signing configuration:** verify the presence of `FLOWWORK_PLAN_SIGNING_KEY` in the Edge Function secret set and `flowwork-plan-signing-key` in Vault by name only. Never print their values. Keep them identical.
3. **Stuck/ambiguous execution:** follow [Execution recovery](execution-recovery.md). Assume an external side effect may have occurred until reconciled; do not mint a new execution identity or blindly retry.
4. **Credential exposure/revocation:** revoke the affected provider/OAuth/Finnhub credential, rotate it in the server-side secret manager, verify logs contain no value, and rerun safe staging checks.
5. **Migration failure:** stop rollout, compare applied migrations to the tested SHA, restore from the approved recovery point if required, and use a reviewed forward fix. Do not rewrite workflow history.
6. **Security adviser finding:** inspect actual grants, RLS, function ACL/search_path, in-function authorization and negative tests before changing policies. Do not blanket-revoke authenticated workflow RPCs or create client policies for service-only tables to silence warnings.

## Remaining Phase 9 release blockers

- Capture and triage the exact npm audit advisories; remediate or document an explicit, reviewed exception.
- Complete an end-to-end authorization review of authenticated SECURITY DEFINER RPCs and close the remaining threat-model evidence gaps.
- Establish a usable correlation path across task, plan, run, step, request and execution IDs; define reproducible reliability metrics without storing sensitive business payloads.
- Have the release/on-call owner approve or reject the candidate SLO/alert thresholds and privacy/legal/data owner approve or reject the retention proposal. Configure/test alerts and retention only after approval.
- Exercise recovery in staging using synthetic data, including an ambiguous timeout path that remains paused until reconciled.
- Decide which optional integrations are actually in scope, then run live acceptance for synthetic invoice extraction, Finnhub connection lifecycle, and Google OAuth only if included.
- Record provider/model IDs, latency and provider-returned usage/cost where available; do not invent model usage or quality claims.
- Keep leaked-password protection visible as a deferred security risk until the Supabase plan permits it or an approved mitigation is available.
- Record release owner, operational owner, risk acceptance, recovery point, rollback owner and exact tested SHA before any production decision.

**Phase 9 remains open.** The successful staging smoke is a major validated milestone for the safe planning path, not authorization to enable production execution or a claim of production readiness.
