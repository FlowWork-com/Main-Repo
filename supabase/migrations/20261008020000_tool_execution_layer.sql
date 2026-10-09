create table public.task_tool_executions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id uuid not null,
  tool_id text not null check (char_length(trim(tool_id)) between 1 and 100),
  tool_version text not null check (char_length(trim(tool_version)) between 1 and 40),
  execution_id uuid not null,
  request_id text not null check (char_length(trim(request_id)) between 1 and 200),
  requested_by uuid not null references auth.users (id) on delete restrict,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  input jsonb not null check (pg_column_size(input) <= 65536),
  output jsonb check (output is null or pg_column_size(output) <= 65536),
  error jsonb check (
    error is null or (
      jsonb_typeof(error) = 'object'
      and pg_column_size(error) <= 4096
      and error->>'code' in (
        'TOOL_NOT_FOUND',
        'INVALID_TOOL_INPUT',
        'INVALID_EXECUTION_CONTEXT',
        'PERMISSION_DENIED',
        'APPROVAL_REQUIRED',
        'EXECUTION_FAILED',
        'EXECUTION_TIMEOUT',
        'EXECUTOR_UNAVAILABLE',
        'IDEMPOTENCY_CONFLICT',
        'EXECUTION_IN_PROGRESS'
      )
      and char_length(trim(coalesce(error->>'message', ''))) between 1 and 300
      and jsonb_typeof(error->'retryable') = 'boolean'
    )
  ),
  evidence jsonb check (
    evidence is null or (
      jsonb_typeof(evidence) = 'object'
      and pg_column_size(evidence) <= 4096
      and char_length(trim(coalesce(evidence->>'type', ''))) between 1 and 100
      and char_length(trim(coalesce(evidence->>'reference', ''))) between 1 and 500
      and char_length(coalesce(evidence->>'summary', '')) <= 500
    )
  ),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, task_id, execution_id),
  unique (workspace_id, task_id, request_id),
  foreign key (workspace_id, task_id)
    references public.tasks (workspace_id, id) on delete cascade,
  check (
    (status = 'running' and completed_at is null and output is null and error is null and evidence is null)
    or (status = 'succeeded' and completed_at is not null and output is not null and error is null)
    or (status = 'failed' and completed_at is not null and output is null and error is not null and evidence is null)
  )
);

create index task_tool_executions_history_idx
  on public.task_tool_executions (workspace_id, task_id, created_at desc);
create index task_tool_executions_requester_idx
  on public.task_tool_executions (workspace_id, requested_by, created_at desc);

alter table public.task_tool_executions enable row level security;

create policy "workspace members can read tool executions"
  on public.task_tool_executions for select to authenticated
  using (public.is_workspace_member(workspace_id));

revoke all on public.task_tool_executions from anon, authenticated;
grant select on public.task_tool_executions to authenticated;

create function public.tool_data_contains_credentials(p_value jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_key text;
  v_child jsonb;
begin
  if jsonb_typeof(p_value) = 'string'
    and p_value #>> '{}' ~* '(bearer[[:space:]]+[a-z0-9._~+/-]{8,}|(sk|pk|rk)_live_[a-z0-9]{8,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{20,}|akia[a-z0-9]{16}|eyj[a-z0-9_-]{10,}[.][a-z0-9_-]{10,}[.][a-z0-9_-]{10,}|-----begin [a-z ]*private key-----)' then
    return true;
  end if;
  if jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in select key, value from jsonb_each(p_value)
    loop
      if v_key ~* '(password|secret|token|credential|authorization|service.?role|api.?key)'
        or public.tool_data_contains_credentials(v_child) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select value from jsonb_array_elements(p_value)
    loop
      if public.tool_data_contains_credentials(v_child) then
        return true;
      end if;
    end loop;
  end if;
  return false;
end;
$$;

create function public.claim_task_tool_execution(
  p_workspace_id uuid,
  p_task_id uuid,
  p_execution_id uuid,
  p_request_id text,
  p_tool_id text,
  p_tool_version text,
  p_input jsonb
)
returns table (
  execution_id uuid,
  request_id text,
  tool_id text,
  tool_version text,
  input jsonb,
  status text,
  output jsonb,
  error jsonb,
  evidence jsonb,
  was_created boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_execution public.task_tool_executions%rowtype;
  v_task_workspace_id uuid;
  v_task_status text;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_workspace_id is null or not public.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access is required.' using errcode = '42501';
  end if;
  if p_task_id is null or p_execution_id is null
    or p_request_id is null or char_length(trim(p_request_id)) not between 1 and 200
    or p_tool_id is null or char_length(trim(p_tool_id)) not between 1 and 100
    or p_tool_version is null or char_length(trim(p_tool_version)) not between 1 and 40
    or p_input is null or pg_column_size(p_input) > 65536
    or public.tool_data_contains_credentials(p_input)
    or public.tool_data_contains_credentials(to_jsonb(p_request_id)) then
    raise exception 'Invalid tool execution request.' using errcode = '22023';
  end if;

  select t.workspace_id, t.status
    into v_task_workspace_id, v_task_status
  from public.tasks t
  where t.id = p_task_id
  for update;
  if not found or v_task_workspace_id is distinct from p_workspace_id then
    raise exception 'Task access is required.' using errcode = '42501';
  end if;

  insert into public.task_tool_executions (
    workspace_id, task_id, tool_id, tool_version, execution_id,
    request_id, requested_by, status, input
  ) values (
    p_workspace_id, p_task_id, p_tool_id, p_tool_version, p_execution_id,
    p_request_id, v_user_id, 'running', p_input
  )
  on conflict do nothing
  returning * into v_execution;

  if found then
    if v_task_status <> 'Running' then
      raise exception 'Task must be Running before tool execution.' using errcode = '22023';
    end if;
    return query select v_execution.execution_id, v_execution.request_id,
      v_execution.tool_id, v_execution.tool_version, v_execution.input,
      v_execution.status, v_execution.output, v_execution.error,
      v_execution.evidence, true;
    return;
  end if;

  select e.* into v_execution
  from public.task_tool_executions e
  where e.workspace_id = p_workspace_id
    and e.task_id = p_task_id
    and (e.execution_id = p_execution_id or e.request_id = p_request_id)
  limit 1;
  if not found then
    raise exception 'Execution identity conflicts with another request.' using errcode = '23505';
  end if;
  if v_execution.execution_id is distinct from p_execution_id
    or v_execution.request_id is distinct from p_request_id
    or v_execution.tool_id is distinct from p_tool_id
    or v_execution.tool_version is distinct from p_tool_version
    or v_execution.requested_by is distinct from v_user_id
    or v_execution.input is distinct from p_input then
    raise exception 'Execution identity was already used for a different request.' using errcode = '23505';
  end if;

  return query select v_execution.execution_id, v_execution.request_id,
    v_execution.tool_id, v_execution.tool_version, v_execution.input,
    v_execution.status, v_execution.output, v_execution.error,
    v_execution.evidence, false;
end;
$$;

create function public.finish_task_tool_execution(
  p_workspace_id uuid,
  p_task_id uuid,
  p_execution_id uuid,
  p_output jsonb,
  p_error jsonb,
  p_evidence jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_execution public.task_tool_executions%rowtype;
  v_status text;
  v_output jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_workspace_id is null or not public.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access is required.' using errcode = '42501';
  end if;
  if p_task_id is null or p_execution_id is null
    or (p_error is not null and p_output is not null)
    or (p_error is not null and jsonb_typeof(p_error) is distinct from 'object')
    or (p_error is not null and p_error->>'code' not in (
      'TOOL_NOT_FOUND',
      'INVALID_TOOL_INPUT',
      'INVALID_EXECUTION_CONTEXT',
      'PERMISSION_DENIED',
      'APPROVAL_REQUIRED',
      'EXECUTION_FAILED',
      'EXECUTION_TIMEOUT',
      'EXECUTOR_UNAVAILABLE',
      'IDEMPOTENCY_CONFLICT',
      'EXECUTION_IN_PROGRESS'
    ))
    or (p_error is not null and char_length(trim(coalesce(p_error->>'message', ''))) not between 1 and 300)
    or (p_error is not null and jsonb_typeof(p_error->'retryable') is distinct from 'boolean')
    or (p_evidence is not null and jsonb_typeof(p_evidence) is distinct from 'object')
    or (p_evidence is not null and char_length(trim(coalesce(p_evidence->>'type', ''))) not between 1 and 100)
    or (p_evidence is not null and char_length(trim(coalesce(p_evidence->>'reference', ''))) not between 1 and 500)
    or (p_evidence is not null and char_length(coalesce(p_evidence->>'summary', '')) > 500)
    or (p_error is not null and p_evidence is not null)
    or (p_output is not null and pg_column_size(p_output) > 65536)
    or (p_error is not null and pg_column_size(p_error) > 4096)
    or (p_evidence is not null and pg_column_size(p_evidence) > 4096)
    or (p_output is not null and public.tool_data_contains_credentials(p_output))
    or (p_error is not null and public.tool_data_contains_credentials(p_error))
    or (p_evidence is not null and public.tool_data_contains_credentials(p_evidence)) then
    raise exception 'Invalid tool execution result.' using errcode = '22023';
  end if;

  select e.* into v_execution
  from public.task_tool_executions e
  where e.workspace_id = p_workspace_id
    and e.task_id = p_task_id
    and e.execution_id = p_execution_id
  for update;
  if not found
    or v_execution.requested_by is distinct from v_user_id then
    raise exception 'Tool execution access is required.' using errcode = '42501';
  end if;

  v_status := case when p_error is null then 'succeeded' else 'failed' end;
  v_output := case when p_error is null then coalesce(p_output, 'null'::jsonb) else null end;
  if v_execution.status <> 'running' then
    if v_execution.status = v_status
      and v_execution.output is not distinct from v_output
      and v_execution.error is not distinct from p_error
      and v_execution.evidence is not distinct from p_evidence then
      return;
    end if;
    raise exception 'Tool execution result is already final.' using errcode = '23505';
  end if;

  update public.task_tool_executions
  set status = v_status,
      output = v_output,
      error = p_error,
      evidence = p_evidence,
      completed_at = now()
  where id = v_execution.id;
end;
$$;

revoke all on function public.claim_task_tool_execution(uuid, uuid, uuid, text, text, text, jsonb)
  from public, anon;
revoke all on function public.finish_task_tool_execution(uuid, uuid, uuid, jsonb, jsonb, jsonb)
  from public, anon;
revoke all on function public.tool_data_contains_credentials(jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_task_tool_execution(uuid, uuid, uuid, text, text, text, jsonb)
  to authenticated;
grant execute on function public.finish_task_tool_execution(uuid, uuid, uuid, jsonb, jsonb, jsonb)
  to authenticated;
