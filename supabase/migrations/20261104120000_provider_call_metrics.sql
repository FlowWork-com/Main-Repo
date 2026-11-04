begin;

create table public.provider_call_metrics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id uuid not null,
  plan_id uuid,
  run_id uuid,
  step_id text,
  edge_request_id uuid not null,
  execution_request_id text,
  execution_id uuid,
  stage text not null check (stage in (
    'planning', 'planning_refinement', 'financial_review', 'invoice_extraction', 'company_news'
  )),
  provider_id text not null check (char_length(trim(provider_id)) between 1 and 200),
  model_id text check (model_id is null or char_length(trim(model_id)) between 1 and 200),
  outcome text not null check (outcome in ('succeeded', 'failed')),
  duration_ms integer not null check (duration_ms between 0 and 600000),
  retry_count smallint not null default 0 check (retry_count between 0 and 20),
  input_tokens bigint check (input_tokens is null or input_tokens >= 0),
  output_tokens bigint check (output_tokens is null or output_tokens >= 0),
  total_tokens bigint check (total_tokens is null or total_tokens >= 0),
  provider_reported_cost numeric(20, 10)
    check (provider_reported_cost is null or provider_reported_cost >= 0),
  provider_reported_cost_currency text
    check (provider_reported_cost_currency is null or provider_reported_cost_currency ~ '^[A-Z]{3}$'),
  failure_category text check (failure_category is null or failure_category in (
    'configuration', 'timeout', 'rate_limited', 'quota', 'unauthorized',
    'unavailable', 'invalid_response', 'unknown'
  )),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, task_id)
    references public.tasks (workspace_id, id) on delete cascade,
  foreign key (plan_id, workspace_id, task_id)
    references public.workflow_plans (id, workspace_id, task_id) on delete cascade,
  foreign key (run_id, workspace_id, task_id)
    references public.workflow_plan_runs (id, workspace_id, task_id) on delete cascade,
  foreign key (run_id, step_id)
    references public.workflow_plan_step_runs (run_id, step_id) on delete cascade,
  foreign key (workspace_id, task_id, execution_id)
    references public.task_tool_executions (workspace_id, task_id, execution_id) on delete cascade,
  check ((run_id is null) = (step_id is null)),
  check ((execution_id is null) = (execution_request_id is null)),
  check (execution_request_id is null or char_length(trim(execution_request_id)) between 1 and 200)
);

create index provider_call_metrics_task_history_idx
  on public.provider_call_metrics (workspace_id, task_id, occurred_at desc);
create index provider_call_metrics_edge_request_idx
  on public.provider_call_metrics (edge_request_id, occurred_at desc);
create index provider_call_metrics_plan_reference_idx
  on public.provider_call_metrics (plan_id, workspace_id, task_id)
  where plan_id is not null;
create index provider_call_metrics_run_reference_idx
  on public.provider_call_metrics (run_id, workspace_id, task_id)
  where run_id is not null;
create index provider_call_metrics_step_reference_idx
  on public.provider_call_metrics (run_id, step_id)
  where run_id is not null;
create index provider_call_metrics_execution_reference_idx
  on public.provider_call_metrics (workspace_id, task_id, execution_id)
  where execution_id is not null;

alter table public.provider_call_metrics enable row level security;
revoke all on public.provider_call_metrics from public, anon, authenticated;
grant select, insert on public.provider_call_metrics to service_role;

commit;
