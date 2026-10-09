begin;

revoke all on function public.claim_task_tool_execution(
  uuid, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.finish_task_tool_execution(
  uuid, uuid, uuid, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;

drop function public.claim_task_tool_execution(
  uuid, uuid, uuid, text, text, text, jsonb
);
drop function public.finish_task_tool_execution(
  uuid, uuid, uuid, jsonb, jsonb, jsonb
);

create function public.claim_task_tool_execution(
  p_workspace_id uuid,
  p_task_id uuid,
  p_execution_id uuid,
  p_request_id text,
  p_tool_id text,
  p_tool_version text,
  p_input jsonb,
  p_actor_id uuid
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
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_execution public.task_tool_executions%rowtype;
  v_task_workspace_id uuid;
  v_task_status text;
begin
  if p_actor_id is null or p_workspace_id is null
    or not exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = p_workspace_id
        and wm.user_id = p_actor_id
    ) then
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

  select e.* into v_execution
  from public.task_tool_executions e
  where e.workspace_id = p_workspace_id
    and e.task_id = p_task_id
    and (e.execution_id = p_execution_id or e.request_id = p_request_id)
  limit 1
  for update;
  if found then
    if v_execution.execution_id is distinct from p_execution_id
      or v_execution.request_id is distinct from p_request_id
      or v_execution.tool_id is distinct from p_tool_id
      or v_execution.tool_version is distinct from p_tool_version
      or v_execution.requested_by is distinct from p_actor_id
      or v_execution.input is distinct from p_input then
      raise exception 'Execution identity was already used for a different request.'
        using errcode = '23505';
    end if;
    return query select v_execution.execution_id, v_execution.request_id,
      v_execution.tool_id, v_execution.tool_version, v_execution.input,
      v_execution.status, v_execution.output, v_execution.error,
      v_execution.evidence, false;
    return;
  end if;

  if v_task_status is distinct from 'Running' then
    raise exception 'Task must be Running before tool execution.' using errcode = '22023';
  end if;

  insert into public.task_tool_executions (
    workspace_id, task_id, tool_id, tool_version, execution_id,
    request_id, requested_by, status, input
  ) values (
    p_workspace_id, p_task_id, p_tool_id, p_tool_version, p_execution_id,
    p_request_id, p_actor_id, 'running', p_input
  )
  on conflict do nothing
  returning * into v_execution;

  if found then
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
  limit 1
  for update;
  if not found then
    raise exception 'Execution identity conflicts with another request.' using errcode = '23505';
  end if;
  if v_execution.execution_id is distinct from p_execution_id
    or v_execution.request_id is distinct from p_request_id
    or v_execution.tool_id is distinct from p_tool_id
    or v_execution.tool_version is distinct from p_tool_version
    or v_execution.requested_by is distinct from p_actor_id
    or v_execution.input is distinct from p_input then
    raise exception 'Execution identity was already used for a different request.'
      using errcode = '23505';
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
  p_evidence jsonb,
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_execution public.task_tool_executions%rowtype;
  v_task_workspace_id uuid;
  v_task_status text;
  v_status text;
  v_output jsonb;
begin
  if p_actor_id is null or p_workspace_id is null
    or not exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = p_workspace_id
        and wm.user_id = p_actor_id
    ) then
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

  select t.workspace_id, t.status
    into v_task_workspace_id, v_task_status
  from public.tasks t
  where t.id = p_task_id
  for update;
  if not found or v_task_workspace_id is distinct from p_workspace_id then
    raise exception 'Task access is required.' using errcode = '42501';
  end if;

  select e.* into v_execution
  from public.task_tool_executions e
  where e.workspace_id = p_workspace_id
    and e.task_id = p_task_id
    and e.execution_id = p_execution_id
  for update;
  if not found
    or v_execution.requested_by is distinct from p_actor_id then
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
  if v_task_status is distinct from 'Running' then
    raise exception 'Task must be Running to finalize tool execution.' using errcode = '22023';
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

revoke all on function public.claim_task_tool_execution(
  uuid, uuid, uuid, text, text, text, jsonb, uuid
) from public, anon, authenticated;
revoke all on function public.finish_task_tool_execution(
  uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid
) from public, anon, authenticated;
grant execute on function public.claim_task_tool_execution(
  uuid, uuid, uuid, text, text, text, jsonb, uuid
) to service_role;
grant execute on function public.finish_task_tool_execution(
  uuid, uuid, uuid, jsonb, jsonb, jsonb, uuid
) to service_role;

commit;
