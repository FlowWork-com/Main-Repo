# Phase 9 Reliability and Production-Readiness Audit

**Evidence refreshed:** 2026-11-04
**Latest local main commit reviewed:** `a7f4f21c7f170cd68dcacf96e0e5138eb60449b9`
**Staging release commit tested:** `01ee69894894c8e8c246138bcb2ab4d1f4e41b8d`
**Environment audited:** FlowWork Staging — `flfwtsxuvzyuotltfrbt` (`eu-west-1`)
**Production boundary:** FlowWork Main DB `nhvmeahmwywhaxtnuehr` and Invoice DB `tlhznghnfdwpilhfjyyu` remain forbidden staging targets.

This is an evidence-based staging and security audit, **not a production-readiness certification**. A passing smoke run proves only the exercised path. Items marked failed, partially verified, proposed, or not verified remain open.

## Executive result

The authenticated staging planning vertical slice passed on the November 2 release commit. In the current repository state, PRs #88 and #89 are merged and are recorded as the latest repository-level regression evidence. The metrics migration is merged in code, but the repository does not currently show a fresh staging deployment after the last successful release, so the migration is not yet confirmed live in FlowWork Staging. None of these repository tests changes the staging evidence or proves a live external write.

Phase 9 is **not complete**. Remaining work includes the open authorization edge-case and worker step-isolation PRs, provider metrics review/deployment/acceptance, the unresolved moderate dependency advisory, an end-to-end staging recovery drill, live invoice and optional integration acceptance, owner approval for SLOs/alerts and retention, and the explicitly deferred leaked-password control.

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

### Repository regression work after the staging release

- PR #88, merged in the current local history, added negative cases for members using real plans from another workspace, non-members creating tasks or writing workflow events, prompt-template cross-workspace create/edit/archive, private attachment registration, and known run pause/resume/cancel. Its Frontend CI validate and container jobs passed in [run 41674682622](https://github.com/FlowWork-com/Main-Repo/actions/runs/41674682622). This is database/CI evidence, not a new staging exercise.
- PR #89, merged in the current local history, added `scripts/test-plan-run-worker-concurrency.mjs` to Frontend CI. Its two PostgreSQL sessions overlap on a held row lock; the test proves one lease, stale finalization denial, expired-lease reclaim when no step is in flight, and an ambiguous running step that remains paused with no output/evidence or replay. Frontend CI passed in [run 41810313679](https://github.com/FlowWork-com/Main-Repo/actions/runs/41810313679). The test uses synthetic local database rows and does not determine whether an external action occurred.
- The request ID and provider-metrics migration is merged in code, but no later staging deployment is visible in the current repository evidence. The migration still needs a fresh FlowWork Staging deployment and one safe planning-only correlation trace before it can be treated as accepted live staging evidence. No live provider call was used as acceptance evidence.
- The current repo view in this checkout reports no open PRs. The earlier PR #90/#91/#92 references are stale and must be treated as closed or no longer visible in the current state rather than active review items.
- The local database was reset only from repository migrations. No staging, production, Invoice DB, or secret values were accessed for these tests.

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
| SECURITY DEFINER ACLs/search paths | **Expanded negatives on main; edge cases remain in review against current merged state** | The staging catalog review remains the November 2 evidence: 29 public definer functions, 0 anon-executable, all pinned search paths, and 14 authenticated-callable functions. The current repo state in this checkout shows no open PRs, so the prior references to open negative-case follow-ups should be treated as historical notes rather than active review items. Prompt-template and plan decisions remain workspace-member scoped; whether they require role-specific restriction still needs product-owner confirmation. The no-self-approval constraint remains validated in staging per the November 2 catalog evidence. |
| FK indexes and RLS initplan optimization | **Passed in staging** | 38/38 FKs covered; migration 20261028170900 applied; both flagged auth.uid policies now use scalar subqueries. |
| Unused index recommendations | **Not actionable yet** | 33 adviser findings. Do not remove without production-like workload and query-plan evidence. |
| Request-level observability and redaction | **Passed for request logs; durable correlation is merged in code but not yet confirmed live in staging** | `edge_request_finished` remains metadata-only with a server-generated request ID, function, method, status/outcome, duration and bounded error code. The durable task/plan/run/step/request/execution correlation is merged in code, but the current repository state does not show a subsequent staging deployment confirming the migration is live or that a real planning-only request creates the durable metrics. |
| Durable reliability/provider metrics | **Merged in code; not yet confirmed live in staging** | The proposal records configured provider host/model, stage, outcome, measured latency, actual retry count, and provider-returned usage/cost only. Local tests prove redaction and persistence schema constraints, not a live provider's reported usage or cost in FlowWork Staging. Metrics are not a configured alert or approved SLO. |
| Operational alerts and SLOs | **Proposal only; approval/implementation pending** | Candidate thresholds and SLOs remain in `docs/phase9-operational-controls-proposal.md`. No alert provider or tested paging route is evidenced. Release/on-call owners must approve and implement. |
| Retention and deletion policy | **Proposal only; approval/implementation pending** | Candidate periods remain proposals, not live retention settings. Data owner and privacy/legal approval plus staging deletion tests are required. |
| Recovery runbook and worker concurrency | **Repository regression passed; staging drill remains open** | PR #89's local PostgreSQL concurrency harness and CI run 41810313679 prove lock serialization, stale lease rejection, and no-replay ambiguous pause with synthetic rows. `docs/execution-recovery.md` distinguishes this from external-effect reconciliation. A dedicated synthetic staging recovery exercise is still required. |
| Threat model | **Documented; verification partial** | `docs/phase9-threat-model.md` maps the main threat classes to current controls, code/test evidence and residual tests. It is an engineering threat model, not an external penetration test; several live staging exercises and owner risk decisions remain open. |
| Dependency / supply-chain audit | **11 moderate remain; 0 high; no compatible npm fix** | Fresh `npm audit --json` on 2026-11-04 reports 11 moderate and zero high findings. The root advisory is `minimatch` GHSA-g3hv-75wg-m249, affected below 11.0.1. Installed `@eslint/config-array@0.23.5`, `@typescript-eslint/typescript-estree@8.71.1`, and `eslint@10.12.0` require `minimatch` `^10.2.4`, `^10.2.2`, and `^10.2.5` respectively. `npm audit fix --package-lock-only --ignore-scripts --no-fund --dry-run` made no compatible changes; npm offers an incompatible ESLint 4.0.0 downgrade with `--force`. No override or major update was applied. The remaining findings require a reviewed dependency upgrade/override or explicit owner-approved risk acceptance; neither is granted here. Earlier dev-only high fixes remain recorded in PR #82 and run 41453952868. |
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

- Obtain owner review for the 11 moderate npm findings; the current compatible dependency ranges do not permit the advisory's fixed minimatch major without a reviewed change.
- Merge and run CI for PRs #91 and #92, then complete the function-specific authorization review. Do not infer full matrix completion from the static SECURITY DEFINER inventory alone.
- Deploy the current main revision to FlowWork Staging and verify the provider metrics migration, permissions and one safe planning-only correlation trace. Confirm no tool execution occurs and record the exact staging SHA and workflow run before treating the metrics path as accepted live evidence.
- Have the release/on-call owner approve or reject the candidate SLO/alert thresholds and the data owner/privacy/legal stakeholder approve or reject retention. Configure alerts and retention only after approval.
- Perform a synthetic staging recovery exercise, including an ambiguous outcome that remains paused until reconciled. The local concurrency test is not a staging or external-effect test.
- Decide which optional integrations are actually in scope, then run live acceptance for synthetic invoice extraction, Finnhub connection lifecycle, and Google OAuth only if included.
- Record provider/model IDs, latency and provider-returned usage/cost where available; do not invent model usage or quality claims.
- Keep leaked-password protection visible as a deferred security risk until the Supabase plan permits it or an approved mitigation is available.
- Record release owner, operational owner, risk acceptance, recovery point, rollback owner and exact tested SHA before any production decision.

**Phase 9 remains open.** The successful staging smoke is a major validated milestone for the safe planning path, not authorization to enable production execution or a claim of production readiness.
