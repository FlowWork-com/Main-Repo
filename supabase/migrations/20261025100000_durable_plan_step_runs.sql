begin;

alter table public.workflow_plans
  add constraint workflow_plans_id_workspace_task_unique unique (id, workspace_id, task_id);

create table public.workflow_plan_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id uuid not null,
  plan_id uuid not null,
  plan_version integer not null check (plan_version > 0),
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed', 'cancelled')),
  started_by uuid not null references auth.users (id) on delete restrict,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, task_id, plan_id),
  unique (id, workspace_id, task_id),
  foreign key (workspace_id, task_id)
    references public.tasks (workspace_id, id) on delete cascade,
  foreign key (plan_id, workspace_id, task_id)
    references public.workflow_plans (id, workspace_id, task_id) on delete cascade,
  check (
    (status = 'running' and completed_at is null)
    or (status in ('succeeded', 'failed', 'cancelled') and completed_at is not null)
  )
);

create index workflow_plan_runs_task_history_idx
  on public.workflow_plan_runs (workspace_id, task_id, created_at desc);

create table public.workflow_plan_step_runs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  workspace_id uuid not null,
  task_id uuid not null,
  step_id text not null check (char_length(trim(step_id)) between 1 and 100),
  step_index integer not null check (step_index between 0 and 9),
  title text not null check (char_length(trim(title)) between 1 and 200),
  tool_id text not null check (char_length(trim(tool_id)) between 1 and 100),
  tool_version text not null check (char_length(trim(tool_version)) between 1 and 40),
  input jsonb not null check (pg_column_size(input) <= 65536),
  dependencies jsonb not null default '[]'::jsonb
    check (jsonb_typeof(dependencies) = 'array' and pg_column_size(dependencies) <= 4096),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed', 'blocked')),
  attempt integer not null default 0 check (attempt between 0 and 100),
  execution_id uuid,
  output jsonb,
  error jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, step_id),
  unique (run_id, step_index),
  foreign key (run_id, workspace_id, task_id)
    references public.workflow_plan_runs (id, workspace_id, task_id) on delete cascade,
  check (
    (status = 'pending' and attempt = 0 and execution_id is null and started_at is null and completed_at is null and output is null and error is null)
    or (status = 'running' and attempt > 0 and execution_id is not null and started_at is not null and completed_at is null and output is null and error is null)
    or (status = 'succeeded' and attempt > 0 and execution_id is not null and started_at is not null and completed_at is not null and output is not null and error is null)
    or (status = 'failed' and attempt > 0 and execution_id is not null and started_at is not null and completed_at is not null and output is null and error is not null)
    or (status = 'blocked' and completed_at is not null and error is not null)
  )
);

create index workflow_plan_step_runs_order_idx
  on public.workflow_plan_step_runs (run_id, step_index);

alter table public.workflow_plan_runs enable row level security;
alter table public.workflow_plan_step_runs enable row level security;

create policy "workspace members can read plan runs"
  on public.workflow_plan_runs for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy "workspace members can read plan step runs"
  on public.workflow_plan_step_runs for select to authenticated
  using (public.is_workspace_member(workspace_id));

revoke all on public.workflow_plan_runs from anon, authenticated;
revoke all on public.workflow_plan_step_runs from anon, authenticated;
grant select on public.workflow_plan_runs to authenticated;
grant select on public.workflow_plan_step_runs to authenticated;

create function public.start_workflow_plan_run(p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_plan public.workflow_plans%rowtype;
  v_task_status text;
  v_run public.workflow_plan_runs%rowtype;
  v_step jsonb;
  v_index integer := 0;
  v_steps jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_plan_id is null then
    raise exception 'A plan is required.' using errcode = '22023';
  end if;

  select p.* into v_plan
  from public.workflow_plans p
  where p.id = p_plan_id
  for update;
  if not found or not public.is_workspace_member(v_plan.workspace_id) then
    raise exception 'Plan access is required.' using errcode = '42501';
  end if;
  if v_plan.decision is distinct from 'accepted'
    or v_plan.plan->>'validationStatus' is distinct from 'valid'
    or jsonb_typeof(v_plan.plan->'steps') is distinct from 'array'
    or jsonb_array_length(v_plan.plan->'steps') not between 1 and 10 then
    raise exception 'Only an accepted, valid plan can be run.' using errcode = '22023';
  end if;

  select t.status into v_task_status
  from public.tasks t
  where t.id = v_plan.task_id and t.workspace_id = v_plan.workspace_id
  for update;
  if not found or v_task_status is distinct from 'Running' then
    raise exception 'Task must be Running before its plan can execute.' using errcode = '22023';
  end if;

  select r.* into v_run
  from public.workflow_plan_runs r
  where r.workspace_id = v_plan.workspace_id
    and r.task_id = v_plan.task_id
    and r.plan_id = v_plan.id
  for update;
  if found then
    if v_run.status <> 'running' then
      raise exception 'This plan run is already final.' using errcode = '23505';
    end if;
    return jsonb_build_object('id', v_run.id, 'status', v_run.status, 'plan_id', v_run.plan_id);
  end if;

  insert into public.workflow_plan_runs (
    workspace_id, task_id, plan_id, plan_version, started_by
  ) values (
    v_plan.workspace_id, v_plan.task_id, v_plan.id, v_plan.version, v_user_id
  ) returning * into v_run;

  v_steps := v_plan.plan->'steps';
  for v_step in select value from jsonb_array_elements(v_steps)
  loop
    if jsonb_typeof(v_step) is distinct from 'object'
      or coalesce(v_step->>'id', '') !~ '^[a-zA-Z0-9_-]{1,100}$'
      or coalesce(v_step->>'title', '') = ''
      or coalesce(v_step->>'toolId', '') = ''
      or coalesce(v_step->>'toolVersion', '') = ''
      or not (v_step ? 'input')
      or jsonb_typeof(coalesce(v_step->'dependencies', '[]'::jsonb)) is distinct from 'array' then
      raise exception 'Plan step is malformed.' using errcode = '22023';
    end if;

    insert into public.workflow_plan_step_runs (
      run_id, workspace_id, task_id, step_id, step_index, title,
      tool_id, tool_version, input, dependencies
    ) values (
      v_run.id, v_plan.workspace_id, v_plan.task_id, v_step->>'id', v_index,
      left(v_step->>'title', 200), v_step->>'toolId', v_step->>'toolVersion',
      v_step->'input', coalesce(v_step->'dependencies', '[]'::jsonb)
    );
    v_index := v_index + 1;
  end loop;

  return jsonb_build_object('id', v_run.id, 'status', v_run.status, 'plan_id', v_run.plan_id);
end;
$$;

create function public.claim_workflow_plan_step(
  p_run_id uuid,
  p_step_id text,
  p_execution_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_run public.workflow_plan_runs%rowtype;
  v_step public.workflow_plan_step_runs%rowtype;
begin
  if p_actor_id is null or not exists (
    select 1 from public.workspace_members wm
    join public.workflow_plan_runs r on r.workspace_id = wm.workspace_id
    where r.id = p_run_id and wm.user_id = p_actor_id
  ) then
    raise exception 'Plan run access is required.' using errcode = '42501';
  end if;
  if p_run_id is null or p_execution_id is null
    or p_step_id is null or char_length(trim(p_step_id)) not between 1 and 100 then
    raise exception 'Invalid step claim.' using errcode = '22023';
  end if;

  select r.* into v_run
  from public.workflow_plan_runs r
  where r.id = p_run_id
  for update;
  if not found or not public.is_workspace_member(v_run.workspace_id) then
    raise exception 'Plan run access is required.' using errcode = '42501';
  end if;
  if v_run.status <> 'running' then
    raise exception 'Plan run is not active.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.tasks t
    where t.id = v_run.task_id and t.workspace_id = v_run.workspace_id
      and t.status = 'Running'
  ) then
    raise exception 'Task must remain Running during execution.' using errcode = '22023';
  end if;

  select s.* into v_step
  from public.workflow_plan_step_runs s
  where s.run_id = v_run.id and s.step_id = p_step_id
  for update;
  if not found then
    raise exception 'Plan step was not found.' using errcode = '22023';
  end if;
  if v_step.status = 'running' and v_step.execution_id = p_execution_id then
    return jsonb_build_object('step_id', v_step.step_id, 'status', v_step.status,
      'execution_id', v_step.execution_id, 'input', v_step.input,
      'tool_id', v_step.tool_id, 'tool_version', v_step.tool_version);
  end if;
  if v_step.status not in ('pending', 'failed') then
    raise exception 'Plan step is not available to execute.' using errcode = '23505';
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(v_step.dependencies) as dependency(step_id)
    left join public.workflow_plan_step_runs dependency_run
      on dependency_run.run_id = v_run.id and dependency_run.step_id = dependency.step_id
    where dependency_run.status is distinct from 'succeeded'
  ) then
    raise exception 'Plan step dependencies have not succeeded.' using errcode = '22023';
  end if;

  update public.workflow_plan_step_runs
  set status = 'running', attempt = attempt + 1, execution_id = p_execution_id,
      started_at = now(), completed_at = null, output = null, error = null
  where id = v_step.id
  returning * into v_step;

  return jsonb_build_object('step_id', v_step.step_id, 'status', v_step.status,
    'execution_id', v_step.execution_id, 'input', v_step.input,
    'tool_id', v_step.tool_id, 'tool_version', v_step.tool_version);
end;
$$;

create function public.finish_workflow_plan_step(
  p_run_id uuid,
  p_step_id text,
  p_execution_id uuid,
  p_output jsonb,
  p_error jsonb,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_run public.workflow_plan_runs%rowtype;
  v_step public.workflow_plan_step_runs%rowtype;
  v_status text;
begin
  if p_actor_id is null or not exists (
    select 1 from public.workspace_members wm
    join public.workflow_plan_runs r on r.workspace_id = wm.workspace_id
    where r.id = p_run_id and wm.user_id = p_actor_id
  ) then
    raise exception 'Plan run access is required.' using errcode = '42501';
  end if;
  if p_run_id is null or p_execution_id is null or p_step_id is null
    or (p_output is not null and p_error is not null)
    or (p_error is not null and jsonb_typeof(p_error) is distinct from 'object')
    or (p_output is not null and pg_column_size(p_output) > 65536)
    or (p_error is not null and pg_column_size(p_error) > 4096)
    or (p_output is not null and public.tool_data_contains_credentials(p_output))
    or (p_error is not null and public.tool_data_contains_credentials(p_error))
    or (p_output is null and p_error is null) then
    raise exception 'Invalid step result.' using errcode = '22023';
  end if;

  select r.* into v_run
  from public.workflow_plan_runs r
  where r.id = p_run_id
  for update;
  if not found or not public.is_workspace_member(v_run.workspace_id) then
    raise exception 'Plan run access is required.' using errcode = '42501';
  end if;

  select s.* into v_step
  from public.workflow_plan_step_runs s
  where s.run_id = v_run.id and s.step_id = p_step_id
  for update;
  if not found or v_step.execution_id is distinct from p_execution_id then
    raise exception 'Step execution identity does not match.' using errcode = '42501';
  end if;

  v_status := case when p_error is null then 'succeeded' else 'failed' end;
  if v_step.status <> 'running' then
    if v_step.status = v_status
      and v_step.output is not distinct from p_output
      and v_step.error is not distinct from p_error then
      return jsonb_build_object('step_id', v_step.step_id, 'status', v_step.status);
    end if;
    raise exception 'Step result is already final.' using errcode = '23505';
  end if;

  update public.workflow_plan_step_runs
  set status = v_status, output = case when p_error is null then coalesce(p_output, 'null'::jsonb) else null end,
      error = p_error, completed_at = now()
  where id = v_step.id
  returning * into v_step;

  if v_status = 'succeeded' and not exists (
    select 1 from public.workflow_plan_step_runs s
    where s.run_id = v_run.id and s.status <> 'succeeded'
  ) then
    update public.workflow_plan_runs
    set status = 'succeeded', completed_at = now()
    where id = v_run.id and status = 'running';
  end if;

  return jsonb_build_object('step_id', v_step.step_id, 'status', v_step.status);
end;
$$;

revoke all on function public.start_workflow_plan_run(uuid) from public, anon;
revoke all on function public.claim_workflow_plan_step(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_workflow_plan_step(uuid, text, uuid, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.start_workflow_plan_run(uuid) to authenticated;
grant execute on function public.claim_workflow_plan_step(uuid, text, uuid, uuid) to service_role;
grant execute on function public.finish_workflow_plan_step(uuid, text, uuid, jsonb, jsonb, uuid) to service_role;

commit;
