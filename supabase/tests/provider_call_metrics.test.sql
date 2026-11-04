begin;

select plan(11);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values (
  'd1000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'provider-metrics@example.test', '', now(), now(), now()
);

insert into public.workspaces (id, name, created_by) values
  ('d2000000-0000-4000-8000-000000000001', 'Metrics workspace A', 'd1000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-000000000002', 'Metrics workspace B', 'd1000000-0000-4000-8000-000000000001');

insert into public.workspace_members (workspace_id, user_id, role) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'owner'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 'owner');

insert into public.tasks (id, workspace_id, owner_id, title, details, status, attempt) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'Metrics task A', '', 'Running', 1),
  ('d3000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 'Metrics task B', '', 'Running', 1);

insert into public.workflow_plans (
  id, workspace_id, task_id, version, proposed_by, plan, decision, decided_by, decided_at
) values
  ('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 1, 'd1000000-0000-4000-8000-000000000001', '{"id":"d4000000-0000-4000-8000-000000000001"}', 'accepted', 'd1000000-0000-4000-8000-000000000001', now()),
  ('d4000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000002', 1, 'd1000000-0000-4000-8000-000000000001', '{"id":"d4000000-0000-4000-8000-000000000002"}', 'accepted', 'd1000000-0000-4000-8000-000000000001', now());

insert into public.workflow_plan_runs (
  id, workspace_id, task_id, plan_id, plan_version, status, started_by
) values (
  'd5000000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000001',
  'd4000000-0000-4000-8000-000000000001', 1, 'running', 'd1000000-0000-4000-8000-000000000001'
);

insert into public.workflow_plan_step_runs (
  run_id, workspace_id, task_id, step_id, step_index, title, tool_id, tool_version,
  input, dependencies, status, attempt, execution_id, started_at
) values (
  'd5000000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000001',
  'step_1', 0, 'Review invoice', 'invoice-document-extract', '1.0.0',
  '{}'::jsonb, '[]'::jsonb, 'running', 1,
  'd6000000-0000-4000-8000-000000000001', now()
);

insert into public.task_tool_executions (
  workspace_id, task_id, tool_id, tool_version, execution_id, request_id,
  requested_by, status, input
) values (
  'd2000000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000001',
  'invoice-document-extract', '1.0.0', 'd6000000-0000-4000-8000-000000000001',
  'provider-metrics-tool-request', 'd1000000-0000-4000-8000-000000000001',
  'running', '{}'::jsonb
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.provider_call_metrics'::regclass),
  'provider metrics table has RLS enabled'
);

select ok(
  not has_table_privilege('anon', 'public.provider_call_metrics', 'select')
  and not has_table_privilege('anon', 'public.provider_call_metrics', 'insert')
  and not has_table_privilege('authenticated', 'public.provider_call_metrics', 'select')
  and not has_table_privilege('authenticated', 'public.provider_call_metrics', 'insert'),
  'client roles cannot read or insert provider metrics'
);

select ok(
  has_table_privilege('service_role', 'public.provider_call_metrics', 'select')
  and has_table_privilege('service_role', 'public.provider_call_metrics', 'insert'),
  'the trusted service role can persist and inspect provider metrics'
);

select is(
  (select count(*)::integer from pg_indexes
   where schemaname = 'public' and indexname in (
     'provider_call_metrics_plan_reference_idx',
     'provider_call_metrics_run_reference_idx',
     'provider_call_metrics_step_reference_idx',
     'provider_call_metrics_execution_reference_idx'
   )),
  4,
  'metric foreign-key references have indexes for cascade and correlation lookups'
);

set local role service_role;

select lives_ok(
  $$ insert into public.provider_call_metrics (
       workspace_id, task_id, plan_id, edge_request_id, stage, provider_id,
       model_id, outcome, duration_ms, retry_count
     ) values (
       'd2000000-0000-4000-8000-000000000001',
       'd3000000-0000-4000-8000-000000000001',
       'd4000000-0000-4000-8000-000000000001',
       'd7000000-0000-4000-8000-000000000001',
       'planning', 'api.example.test', 'planner-v1', 'succeeded', 123, 0
     ) $$,
  'service role can persist a task/plan/request-correlated provider call'
);

select ok(
  (select input_tokens is null and output_tokens is null and total_tokens is null
     and provider_reported_cost is null
   from public.provider_call_metrics
   where edge_request_id = 'd7000000-0000-4000-8000-000000000001'),
  'unreported token usage and cost remain null rather than being inferred'
);

select lives_ok(
  $$ insert into public.provider_call_metrics (
       workspace_id, task_id, run_id, step_id, edge_request_id,
       execution_request_id, execution_id, stage, provider_id, model_id,
       outcome, duration_ms, retry_count, input_tokens, output_tokens, total_tokens
     ) values (
       'd2000000-0000-4000-8000-000000000001',
       'd3000000-0000-4000-8000-000000000001',
       'd5000000-0000-4000-8000-000000000001', 'step_1',
       'd7000000-0000-4000-8000-000000000002',
       'provider-metrics-tool-request', 'd6000000-0000-4000-8000-000000000001',
       'invoice_extraction', 'vision.example.test', 'vision-v1', 'succeeded', 456, 0, 50, 12, 62
     ) $$,
  'service role can persist a run/step/request/execution-correlated provider call'
);

select ok(
  (select m.task_id = s.task_id and m.run_id = s.run_id and m.step_id = s.step_id
     and m.execution_id = s.execution_id and m.execution_request_id = e.request_id
   from public.provider_call_metrics m
   join public.workflow_plan_step_runs s on s.run_id = m.run_id and s.step_id = m.step_id
   join public.task_tool_executions e on e.workspace_id = m.workspace_id
     and e.task_id = m.task_id and e.execution_id = m.execution_id
   where m.edge_request_id = 'd7000000-0000-4000-8000-000000000002'),
  'durable metric identifiers join the task, run, step, request, and execution'
);

select throws_ok(
  $$ insert into public.provider_call_metrics (
       workspace_id, task_id, plan_id, edge_request_id, stage, provider_id,
       outcome, duration_ms, retry_count
     ) values (
       'd2000000-0000-4000-8000-000000000001',
       'd3000000-0000-4000-8000-000000000001',
       'd4000000-0000-4000-8000-000000000002',
       'd7000000-0000-4000-8000-000000000003',
       'planning', 'api.example.test', 'failed', 1, 0
     ) $$,
  '23503',
  'insert or update on table "provider_call_metrics" violates foreign key constraint "provider_call_metrics_plan_id_workspace_id_task_id_fkey"',
  'cross-workspace plan IDs cannot be attached to another task metric'
);

reset role;
set local role authenticated;
select throws_ok(
  $$ insert into public.provider_call_metrics (
       workspace_id, task_id, edge_request_id, stage, provider_id,
       outcome, duration_ms, retry_count
     ) values (
       'd2000000-0000-4000-8000-000000000001',
       'd3000000-0000-4000-8000-000000000001',
       'd7000000-0000-4000-8000-000000000004',
       'planning', 'api.example.test', 'succeeded', 1, 0
     ) $$,
  '42501',
  'permission denied for table provider_call_metrics',
  'authenticated users cannot forge provider metric records'
);

reset role;
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'provider_call_metrics'
      and column_name ~* '(prompt|response|invoice|secret|signature|payload|error_message)'
  ),
  'provider metric schema has no prompt, document, credential, signature, payload, or raw-error columns'
);

select * from finish();
rollback;
