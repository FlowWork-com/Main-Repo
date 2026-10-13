create extension if not exists supabase_vault with schema vault;

create table public.workflow_plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id uuid not null,
  version integer not null check (version > 0),
  proposed_by uuid not null references auth.users (id) on delete restrict,
  plan jsonb not null check (jsonb_typeof(plan) = 'object' and pg_column_size(plan) <= 65536),
  decision text not null default 'proposed' check (decision in ('proposed', 'accepted', 'rejected')),
  decided_by uuid references auth.users (id) on delete restrict,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, task_id, version),
  foreign key (workspace_id, task_id)
    references public.tasks (workspace_id, id) on delete cascade,
  check (
    (decision = 'proposed' and decided_by is null and decided_at is null)
    or (decision in ('accepted', 'rejected') and decided_by is not null and decided_at is not null)
  )
);

create index workflow_plans_task_history_idx
  on public.workflow_plans (workspace_id, task_id, version desc);

alter table public.workflow_plans enable row level security;

create policy "workspace members can read workflow plans"
  on public.workflow_plans for select to authenticated
  using (public.is_workspace_member(workspace_id));

revoke all on public.workflow_plans from anon, authenticated;
grant select on public.workflow_plans to authenticated;

create function public.workflow_plan_has_cross_task_reference(p_value jsonb, p_task_id uuid)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_key text;
  v_child jsonb;
begin
  if jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in select key, value from jsonb_each(p_value)
    loop
      if lower(v_key) in ('taskid', 'task_id')
        and jsonb_typeof(v_child) = 'string'
        and v_child #>> '{}' <> p_task_id::text then
        return true;
      end if;
      if public.workflow_plan_has_cross_task_reference(v_child, p_task_id) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select value from jsonb_array_elements(p_value)
    loop
      if public.workflow_plan_has_cross_task_reference(v_child, p_task_id) then
        return true;
      end if;
    end loop;
  end if;
  return false;
end;
$$;

revoke all on function public.workflow_plan_has_cross_task_reference(jsonb, uuid)
  from public, anon, authenticated;

create function public.create_workflow_plan(
  p_task_id uuid,
  p_plan_json text,
  p_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_task_status text;
  v_version integer;
  v_plan_id uuid := gen_random_uuid();
  v_step jsonb;
  v_input jsonb;
  v_step_id text;
  v_ids text[] := array[]::text[];
  v_steps jsonb := '[]'::jsonb;
  v_validation text;
  v_plan jsonb;
  v_proposal jsonb;
  v_signing_key text;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_task_id is null or p_plan_json is null
    or octet_length(p_plan_json) > 65536
    or p_signature is null or p_signature !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid plan proposal.' using errcode = '22023';
  end if;
  select s.decrypted_secret into v_signing_key
  from vault.decrypted_secrets s
  where s.name = 'flowwork-plan-signing-key'
  limit 1;
  if v_signing_key is null
    or encode(public.hmac(p_plan_json, v_signing_key, 'sha256'), 'hex') <> p_signature then
    raise exception 'Plan proposal signature is invalid.' using errcode = '42501';
  end if;

  begin
    v_proposal := p_plan_json::jsonb;
  exception when others then
    raise exception 'Invalid plan proposal.' using errcode = '22023';
  end;
  if v_proposal is null
    or jsonb_typeof(v_proposal) is distinct from 'object'
    or pg_column_size(v_proposal) > 65536 then
    raise exception 'Invalid plan proposal.' using errcode = '22023';
  end if;

  select t.workspace_id, t.status
    into v_workspace_id, v_task_status
  from public.tasks t
  where t.id = p_task_id
  for update;
  if not found or not public.is_workspace_member(v_workspace_id) then
    raise exception 'Task access is required.' using errcode = '42501';
  end if;
  if v_task_status is distinct from 'Planning' then
    raise exception 'Plans can only be proposed while a task is Planning.' using errcode = '22023';
  end if;
  if v_proposal->>'taskId' is distinct from p_task_id::text
    or char_length(trim(coalesce(v_proposal->>'goal', ''))) not between 1 and 2000
    or char_length(trim(coalesce(v_proposal->>'summary', ''))) not between 1 and 400
    or jsonb_typeof(v_proposal->'steps') is distinct from 'array'
    or jsonb_array_length(v_proposal->'steps') > 10
    or jsonb_typeof(coalesce(v_proposal->'limitations', '[]'::jsonb)) is distinct from 'array'
    or jsonb_array_length(coalesce(v_proposal->'limitations', '[]'::jsonb)) > 20
    or jsonb_typeof(coalesce(v_proposal->'dependencies', '[]'::jsonb)) is distinct from 'array'
    or jsonb_array_length(coalesce(v_proposal->'dependencies', '[]'::jsonb)) > 10
    or exists (
      select 1 from jsonb_array_elements(coalesce(v_proposal->'limitations', '[]'::jsonb)) as limitations(value)
      where jsonb_typeof(limitations.value) is distinct from 'string'
        or char_length(limitations.value #>> '{}') > 400
    ) then
    raise exception 'Invalid plan proposal.' using errcode = '22023';
  end if;

  for v_step in select value from jsonb_array_elements(v_proposal->'steps')
  loop
    if jsonb_typeof(v_step) is distinct from 'object'
      or char_length(trim(coalesce(v_step->>'id', ''))) not between 1 and 200
      or char_length(trim(coalesce(v_step->>'title', ''))) not between 1 and 200
      or char_length(trim(coalesce(v_step->>'description', ''))) not between 1 and 1000
      or char_length(trim(coalesce(v_step->>'expectedOutcome', ''))) not between 1 and 1000
      or char_length(trim(coalesce(v_step->>'verificationCriteria', ''))) not between 1 and 1000
      or char_length(trim(coalesce(v_step->>'toolId', ''))) not between 1 and 100
      or char_length(trim(coalesce(v_step->>'toolVersion', ''))) not between 1 and 40
      or jsonb_typeof(v_step->'dependencies') is distinct from 'array'
      or jsonb_array_length(v_step->'dependencies') > 10
      or exists (
        select 1 from jsonb_array_elements(v_step->'dependencies') as dependencies(value)
        where jsonb_typeof(dependencies.value) is distinct from 'string'
          or char_length(dependencies.value #>> '{}') not between 1 and 200
      )
      or (select count(*) from jsonb_array_elements_text(v_step->'dependencies'))
        <> (select count(distinct value) from jsonb_array_elements_text(v_step->'dependencies') as dependencies(value))
      or jsonb_typeof(v_step->'input') is null
      or pg_column_size(v_step->'input') > 32768
      or public.tool_data_contains_credentials(v_step->'input')
      or public.workflow_plan_has_cross_task_reference(v_step->'input', p_task_id) then
      raise exception 'Invalid plan step.' using errcode = '22023';
    end if;

    v_step_id := v_step->>'id';
    if v_step_id = any(v_ids) then
      raise exception 'Plan step IDs must be unique.' using errcode = '22023';
    end if;
    v_ids := array_append(v_ids, v_step_id);

    if v_step->>'toolVersion' is distinct from '1.0.0'
      or v_step->>'toolId' not in ('echo', 'file-metadata', 'json-inspect', 'text-transform') then
      raise exception 'Plan contains an unsupported tool.' using errcode = '22023';
    end if;

    v_input := v_step->'input';
    if v_step->>'toolId' in ('text-transform', 'json-inspect', 'file-metadata')
      and jsonb_typeof(v_input) is distinct from 'object' then
      raise exception 'Plan contains invalid tool input.' using errcode = '22023';
    end if;
    if v_step->>'toolId' = 'text-transform' and (
      v_input->>'operation' not in ('uppercase', 'lowercase', 'trim', 'replace', 'extract')
      or jsonb_typeof(v_input->'text') is distinct from 'string'
      or (v_input->>'operation' = 'replace' and (
        jsonb_typeof(v_input->'search') is distinct from 'string'
        or char_length(v_input->>'search') = 0
        or jsonb_typeof(v_input->'replacement') is distinct from 'string'
      ))
      or (v_input->>'operation' = 'extract' and (
        jsonb_typeof(v_input->'start') is distinct from 'number'
        or jsonb_typeof(v_input->'end') is distinct from 'number'
        or (v_input->>'start')::numeric < 0
        or (v_input->>'end')::numeric < (v_input->>'start')::numeric
        or trunc((v_input->>'start')::numeric) <> (v_input->>'start')::numeric
        or trunc((v_input->>'end')::numeric) <> (v_input->>'end')::numeric
      ))
      or exists (
        select 1 from jsonb_object_keys(v_input) as keys(key)
        where keys.key not in ('operation', 'text', 'search', 'replacement', 'start', 'end')
      )
      or char_length(v_input->>'text') > 4000
      or char_length(coalesce(v_input->>'replacement', '')) > 4000
    ) then
      raise exception 'Plan contains invalid text-transform input.' using errcode = '22023';
    end if;

    if v_step->>'toolId' = 'json-inspect' and (
      jsonb_typeof(v_input) is distinct from 'object'
      or jsonb_object_length(v_input) <> 1
      or jsonb_typeof(v_input->'json') is distinct from 'string'
      or char_length(v_input->>'json') > 32768
    ) then
      raise exception 'Plan contains invalid json-inspect input.' using errcode = '22023';
    end if;
    if v_step->>'toolId' = 'json-inspect' then
      begin
        perform (v_input->>'json')::jsonb;
      exception when others then
        raise exception 'Plan contains invalid json-inspect input.' using errcode = '22023';
      end;
    end if;

    if v_step->>'toolId' = 'file-metadata' and (
      jsonb_typeof(v_input) is distinct from 'object'
      or jsonb_object_length(v_input) <> 1
      or coalesce(v_input->>'fileId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or not exists (
        select 1 from public.task_files f
        where f.id = (v_input->>'fileId')::uuid
          and f.task_id = p_task_id
          and f.workspace_id = v_workspace_id
      )
    ) then
      raise exception 'Plan contains invalid file-metadata input.' using errcode = '22023';
    end if;

    v_steps := v_steps || jsonb_build_array(
      jsonb_set(v_step, '{validation}', '{"valid":true,"blockingReasons":[]}'::jsonb, true)
    );
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(v_proposal->'steps') as steps(step)
    cross join lateral jsonb_array_elements_text(steps.step->'dependencies') as dependencies(dependency)
    where dependencies.dependency = steps.step->>'id'
      or not (dependencies.dependency = any(v_ids))
  ) then
    raise exception 'Plan contains an invalid dependency.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements_text(coalesce(v_proposal->'dependencies', '[]'::jsonb)) as dependencies(dependency)
    where not (dependencies.dependency = any(v_ids))
  ) or (
    select count(*) from jsonb_array_elements_text(coalesce(v_proposal->'dependencies', '[]'::jsonb))
  ) <> (
    select count(distinct dependency)
    from jsonb_array_elements_text(coalesce(v_proposal->'dependencies', '[]'::jsonb)) as dependencies(dependency)
  ) then
    raise exception 'Plan contains an invalid dependency.' using errcode = '22023';
  end if;

  if exists (
    with recursive edges(step_id, dependency_id) as (
      select steps.step->>'id', dependencies.dependency
      from jsonb_array_elements(v_proposal->'steps') as steps(step)
      cross join lateral jsonb_array_elements_text(steps.step->'dependencies') as dependencies(dependency)
    ), paths(start_id, node_id, path, has_cycle) as (
      select step_id, dependency_id, array[step_id, dependency_id], step_id = dependency_id
      from edges
      union all
      select paths.start_id, edges.dependency_id, paths.path || edges.dependency_id,
        edges.dependency_id = any(paths.path)
      from paths
      join edges on edges.step_id = paths.node_id
      where not paths.has_cycle
    )
    select 1 from paths where has_cycle
  ) then
    raise exception 'Plan dependency graph contains a cycle.' using errcode = '22023';
  end if;

  v_validation := case
    when lower(coalesce(v_proposal->>'goal', '') || ' ' || coalesce(v_proposal->'limitations', '[]'::jsonb)::text)
      ~ '(browser|playwright|puppeteer|selenium|automation|scrape|email|smtp|gmail|send mail|calendar|crm|slack|shell|filesystem)'
    then 'invalid'
    else 'valid'
  end;
  if (v_validation = 'valid' and jsonb_array_length(v_proposal->'steps') = 0)
    or (v_validation = 'invalid' and jsonb_array_length(v_proposal->'steps') <> 0) then
    raise exception 'Unsupported capabilities must be represented without executable steps.' using errcode = '22023';
  end if;
  select coalesce(max(p.version), 0) + 1 into v_version
  from public.workflow_plans p where p.workspace_id = v_workspace_id and p.task_id = p_task_id;

  v_plan := v_proposal || jsonb_build_object(
    'id', v_plan_id,
    'taskId', p_task_id,
    'version', v_version,
    'steps', v_steps,
    'validationStatus', v_validation
  );

  insert into public.workflow_plans (
    id, workspace_id, task_id, version, proposed_by, plan
  ) values (
    v_plan_id, v_workspace_id, p_task_id, v_version, v_user_id, v_plan
  );
  return jsonb_build_object(
    'id', v_plan_id,
    'workspace_id', v_workspace_id,
    'task_id', p_task_id,
    'version', v_version,
    'decision', 'proposed',
    'plan', v_plan,
    'created_at', now()
  );
end;
$$;

create function public.decide_workflow_plan(
  p_plan_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_plan public.workflow_plans%rowtype;
  v_task_status text;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_plan_id is null or p_decision not in ('accepted', 'rejected') then
    raise exception 'A valid plan decision is required.' using errcode = '22023';
  end if;

  select p.* into v_plan
  from public.workflow_plans p
  where p.id = p_plan_id
  for update;
  if not found or not public.is_workspace_member(v_plan.workspace_id) then
    raise exception 'Plan access is required.' using errcode = '42501';
  end if;
  select t.status into v_task_status
  from public.tasks t
  where t.id = v_plan.task_id and t.workspace_id = v_plan.workspace_id
  for update;
  if not found then
    raise exception 'Plan access is required.' using errcode = '42501';
  end if;
  if p_decision = 'accepted' and v_plan.plan->>'validationStatus' is distinct from 'valid' then
    raise exception 'An invalid plan cannot be accepted.' using errcode = '22023';
  end if;
  if v_plan.decision = p_decision then
    return jsonb_build_object('id', v_plan.id, 'decision', v_plan.decision, 'plan', v_plan.plan);
  end if;
  if p_decision = 'accepted' and v_task_status is distinct from 'Planning' then
    raise exception 'A plan can only be accepted while its task is Planning.' using errcode = '22023';
  end if;
  if v_plan.decision <> 'proposed' then
    raise exception 'The plan decision is already final.' using errcode = '23505';
  end if;

  update public.workflow_plans
  set decision = p_decision, decided_by = v_user_id, decided_at = now()
  where id = v_plan.id
  returning * into v_plan;

  return jsonb_build_object('id', v_plan.id, 'decision', v_plan.decision, 'plan', v_plan.plan);
end;
$$;

revoke all on function public.create_workflow_plan(uuid, text, text) from public, anon;
revoke all on function public.decide_workflow_plan(uuid, text) from public, anon;
grant execute on function public.create_workflow_plan(uuid, text, text) to authenticated;
grant execute on function public.decide_workflow_plan(uuid, text) to authenticated;