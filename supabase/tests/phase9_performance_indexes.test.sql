begin;

select plan(3);

select ok(
  (
    select count(*) = 20
    from pg_indexes
    where schemaname = 'public'
      and indexname = any (array[
        'google_workspace_oauth_states_workspace_user_idx',
        'invoice_extraction_feedback_submitted_by_idx',
        'invoice_extraction_feedback_workspace_task_file_idx',
        'task_approvals_approver_id_idx',
        'task_approvals_requested_by_idx',
        'task_events_actor_id_idx',
        'task_files_uploaded_by_idx',
        'task_tool_executions_requested_by_idx',
        'tasks_owner_id_idx',
        'workflow_plan_run_events_actor_id_idx',
        'workflow_plan_run_events_run_id_idx',
        'workflow_plan_runs_plan_workspace_task_idx',
        'workflow_plan_runs_started_by_idx',
        'workflow_plan_step_runs_run_workspace_task_idx',
        'workflow_plans_decided_by_idx',
        'workflow_plans_proposed_by_idx',
        'workspace_prompt_template_versions_created_by_idx',
        'workspace_prompt_templates_created_by_idx',
        'workspace_prompt_templates_updated_by_idx',
        'workspaces_created_by_idx'
      ]::text[])
  ),
  'all 20 advisor-identified foreign-key support indexes exist'
);

select ok(
  exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'task_files'
      and policyname = 'uploaders can remove their task file metadata'
      and qual ilike '%select auth.uid()%'
  ),
  'task file delete policy evaluates auth.uid() through a scalar subquery'
);

select ok(
  exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'workspace_google_connections'
      and policyname = 'users can read their own workspace google connection'
      and qual ilike '%select auth.uid()%'
  ),
  'Google connection select policy evaluates auth.uid() through a scalar subquery'
);

select * from finish();
rollback;
