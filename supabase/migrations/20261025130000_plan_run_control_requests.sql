begin;

alter table public.workflow_plan_run_events
  drop constraint if exists workflow_plan_run_events_event_type_check;
alter table public.workflow_plan_run_events
  add constraint workflow_plan_run_events_event_type_check
  check (event_type in (
    'worker_claimed', 'step_succeeded', 'step_failed', 'paused',
    'pause_requested', 'resumed', 'cancelled', 'cancel_requested',
    'lease_expired', 'run_succeeded'
  ));

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
  if v_run.pause_reason in ('user_pause_requested', 'user_cancel_requested')
    or v_run.cancel_requested_at is not null then
    raise exception 'A pause or cancellation request is pending.' using errcode = '55P03';
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

create or replace function public.finish_workflow_plan_run_worker(
  p_run_id uuid,
  p_worker_id uuid,
  p_step_id text,
  p_step_succeeded boolean,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_run public.workflow_plan_runs%rowtype;
  v_step_status text;
  v_pending integer;
  v_failed integer;
  v_running integer;
  v_code text;
begin
  if p_run_id is null or p_worker_id is null
    or p_step_succeeded is null
    or (p_error_code is not null and p_error_code not in (
      'APPROVAL_REQUIRED', 'PERMISSION_DENIED', 'INVALID_TOOL_INPUT',
      'TOOL_NOT_FOUND', 'EXECUTION_FAILED', 'EXECUTION_TIMEOUT',
      'EXECUTOR_UNAVAILABLE', 'EXECUTION_IN_PROGRESS', 'INVALID_EXECUTION_CONTEXT',
      'IDEMPOTENCY_CONFLICT', 'UNKNOWN'
    )) then
    raise exception 'Invalid worker result.' using errcode = '22023';
  end if;

  select r.* into v_run
  from public.workflow_plan_runs r
  where r.id = p_run_id
  for update;
  if not found then
    raise exception 'Plan run was not found.' using errcode = 'P0002';
  end if;
  if v_run.worker_lease_owner is distinct from p_worker_id then
    raise exception 'Worker lease ownership does not match.' using errcode = '42501';
  end if;

  if p_step_id is not null then
    select s.status into v_step_status
    from public.workflow_plan_step_runs s
    where s.run_id = v_run.id and s.step_id = p_step_id;
    if not found then
      raise exception 'Plan step was not found.' using errcode = '22023';
    end if;
    if p_step_succeeded and v_step_status <> 'succeeded' then
      raise exception 'Step success has not been durably recorded.' using errcode = '22023';
    end if;
    if not p_step_succeeded and v_step_status = 'succeeded' then
      raise exception 'A succeeded step cannot be marked failed.' using errcode = '22023';
    end if;
  end if;

  if v_run.status in ('paused', 'cancelled', 'failed', 'succeeded') then
    update public.workflow_plan_runs
    set worker_lease_owner = null, worker_lease_expires_at = null,
        last_heartbeat_at = clock_timestamp()
    where id = v_run.id;
    return jsonb_build_object('status', v_run.status, 'run_id', v_run.id);
  end if;

  if v_run.cancel_requested_at is not null or v_run.pause_reason = 'user_cancel_requested' then
    update public.workflow_plan_runs
    set status = 'cancelled', completed_at = clock_timestamp(),
        pause_reason = 'user_cancelled', worker_lease_owner = null,
        worker_lease_expires_at = null, last_heartbeat_at = clock_timestamp()
    where id = v_run.id;
    insert into public.workflow_plan_run_events (
      run_id, workspace_id, task_id, event_type, worker_id, error_code, metadata
    ) values (
      v_run.id, v_run.workspace_id, v_run.task_id, 'cancelled', p_worker_id,
      case when p_step_succeeded then null else coalesce(p_error_code, 'UNKNOWN') end,
      case when p_step_id is null then '{}'::jsonb else jsonb_build_object('step_id', p_step_id) end
    );
    return jsonb_build_object('status', 'cancelled', 'run_id', v_run.id);
  end if;

  if v_run.pause_reason = 'user_pause_requested'
    and (p_step_id is null or v_step_status = 'pending') then
    update public.workflow_plan_runs
    set status = 'paused', pause_reason = 'user_paused',
        worker_lease_owner = null, worker_lease_expires_at = null,
        last_heartbeat_at = clock_timestamp()
    where id = v_run.id;
    insert into public.workflow_plan_run_events (
      run_id, workspace_id, task_id, event_type, worker_id, metadata
    ) values (
      v_run.id, v_run.workspace_id, v_run.task_id, 'paused', p_worker_id,
      jsonb_build_object('reason', 'user_paused')
    );
    return jsonb_build_object('status', 'paused', 'run_id', v_run.id);
  end if;

  if not p_step_succeeded then
    v_code := coalesce(p_error_code, 'UNKNOWN');
    update public.workflow_plan_runs
    set status = 'paused', pause_reason = 'step_failed:' || v_code,
        worker_lease_owner = null, worker_lease_expires_at = null,
        last_heartbeat_at = clock_timestamp()
    where id = v_run.id;
    insert into public.workflow_plan_run_events (
      run_id, workspace_id, task_id, event_type, worker_id, error_code, metadata
    ) values (
      v_run.id, v_run.workspace_id, v_run.task_id, 'step_failed', p_worker_id, v_code,
      case when p_step_id is null then '{}'::jsonb else jsonb_build_object('step_id', p_step_id) end
    );
    return jsonb_build_object('status', 'paused', 'reason', 'step_failed:' || v_code, 'run_id', v_run.id);
  end if;

  select count(*) filter (where status = 'pending'),
         count(*) filter (where status = 'failed'),
         count(*) filter (where status = 'running')
  into v_pending, v_failed, v_running
  from public.workflow_plan_step_runs
  where run_id = v_run.id;

  if v_failed > 0 or v_running > 0 then
    update public.workflow_plan_runs
    set status = 'paused', pause_reason = 'step_state_requires_review',
        worker_lease_owner = null, worker_lease_expires_at = null,
        last_heartbeat_at = clock_timestamp()
    where id = v_run.id;
    insert into public.workflow_plan_run_events (
      run_id, workspace_id, task_id, event_type, worker_id, error_code
    ) values (
      v_run.id, v_run.workspace_id, v_run.task_id, 'paused', p_worker_id, 'UNKNOWN'
    );
    return jsonb_build_object('status', 'paused', 'reason', 'step_state_requires_review', 'run_id', v_run.id);
  end if;

  if v_pending = 0 then
    update public.workflow_plan_runs
    set status = 'succeeded', completed_at = clock_timestamp(), pause_reason = null,
        worker_lease_owner = null, worker_lease_expires_at = null,
        last_heartbeat_at = clock_timestamp()
    where id = v_run.id and status = 'running';
    insert into public.workflow_plan_run_events (
      run_id, workspace_id, task_id, event_type, worker_id
    ) values (
      v_run.id, v_run.workspace_id, v_run.task_id, 'run_succeeded', p_worker_id
    );
    return jsonb_build_object('status', 'succeeded', 'run_id', v_run.id);
  end if;

  if v_run.pause_reason = 'user_pause_requested' then
    update public.workflow_plan_runs
    set status = 'paused', pause_reason = 'user_paused',
        worker_lease_owner = null, worker_lease_expires_at = null,
        last_heartbeat_at = clock_timestamp()
    where id = v_run.id;
    insert into public.workflow_plan_run_events (
      run_id, workspace_id, task_id, event_type, worker_id, metadata
    ) values (
      v_run.id, v_run.workspace_id, v_run.task_id, 'paused', p_worker_id,
      jsonb_build_object('reason', 'user_paused')
    );
    return jsonb_build_object('status', 'paused', 'run_id', v_run.id);
  end if;

  update public.workflow_plan_runs
  set worker_lease_owner = null, worker_lease_expires_at = null,
      last_heartbeat_at = clock_timestamp(), pause_reason = null
  where id = v_run.id and status = 'running';

  insert into public.workflow_plan_run_events (
    run_id, workspace_id, task_id, event_type, worker_id, metadata
  ) values (
    v_run.id, v_run.workspace_id, v_run.task_id, 'step_succeeded', p_worker_id,
    case when p_step_id is null then '{}'::jsonb else jsonb_build_object('step_id', p_step_id) end
  );

  return jsonb_build_object('status', 'running', 'run_id', v_run.id);
end;
$$;

create or replace function public.pause_workflow_plan_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_run public.workflow_plan_runs%rowtype;
begin
  select r.* into v_run
  from public.workflow_plan_runs r
  join public.workspace_members wm on wm.workspace_id = r.workspace_id and wm.user_id = v_user_id
  where r.id = p_run_id
  for update of r;
  if v_user_id is null or not found then
    raise exception 'Plan run access is required.' using errcode = '42501';
  end if;
  if v_run.cancel_requested_at is not null then
    raise exception 'Cancellation is already requested.' using errcode = '22023';
  end if;

  if v_run.status = 'running' then
    if v_run.worker_lease_owner is not null then
      update public.workflow_plan_runs
      set pause_reason = 'user_pause_requested'
      where id = v_run.id;
      insert into public.workflow_plan_run_events (
        run_id, workspace_id, task_id, event_type, actor_id, metadata
      ) values (
        v_run.id, v_run.workspace_id, v_run.task_id, 'pause_requested', v_user_id,
        jsonb_build_object('request_pending', true)
      );
      return jsonb_build_object('id', v_run.id, 'status', 'running', 'pause_requested', true);
    end if;

    update public.workflow_plan_runs
    set status = 'paused', pause_reason = 'user_paused'
    where id = v_run.id;
    insert into public.workflow_plan_run_events (
      run_id, workspace_id, task_id, event_type, actor_id
    ) values (v_run.id, v_run.workspace_id, v_run.task_id, 'paused', v_user_id);
    return jsonb_build_object('id', v_run.id, 'status', 'paused', 'pause_requested', false);
  end if;
  return jsonb_build_object('id', v_run.id, 'status', v_run.status);
end;
$$;

create or replace function public.cancel_workflow_plan_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_run public.workflow_plan_runs%rowtype;
begin
  select r.* into v_run
  from public.workflow_plan_runs r
  join public.workspace_members wm on wm.workspace_id = r.workspace_id and wm.user_id = v_user_id
  where r.id = p_run_id
  for update of r;
  if v_user_id is null or not found then
    raise exception 'Plan run access is required.' using errcode = '42501';
  end if;

  if v_run.status = 'running' then
    if v_run.worker_lease_owner is not null then
      update public.workflow_plan_runs
      set cancel_requested_at = coalesce(cancel_requested_at, clock_timestamp()),
          pause_reason = 'user_cancel_requested'
      where id = v_run.id;
      insert into public.workflow_plan_run_events (
        run_id, workspace_id, task_id, event_type, actor_id, metadata
      ) values (
        v_run.id, v_run.workspace_id, v_run.task_id, 'cancel_requested', v_user_id,
        jsonb_build_object('request_pending', true)
      );
      return jsonb_build_object('id', v_run.id, 'status', 'running', 'cancel_requested', true);
    end if;

    update public.workflow_plan_runs
    set status = 'cancelled', completed_at = clock_timestamp(),
        cancel_requested_at = clock_timestamp(), pause_reason = 'user_cancelled'
    where id = v_run.id;
    insert into public.workflow_plan_run_events (
      run_id, workspace_id, task_id, event_type, actor_id
    ) values (v_run.id, v_run.workspace_id, v_run.task_id, 'cancelled', v_user_id);
    return jsonb_build_object('id', v_run.id, 'status', 'cancelled', 'cancel_requested', false);
  elsif v_run.status = 'paused' then
    update public.workflow_plan_runs
    set status = 'cancelled', completed_at = clock_timestamp(),
        cancel_requested_at = clock_timestamp(), pause_reason = 'user_cancelled'
    where id = v_run.id;
    insert into public.workflow_plan_run_events (
      run_id, workspace_id, task_id, event_type, actor_id
    ) values (v_run.id, v_run.workspace_id, v_run.task_id, 'cancelled', v_user_id);
    return jsonb_build_object('id', v_run.id, 'status', 'cancelled', 'cancel_requested', false);
  end if;

  return jsonb_build_object('id', v_run.id, 'status', v_run.status, 'cancel_requested', false);
end;
$$;

revoke all on function public.claim_workflow_plan_step(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_workflow_plan_step(uuid, text, uuid, uuid)
  to service_role;

commit;
