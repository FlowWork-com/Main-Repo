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

Authenticated workspace members can read run history through RLS and request a run through `start_workflow_plan_run`. Direct table writes are revoked. Step claim/result RPCs are restricted to `service_role` and require the trusted caller to provide a workspace-member identity. The server execution layer must call these RPCs around tool execution; clients must never be allowed to report tool results directly.

## RPC contracts

- `start_workflow_plan_run(plan_id)`: creates a durable run and snapshots its steps; repeated calls return the existing active run.
- `claim_workflow_plan_step(run_id, step_id, execution_id, actor_id)`: validates prerequisites and reserves a step attempt.
- `finish_workflow_plan_step(run_id, step_id, execution_id, output, error, actor_id)`: persists success/failure idempotently and marks the run successful only when all steps succeeded.

The migration deliberately does not auto-execute tools. The server-side execution handler still needs to be wired to require a run/step identity and invoke claim/result RPCs around each tool call before this persistence layer is end-to-end usable.
