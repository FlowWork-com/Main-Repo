begin;

-- The trusted Edge Function supplies an authenticated workspace-member ID.
-- auth.uid() is NULL for service_role, so these functions must rely on the
-- explicit membership check instead of the user-JWT helper.
create or replace function public.claim_workflow_plan_step(
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
  if not found then
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

create or replace function public.finish_workflow_plan_step(
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
    or (p_error is not null and public.tool_data_contains_credentials(p_error)) then
    raise exception 'Invalid step result.' using errcode = '22023';
  end if;

  select r.* into v_run
  from public.workflow_plan_runs r
  where r.id = p_run_id
  for update;
  if not found then
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

commit;
