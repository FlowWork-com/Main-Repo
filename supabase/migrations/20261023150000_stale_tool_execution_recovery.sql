begin;

create index task_tool_executions_stale_running_idx
  on public.task_tool_executions (started_at, workspace_id, task_id)
  where status = 'running';

create or replace function public.recover_stale_tool_executions(
  p_older_than_seconds integer default 600,
  p_batch_size integer default 100
)
returns table (
  execution_id uuid,
  task_id uuid,
  completed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_older_than_seconds is null or p_older_than_seconds not between 120 and 86400
    or p_batch_size is null or p_batch_size not between 1 and 500 then
    raise exception 'Recovery age must be between 120 seconds and 24 hours and batch size between 1 and 500.'
      using errcode = '22023';
  end if;

  return query
  with candidates as (
    select e.workspace_id, e.task_id, e.execution_id
    from public.task_tool_executions e
    where e.status = 'running'
      and e.started_at <= v_now - make_interval(secs => p_older_than_seconds)
    order by e.started_at, e.workspace_id, e.task_id, e.execution_id
    limit p_batch_size
    for update skip locked
  ),
  recovered as (
    update public.task_tool_executions e
    set status = 'failed',
        output = null,
        error = jsonb_build_object(
          'code', 'EXECUTION_TIMEOUT',
          'message', 'Execution exceeded the recovery deadline. Check task history before deciding whether a new attempt is safe.',
          'retryable', true
        ),
        evidence = null,
        completed_at = v_now
    from candidates c
    where e.workspace_id = c.workspace_id
      and e.task_id = c.task_id
      and e.execution_id = c.execution_id
      and e.status = 'running'
    returning e.execution_id, e.task_id, e.completed_at
  )
  select r.execution_id, r.task_id, r.completed_at
  from recovered r;
end;
$$;

revoke all on function public.recover_stale_tool_executions(integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.recover_stale_tool_executions(integer, integer)
  to service_role;

comment on function public.recover_stale_tool_executions(integer, integer) is
  'Service-role-only recovery for abandoned running tool executions. Marks a bounded batch as timed out without replaying tools or changing workflow status.';

commit;
