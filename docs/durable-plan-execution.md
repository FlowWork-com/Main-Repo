# Durable supervised plan-step execution

This phase adds the database persistence boundary for accepted-plan runs and individual step attempts.

## State model

- A run is created only for an accepted plan whose persisted validation status is `valid`, with 1–10 persisted steps.
- The workflow task must already be in `Running`. Starting a run does not change task status.
- Every plan step is snapshotted into `workflow_plan_step_runs` before execution. The snapshot includes step ID/order, tool ID/version, validated input, and dependencies.
- A step can be claimed only while its run and task are active and every dependency has status `succeeded`.
- Claiming a step records an execution ID and increments its attempt. The same execution ID can safely re-read its active claim.
- A step result is final for that attempt. Failed steps remain retryable; dependent steps remain blocked until prerequisites succeed.
- A run becomes `succeeded` only when every step has succeeded. This does **not** complete the workflow task; verification and delivery remain separate workflow stages.

## Security boundary

Authenticated workspace members can read run history through RLS and request a run through `start_workflow_plan_run`. Direct table writes are revoked. Step claim/result RPCs are restricted to `service_role` and require the trusted caller to provide a workspace-member identity. The `execute-tool` server path now accepts `planRunId` and `stepId` together, claims the persisted step before execution, validates tool/version/input against the stored snapshot, and records the result after execution. The claim/result RPCs are service-role-only; clients cannot report results directly. The fields remain optional for the existing manual registered-tool flow, which is not plan-bound and should be retired or separately permissioned before claiming that all tool execution is plan-supervised.

## RPC contracts

- `start_workflow_plan_run(plan_id)`: creates a durable run and snapshots its steps; repeated calls return the existing active run.
- `claim_workflow_plan_step(run_id, step_id, execution_id, actor_id)`: validates prerequisites and reserves a step attempt.
- `finish_workflow_plan_step(run_id, step_id, execution_id, output, error, actor_id)`: persists success/failure idempotently and marks the run successful only when all steps succeeded.

Phase 5 initially required one explicit step action at a time. Phase 6 adds a bounded background worker: after a user explicitly starts an accepted plan, the `advance-plan-run` Edge Function schedules durable progress and processes at most one step per worker invocation. The database lease on the run is the concurrency boundary; `EdgeRuntime.waitUntil` dispatches the next bounded invocation after the prior result is durably recorded. The browser only refreshes progress and can pause, resume a user-paused run, or cancel. If a tool is already running, pause/cancel is persisted as a control request; the current tool may finish, but no subsequent step is scheduled.

Each run stores `policy_version`, a 15-minute elapsed-time bound, and a one-attempt automatic retry policy. Since current tool contracts do not declare safe idempotency, failed or ambiguous steps pause for review and are never automatically replayed. Expired leases with an in-flight step also pause for review. Append-only `workflow_plan_run_events` stores sanitized worker, step, pause/resume, and cancellation events, not raw tool payloads; the run/step tables remain the authoritative current state. Only a clean user-paused run can resume automatically; error/lease-expiry pauses require manual review. The worker route disables gateway JWT verification only so it can authenticate the internal dispatch header itself; ordinary calls must pass a verified user JWT and workspace-membership check. The internal dispatch credential is the server-only service-role secret and is never returned to the browser.

A successful intermediate step leaves the workflow in `Running`; only the final successful step moves it to `Verifying`. Manual registered-tool requests without plan linkage remain supported for compatibility and are not automatically scheduled by the plan-run worker.
