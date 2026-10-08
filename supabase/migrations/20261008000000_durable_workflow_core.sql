create extension if not exists pgcrypto;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 120),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete restrict,
  role text not null default 'owner' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_id_idx
  on public.workspace_members (user_id, workspace_id);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete restrict,
  title text not null check (char_length(trim(title)) between 1 and 200),
  details text not null default '' check (char_length(details) <= 10000),
  status text not null check (
    status in ('Planning', 'Running', 'Waiting for approval', 'Verifying', 'Completed', 'Failed')
  ),
  attempt integer not null default 1 check (attempt > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create index tasks_workspace_updated_idx
  on public.tasks (workspace_id, updated_at desc);

create table public.task_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id uuid not null,
  sequence integer not null check (sequence > 0),
  event_type text not null check (
    event_type in (
      'task.created',
      'status.changed',
      'approval.requested',
      'approval.recorded',
      'verification.recorded'
    )
  ),
  actor_id uuid not null references auth.users (id) on delete restrict,
  occurred_at timestamptz not null,
  idempotency_key text not null check (char_length(trim(idempotency_key)) > 0),
  request_fingerprint text not null check (char_length(trim(request_fingerprint)) > 0),
  status_after text not null check (
    status_after in ('Planning', 'Running', 'Waiting for approval', 'Verifying', 'Completed', 'Failed')
  ),
  attempt integer not null check (attempt > 0),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  unique (task_id, sequence),
  unique (workspace_id, task_id, sequence),
  foreign key (workspace_id, task_id)
    references public.tasks (workspace_id, id) on delete cascade
);

create index task_events_task_timeline_idx
  on public.task_events (workspace_id, task_id, sequence);
create index task_events_task_idempotency_idx
  on public.task_events (task_id, idempotency_key);

create table public.task_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id uuid not null,
  event_sequence integer not null,
  label text not null check (char_length(trim(label)) between 1 and 120),
  status text not null check (
    status in ('Planning', 'Running', 'Waiting for approval', 'Verifying', 'Completed', 'Failed')
  ),
  occurred_at timestamptz not null,
  unique (task_id, event_sequence),
  foreign key (workspace_id, task_id)
    references public.tasks (workspace_id, id) on delete cascade,
  foreign key (workspace_id, task_id, event_sequence)
    references public.task_events (workspace_id, task_id, sequence) on delete cascade
);

create index task_steps_task_order_idx
  on public.task_steps (workspace_id, task_id, event_sequence);

create table public.task_approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id uuid not null,
  request_id text not null check (char_length(trim(request_id)) > 0),
  requested_by uuid not null references auth.users (id) on delete restrict,
  requested_at timestamptz not null,
  decision text check (decision in ('approved', 'rejected')),
  approver_id uuid references auth.users (id) on delete restrict,
  decided_at timestamptz,
  reason text,
  unique (task_id, request_id),
  foreign key (workspace_id, task_id)
    references public.tasks (workspace_id, id) on delete cascade,
  check (
    (decision is null and approver_id is null and decided_at is null)
    or (decision is not null and approver_id is not null and decided_at is not null)
  )
);

create index task_approvals_task_idx
  on public.task_approvals (workspace_id, task_id, requested_at);

create table public.task_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id uuid not null,
  file_name text not null check (char_length(trim(file_name)) between 1 and 255),
  storage_path text not null check (char_length(trim(storage_path)) > 0),
  content_type text,
  uploaded_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, task_id)
    references public.tasks (workspace_id, id) on delete cascade
);

create index task_files_task_idx
  on public.task_files (workspace_id, task_id, created_at);

create function public.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.workspace_members wm
      where wm.workspace_id = p_workspace_id
        and wm.user_id = auth.uid()
    );
$$;

revoke all on function public.is_workspace_member(uuid) from public, anon;
grant execute on function public.is_workspace_member(uuid) to authenticated;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.tasks enable row level security;
alter table public.task_steps enable row level security;
alter table public.task_events enable row level security;
alter table public.task_approvals enable row level security;
alter table public.task_files enable row level security;

create policy "workspace members can read their workspaces"
  on public.workspaces for select to authenticated
  using (public.is_workspace_member(id));

create policy "workspace members can read memberships"
  on public.workspace_members for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "workspace members can read tasks"
  on public.tasks for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "workspace members can read task steps"
  on public.task_steps for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "workspace members can read task events"
  on public.task_events for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "workspace members can read task approvals"
  on public.task_approvals for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "workspace members can read task files"
  on public.task_files for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "members can register their own task files"
  on public.task_files for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.tasks t
      where t.id = task_files.task_id
        and t.workspace_id = task_files.workspace_id
    )
  );

create policy "uploaders can remove their task file metadata"
  on public.task_files for delete to authenticated
  using (uploaded_by = auth.uid() and public.is_workspace_member(workspace_id));

revoke all on public.workspaces, public.workspace_members, public.tasks,
  public.task_steps, public.task_events, public.task_approvals, public.task_files
  from anon, authenticated;
grant select on public.workspaces, public.workspace_members, public.tasks,
  public.task_steps, public.task_events, public.task_approvals, public.task_files
  to authenticated;
grant insert, delete on public.task_files to authenticated;

create function public.create_workspace(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 120 then
    raise exception 'Workspace name must be between 1 and 120 characters.' using errcode = '22023';
  end if;

  insert into public.workspaces (name, created_by)
  values (trim(p_name), v_user_id)
  returning id into v_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, v_user_id, 'owner');
  return v_workspace_id;
end;
$$;

create function public.create_workflow_task(
  p_task_id uuid,
  p_workspace_id uuid,
  p_title text,
  p_details text,
  p_initial_event jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null or not public.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access is required.' using errcode = '42501';
  end if;
  if p_task_id is null
    or p_title is null or char_length(trim(p_title)) not between 1 and 200
    or p_details is null or char_length(p_details) > 10000
    or jsonb_typeof(p_initial_event) is distinct from 'object'
    or p_initial_event->>'eventType' is distinct from 'task.created'
    or (p_initial_event->>'sequence')::integer is distinct from 1
    or p_initial_event->>'statusAfter' is distinct from 'Planning'
    or (p_initial_event->>'attempt')::integer is distinct from 1
    or p_initial_event->>'actorId' is distinct from v_user_id::text
    or p_initial_event->>'idempotencyKey' is null
    or p_initial_event->>'requestFingerprint' is null then
    raise exception 'Invalid initial workflow event.' using errcode = '22023';
  end if;

  insert into public.tasks (id, workspace_id, owner_id, title, details, status, attempt)
  values (p_task_id, p_workspace_id, v_user_id, trim(p_title), p_details, 'Planning', 1);

  insert into public.task_events (
    workspace_id, task_id, sequence, event_type, actor_id, occurred_at,
    idempotency_key, request_fingerprint, status_after, attempt, payload
  ) values (
    p_workspace_id, p_task_id, 1, 'task.created', v_user_id,
    (p_initial_event->>'occurredAt')::timestamptz,
    p_initial_event->>'idempotencyKey',
    p_initial_event->>'requestFingerprint',
    'Planning', 1, coalesce(p_initial_event->'payload', '{}'::jsonb)
  );

  insert into public.task_steps (
    workspace_id, task_id, event_sequence, label, status, occurred_at
  ) values (
    p_workspace_id, p_task_id, 1, 'Planning', 'Planning',
    (p_initial_event->>'occurredAt')::timestamptz
  );
  return p_task_id;
end;
$$;

create function public.persist_workflow_events(
  p_task_id uuid,
  p_expected_sequence integer,
  p_status text,
  p_attempt integer,
  p_events jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_status text;
  v_attempt integer;
  v_event jsonb;
  v_payload jsonb;
  v_sequence integer;
  v_index integer := 0;
  v_type text;
  v_event_status text;
  v_event_attempt integer;
  v_request_id text;
  v_latest_request_id text;
  v_updated integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select t.workspace_id, t.status, t.attempt
    into v_workspace_id, v_status, v_attempt
  from public.tasks t
  where t.id = p_task_id
  for update;

  if not found or not public.is_workspace_member(v_workspace_id) then
    raise exception 'Task access is required.' using errcode = '42501';
  end if;
  if p_expected_sequence is null or p_expected_sequence < 1
    or p_events is null
    or jsonb_typeof(p_events) is distinct from 'array'
    or jsonb_array_length(p_events) = 0 then
    raise exception 'A non-empty event batch and valid sequence are required.' using errcode = '22023';
  end if;

  select count(*)::integer into v_sequence
  from public.task_events e where e.task_id = p_task_id;
  if v_sequence <> p_expected_sequence then
    raise exception 'Workflow changed; reload and retry.' using errcode = '40001';
  end if;

  for v_event in select value from jsonb_array_elements(p_events)
  loop
    v_index := v_index + 1;
    v_sequence := p_expected_sequence + v_index;
    v_type := v_event->>'eventType';
    v_event_status := v_event->>'statusAfter';
    v_event_attempt := (v_event->>'attempt')::integer;
    v_payload := coalesce(v_event->'payload', '{}'::jsonb);

    if jsonb_typeof(v_event) is distinct from 'object'
      or (v_event->>'sequence')::integer is distinct from v_sequence
      or v_event->>'actorId' is distinct from v_user_id::text
      or v_event->>'occurredAt' is null
      or v_event->>'idempotencyKey' is null
      or v_event->>'requestFingerprint' is null
      or v_type is null
      or v_type not in ('status.changed', 'approval.requested', 'approval.recorded', 'verification.recorded')
      or jsonb_typeof(v_payload) is distinct from 'object'
      or v_event_status is null
      or v_event_status not in ('Planning', 'Running', 'Waiting for approval', 'Verifying', 'Completed', 'Failed')
      or v_event_attempt is null
      or v_event_attempt < v_attempt or v_event_attempt > v_attempt + 1
      or exists (
        select 1 from public.task_events prior
        where prior.task_id = p_task_id
          and prior.sequence <= p_expected_sequence
          and prior.idempotency_key = v_event->>'idempotencyKey'
      ) then
      raise exception 'Invalid workflow event batch.' using errcode = '22023';
    end if;

    if v_type = 'status.changed' then
      if v_payload->>'from' is distinct from v_status
        or v_payload->>'to' is distinct from v_event_status then
        raise exception 'Workflow event state does not match persisted state.' using errcode = '22023';
      end if;
      if not (
        (v_status = 'Planning' and v_event_status in ('Running', 'Failed'))
        or (v_status = 'Running' and v_event_status in ('Waiting for approval', 'Verifying', 'Failed'))
        or (v_status = 'Waiting for approval' and v_event_status in ('Running', 'Failed'))
        or (v_status = 'Verifying' and v_event_status in ('Completed', 'Failed'))
        or (v_status = 'Failed' and v_event_status = 'Planning')
      ) then
        raise exception 'Workflow transition is not allowed.' using errcode = '22023';
      end if;
      if (v_status = 'Failed' and v_event_status = 'Planning')
        <> (v_event_attempt = v_attempt + 1) then
        raise exception 'Workflow attempt does not match its transition.' using errcode = '22023';
      end if;
      if v_event_status = 'Failed'
        and char_length(trim(coalesce(v_payload->>'reason', ''))) = 0 then
        raise exception 'Failed workflows require a reason.' using errcode = '22023';
      end if;
      if v_status = 'Failed' and v_event_status = 'Planning'
        and char_length(trim(coalesce(v_payload->>'reason', ''))) = 0 then
        raise exception 'Workflow retries require a reason.' using errcode = '22023';
      end if;
      if v_event_status = 'Completed' and not exists (
        select 1 from public.task_events verification
        where verification.task_id = p_task_id
          and verification.event_type = 'verification.recorded'
          and verification.attempt = v_attempt
          and verification.payload->'result'->>'passed' = 'true'
          and char_length(trim(coalesce(
            verification.payload->'result'->>'evidenceReference', ''
          ))) > 0
      ) then
        raise exception 'Completion requires persisted passing verification evidence.' using errcode = '22023';
      end if;
      if v_status = 'Waiting for approval' and v_event_status = 'Running' then
        select e.payload->>'requestId' into v_latest_request_id
        from public.task_events e
        where e.task_id = p_task_id and e.event_type = 'approval.requested'
        order by e.sequence desc
        limit 1;
        if v_latest_request_id is null or not exists (
          select 1 from public.task_approvals approval
          where approval.task_id = p_task_id
            and approval.request_id = v_latest_request_id
            and approval.decision = 'approved'
        ) then
          raise exception 'Leaving approval wait requires a recorded decision.' using errcode = '22023';
        end if;
      end if;
      v_status := v_event_status;
      v_attempt := v_event_attempt;
    elsif v_event_status <> v_status or v_event_attempt <> v_attempt then
      raise exception 'Non-transition events must match the persisted state.' using errcode = '22023';
    end if;

    insert into public.task_events (
      workspace_id, task_id, sequence, event_type, actor_id, occurred_at,
      idempotency_key, request_fingerprint, status_after, attempt, payload
    ) values (
      v_workspace_id, p_task_id, v_sequence, v_type, v_user_id,
      (v_event->>'occurredAt')::timestamptz,
      v_event->>'idempotencyKey', v_event->>'requestFingerprint',
      v_event_status, v_event_attempt, v_payload
    );

    if v_type = 'status.changed' then
      insert into public.task_steps (
        workspace_id, task_id, event_sequence, label, status, occurred_at
      ) values (
        v_workspace_id, p_task_id, v_sequence, v_event_status, v_event_status,
        (v_event->>'occurredAt')::timestamptz
      );
    elsif v_type = 'approval.requested' then
      v_request_id := v_payload->>'requestId';
      if v_status <> 'Waiting for approval'
        or v_request_id is null or char_length(trim(v_request_id)) = 0 then
        raise exception 'Approval request id is required.' using errcode = '22023';
      end if;
      insert into public.task_approvals (
        workspace_id, task_id, request_id, requested_by, requested_at
      ) values (
        v_workspace_id, p_task_id, v_request_id, v_user_id,
        (v_event->>'occurredAt')::timestamptz
      );
    elsif v_type = 'approval.recorded' then
      v_request_id := v_payload->'result'->>'requestId';
      select e.payload->>'requestId' into v_latest_request_id
      from public.task_events e
      where e.task_id = p_task_id and e.event_type = 'approval.requested'
      order by e.sequence desc
      limit 1;
      if v_status <> 'Waiting for approval'
        or v_request_id is distinct from v_latest_request_id
        or v_payload->'result'->>'approverId' is distinct from v_user_id::text
        or v_payload->'result'->>'decision' is null
        or v_payload->'result'->>'decision' not in ('approved', 'rejected')
        or v_payload->'result'->>'decidedAt' is null then
        raise exception 'Approval result is incomplete or unauthorized.' using errcode = '22023';
      end if;
      update public.task_approvals
      set decision = v_payload->'result'->>'decision',
          approver_id = v_user_id,
          decided_at = (v_payload->'result'->>'decidedAt')::timestamptz,
          reason = v_payload->'result'->>'reason'
      where task_id = p_task_id and request_id = v_request_id and decision is null;
      get diagnostics v_updated = row_count;
      if v_updated <> 1 then
        raise exception 'Pending approval request was not found.' using errcode = '22023';
      end if;
    elsif v_type = 'verification.recorded' then
      if v_status <> 'Verifying'
        or jsonb_typeof(v_payload->'result'->'passed') is distinct from 'boolean'
        or v_payload->'result'->>'evidenceReference' is null
        or char_length(trim(v_payload->'result'->>'evidenceReference')) = 0
        or v_payload->'result'->>'verifiedBy' is distinct from v_user_id::text
        or v_payload->'result'->>'verifiedAt' is null then
        raise exception 'Verification evidence is incomplete or unauthorized.' using errcode = '22023';
      end if;
    end if;
  end loop;

  if v_status <> p_status or v_attempt <> p_attempt then
    raise exception 'Task state does not match its event batch.' using errcode = '22023';
  end if;
  if p_status = 'Waiting for approval' then
    select e.payload->>'requestId' into v_latest_request_id
    from public.task_events e
    where e.task_id = p_task_id and e.event_type = 'approval.requested'
    order by e.sequence desc
    limit 1;
    if v_latest_request_id is null or not exists (
      select 1 from public.task_approvals approval
      where approval.task_id = p_task_id
        and approval.request_id = v_latest_request_id
        and approval.decision is null
    ) then
      raise exception 'Approval wait requires a persisted pending request.' using errcode = '22023';
    end if;
  end if;

  update public.tasks
  set status = p_status, attempt = p_attempt, updated_at = now()
  where id = p_task_id and workspace_id = v_workspace_id;
end;
$$;

revoke all on function public.create_workspace(text) from public, anon;
revoke all on function public.create_workflow_task(uuid, uuid, text, text, jsonb) from public, anon;
revoke all on function public.persist_workflow_events(uuid, integer, text, integer, jsonb) from public, anon;
grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.create_workflow_task(uuid, uuid, text, text, jsonb) to authenticated;
grant execute on function public.persist_workflow_events(uuid, integer, text, integer, jsonb) to authenticated;
