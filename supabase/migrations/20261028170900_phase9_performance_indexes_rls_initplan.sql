begin;

-- Support the child-side lookups performed when referenced rows are updated or deleted.
-- These indexes add no access rights and do not change RLS predicates.
create index if not exists google_workspace_oauth_states_workspace_user_idx
  on public.google_workspace_oauth_states (workspace_id, user_id);
create index if not exists invoice_extraction_feedback_submitted_by_idx
  on public.invoice_extraction_feedback (submitted_by);
create index if not exists invoice_extraction_feedback_workspace_task_file_idx
  on public.invoice_extraction_feedback (workspace_id, task_id, file_id);
create index if not exists task_approvals_approver_id_idx
  on public.task_approvals (approver_id);
create index if not exists task_approvals_requested_by_idx
  on public.task_approvals (requested_by);
create index if not exists task_events_actor_id_idx
  on public.task_events (actor_id);
create index if not exists task_files_uploaded_by_idx
  on public.task_files (uploaded_by);
create index if not exists task_tool_executions_requested_by_idx
  on public.task_tool_executions (requested_by);
create index if not exists tasks_owner_id_idx
  on public.tasks (owner_id);
create index if not exists workflow_plan_run_events_actor_id_idx
  on public.workflow_plan_run_events (actor_id);
create index if not exists workflow_plan_run_events_run_id_idx
  on public.workflow_plan_run_events (run_id);
create index if not exists workflow_plan_runs_plan_workspace_task_idx
  on public.workflow_plan_runs (plan_id, workspace_id, task_id);
create index if not exists workflow_plan_runs_started_by_idx
  on public.workflow_plan_runs (started_by);
create index if not exists workflow_plan_step_runs_run_workspace_task_idx
  on public.workflow_plan_step_runs (run_id, workspace_id, task_id);
create index if not exists workflow_plans_decided_by_idx
  on public.workflow_plans (decided_by);
create index if not exists workflow_plans_proposed_by_idx
  on public.workflow_plans (proposed_by);
create index if not exists workspace_prompt_template_versions_created_by_idx
  on public.workspace_prompt_template_versions (created_by);
create index if not exists workspace_prompt_templates_created_by_idx
  on public.workspace_prompt_templates (created_by);
create index if not exists workspace_prompt_templates_updated_by_idx
  on public.workspace_prompt_templates (updated_by);
create index if not exists workspaces_created_by_idx
  on public.workspaces (created_by);

-- Preserve the same membership/ownership restrictions while evaluating auth.uid()
-- once per statement rather than once for each candidate row.
alter policy "uploaders can remove their task file metadata"
  on public.task_files
  using (
    uploaded_by = (select auth.uid())
    and public.is_workspace_member(workspace_id)
  );

alter policy "users can read their own workspace google connection"
  on public.workspace_google_connections
  using (
    user_id = (select auth.uid())
    and public.is_workspace_member(workspace_id)
  );

commit;
