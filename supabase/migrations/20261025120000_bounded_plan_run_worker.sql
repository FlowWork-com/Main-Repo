begin;

alter table public.workflow_plan_runs
  drop constraint if exists workflow_plan_runs_status_check,
  drop constraint if exists workflow_plan_runs_check;

alter table public.workflow_plan_runs
  add constraint workflow_plan_runs_status_check
    check (status in ('running', 'paused', 'succeeded', 'failed', 'cancelled')),
  add constraint workflow_plan_runs_state_completed_check
    check (
      (status in ('running', 'paused') and completed_at is null)
      or (status in ('succeeded', 'failed', 'cancelled') and completed_at is not null)
    ),
  add column policy_version text not null default 'phase6-v1'
    check (char_length(trim(policy_version)) between 1 and 40),
  add column max_elapsed_seconds integer not null default 900
    check (max_elapsed_seconds between 60 and 1800),
  add column max_step_attempts integer not null default 1
    check (max_step_attempts between 1 and 3),
  add column pause_reason text,
  add column worker_lease_owner uuid,
  add column worker_lease_expires_at timestamptz,
  add column last_heartbeat_at timestamptz,
  add column cancel_requested_at timestamptz;

create index workflow_plan_runs_worker_lease_idx
  on public.workflow_plan_runs (worker_lease_expires_at, created_at)
  where status = 'running';

create table public.workflow_plan_run_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.workflow_plan_runs(id) on delete cascade,
  workspace_id uuid not null,
  task_id uuid not null,
  event_type text not null check (event_type in (
    'worker_claimed', 'step_succeeded', 'step_failed', 'paused',
    'resumed', 'cancelled', 'lease_expired', 'run_succeeded'
  )),
  actor_id uuid references auth.users(id) on delete restrict,
  worker_id uuid,
  error_code text check (error_code is null or error_code in (
    'APPROVAL_REQUIRED', 'PERMISSION_DENIED', 'INVALID_TOOL_INPUT',
    'TOOL_NOT_FOUND', 'EXECUTION_FAILED', 'EXECUTION_TIMEOUT',
    'EXECUTOR_UNAVAILABLE', 'EXECUTION_IN_PROGRESS', 'INVALID_EXECUTION_CONTEXT',
    'IDEMPOTENCY_CONFLICT', 'UNRESOLVED_DEPENDENCY', 'ELAPSED_LIMIT',
    'EXPIRED_LEASE_AMBIGUOUS_STEP', 'UNKNOWN'
  )),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 4096),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, task_id)
    references public.tasks(workspace_id, id) on delete cascade
);

create index workflow_plan_run_events_history_idx
  on public.workflow_plan_run_events (workspace_id, task_id, occurred_at, id);

alter table public.workflow_plan_run_events enable row level security;
create policy "workspace members can read plan run events"
  on public.workflow_plan_run_events for select to authenticated
  using (public.is_workspace_member(workspace_id));
revoke all on public.workflow_plan_run_events from anon, authenticated;
grant select on public.workflow_plan_run_events to authenticated;

create function public.claim_workflow_plan_run_worker(
  p_run_id uuid,
  p_worker_id uuid,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_run public.workflow_plan_runs%rowtype;
  v_running_step text;
begin
  if p_run_id is null or p_worker_id is null
    or p_lease_seconds is null or p_lease_seconds not between 30 and 180 then
    raise exception 'Invalid worker claim.' using errcode = '22023';
  end if;

  select r.* into v_run
  from public.workflow_plan_runs r
  where r.id = p_run_id
  for update;
  if not found then
    raise exception 'Plan run was not found.' using errcode = 'P0002';
  end if;
  if v_run.status <> 'running' then
    return jsonb_build_object('status', v_run.status, 'run_id', v_run.id);
  end if;
  if v_run.started_at < clock_timestamp() - make_interval(secs => v_run.max_elapsed_seconds) then
    update public.workflow_plan_runs
    set status = 'paused', pause_reason = 'elapsed_limit',
        worker_lease_owner = null, worker_lease_expires_at = null,
        last_heartbeat_at = clock_timestamp()
    where id = v_run.id;
    insert into public.workflow_plan_run_events (
      run_id, workspace_id, task_id, event_type, worker_id, error_code
    ) values (
      v_run.id, v_run.workspace_id, v_run.task_id, 'paused', p_worker_id, 'ELAPSED_LIMIT'
    );
    return jsonb_build_object('status', 'paused', 'reason', 'elapsed_limit', 'run_id', v_run.id);
  end if;
  if v_run.worker_lease_expires_at is not null
    and v_run.worker_lease_expires_at > clock_timestamp() then
    return jsonb_build_object('status', 'busy', 'run_id', v_run.id);
  end if;

  if v_run.worker_lease_expires_at is not null
    and v_run.worker_lease_expires_at <= clock_timestamp() then
    select s.step_id into v_running_step
    from public.workflow_plan_step_runs s
    where s.run_id = v_run.id and s.status = 'running'
    order by s.step_index
    limit 1;
    if v_running_step is not null then
      update public.workflow_plan_runs
      set status = 'paused', pause_reason = 'expired_lease_ambiguous_step',
          worker_lease_owner = null, worker_lease_expires_at = null,
          last_heartbeat_at = clock_timestamp()
      where id = v_run.id;
      insert into public.workflow_plan_run_events (
        run_id, workspace_id, task_id, event_type, worker_id,
        error_code, metadata
      ) values (
        v_run.id, v_run.workspace_id, v_run.task_id, 'lease_expired', p_worker_id,
        'EXPIRED_LEASE_AMBIGUOUS_STEP', jsonb_build_object('step_id', v_running_step)
      );
      return jsonb_build_object(
        'status', 'paused', 'reason', 'expired_lease_ambiguous_step',
        'run_id', v_run.id, 'step_id', v_running_step
      );
    end if;
  end if;

  update public.workflow_plan_runs
  set worker_lease_owner = p_worker_id,
      worker_lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_heartbeat_at = clock_timestamp()
  where id = v_run.id and status = 'running'
  returning * into v_run;

  insert into public.workflow_plan_run_events (
    run_id, workspace_id, task_id, event_type, worker_id
  ) values (
    v_run.id, v_run.workspace_id, v_run.task_id, 'worker_claimed', p_worker_id
  );

  return jsonb_build_object(
    'status', 'running', 'run_id', v_run.id, 'task_id', v_run.task_id,
    'workspace_id', v_run.workspace_id, 'actor_id', v_run.started_by,
    'lease_expires_at', v_run.worker_lease_expires_at
  );
end;
$$;

create function public.finish_workflow_plan_run_worker(
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
  v_event text;
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

  if not p_step_succeeded then
    v_code := coalesce(p_error_code, 'UNKNOWN');
    update public.workflow_plan_runs
    set status = 'paused', pause_reason = 'step_failed:' || v_code,
        worker_lease_owner = null, worker_lease_expires_at = null,
        last_heartbeat_at = clock_timestamp()
    where id = v_run.id;
    insert into public.workflow_plan_run_events (
      run_id, workspace_id, task_id, event_type, worker_id, error_code,
      metadata
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

create function public.pause_workflow_plan_run(p_run_id uuid)
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
    update public.workflow_plan_runs
    set status = 'paused', pause_reason = 'user_paused'
    where id = v_run.id;
    insert into public.workflow_plan_run_events (
      run_id, workspace_id, task_id, event_type, actor_id
    ) values (v_run.id, v_run.workspace_id, v_run.task_id, 'paused', v_user_id);
  end if;
  return jsonb_build_object('id', v_run.id, 'status', case when v_run.status = 'running' then 'paused' else v_run.status end);
end;
$$;

create function public.resume_workflow_plan_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_run public.workflow_plan_runs%rowtype;
  v_task_status text;
begin
  select r.* into v_run
  from public.workflow_plan_runs r
  join public.workspace_members wm on wm.workspace_id = r.workspace_id and wm.user_id = v_user_id
  where r.id = p_run_id
  for update of r;
  if v_user_id is null or not found then
    raise exception 'Plan run access is required.' using errcode = '42501';
  end if;
  if v_run.status <> 'paused' or v_run.pause_reason is distinct from 'user_paused' then
    raise exception 'Only a user-paused run can be resumed automatically.' using errcode = '22023';
  end if;
  if v_run.worker_lease_expires_at is not null and v_run.worker_lease_expires_at > clock_timestamp() then
    raise exception 'The active worker must finish or expire before resuming.' using errcode = '55P03';
  end if;
  if exists (
    select 1 from public.workflow_plan_step_runs s
    where s.run_id = v_run.id and s.status in ('failed', 'running', 'blocked')
  ) then
    raise exception 'A step requires manual review before this run can resume.' using errcode = '22023';
  end if;
  select t.status into v_task_status
  from public.tasks t where t.id = v_run.task_id and t.workspace_id = v_run.workspace_id;
  if v_task_status is distinct from 'Running' then
    raise exception 'Task must remain Running before resuming.' using errcode = '22023';
  end if;

  update public.workflow_plan_runs
  set status = 'running', pause_reason = null, completed_at = null
  where id = v_run.id;
  insert into public.workflow_plan_run_events (
    run_id, workspace_id, task_id, event_type, actor_id
  ) values (v_run.id, v_run.workspace_id, v_run.task_id, 'resumed', v_user_id);
  return jsonb_build_object('id', v_run.id, 'status', 'running');
end;
$$;

create function public.cancel_workflow_plan_run(p_run_id uuid)
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
  if v_run.status in ('running', 'paused') then
    update public.workflow_plan_runs
    set status = 'cancelled', completed_at = clock_timestamp(),
        cancel_requested_at = clock_timestamp(), pause_reason = 'user_cancelled'
    where id = v_run.id;
    insert into public.workflow_plan_run_events (
      run_id, workspace_id, task_id, event_type, actor_id
    ) values (v_run.id, v_run.workspace_id, v_run.task_id, 'cancelled', v_user_id);
  end if;
  return jsonb_build_object('id', v_run.id, 'status', case when v_run.status in ('running', 'paused') then 'cancelled' else v_run.status end);
end;
$$;

revoke all on function public.claim_workflow_plan_run_worker(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.finish_workflow_plan_run_worker(uuid, uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.claim_workflow_plan_run_worker(uuid, uuid, integer) to service_role;
grant execute on function public.finish_workflow_plan_run_worker(uuid, uuid, text, boolean, text) to service_role;

revoke all on function public.pause_workflow_plan_run(uuid) from public, anon;
revoke all on function public.resume_workflow_plan_run(uuid) from public, anon;
revoke all on function public.cancel_workflow_plan_run(uuid) from public, anon;
grant execute on function public.pause_workflow_plan_run(uuid) to authenticated;
grant execute on function public.resume_workflow_plan_run(uuid) to authenticated;
grant execute on function public.cancel_workflow_plan_run(uuid) to authenticated;

commit;
