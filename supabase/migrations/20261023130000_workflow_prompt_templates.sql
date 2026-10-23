begin;

create table public.workflow_prompt_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  prompt text not null check (char_length(trim(prompt)) between 3 and 2000),
  current_version integer not null default 1 check (current_version > 0),
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (workspace_id, id)
);

create index workflow_prompt_templates_workspace_idx
  on public.workflow_prompt_templates (workspace_id, updated_at desc)
  where archived_at is null;

create table public.workflow_prompt_template_versions (
  workspace_id uuid not null,
  template_id uuid not null,
  version integer not null check (version > 0),
  name text not null check (char_length(trim(name)) between 1 and 80),
  prompt text not null check (char_length(trim(prompt)) between 3 and 2000),
  change_kind text not null check (change_kind in ('created', 'updated', 'archived')),
  changed_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (workspace_id, template_id, version),
  foreign key (workspace_id, template_id)
    references public.workflow_prompt_templates (workspace_id, id) on delete cascade
);

create index workflow_prompt_template_versions_history_idx
  on public.workflow_prompt_template_versions (workspace_id, template_id, version desc);

alter table public.workflow_prompt_templates enable row level security;
alter table public.workflow_prompt_template_versions enable row level security;

create policy "workspace members can read prompt templates"
  on public.workflow_prompt_templates for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "workspace members can read prompt template versions"
  on public.workflow_prompt_template_versions for select to authenticated
  using (public.is_workspace_member(workspace_id));

revoke all on public.workflow_prompt_templates, public.workflow_prompt_template_versions
  from public, anon, authenticated, service_role;
grant select on public.workflow_prompt_templates, public.workflow_prompt_template_versions
  to authenticated;

create or replace function public.save_workflow_prompt_template(
  p_workspace_id uuid,
  p_template_id uuid,
  p_name text,
  p_prompt text,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_template public.workflow_prompt_templates%rowtype;
  v_template_id uuid;
  v_next_version integer;
  v_change_kind text;
begin
  if v_user_id is null or p_workspace_id is null
    or not public.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access is required.' using errcode = '42501';
  end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 80
    or p_prompt is null or char_length(trim(p_prompt)) not between 3 and 2000
    or public.tool_data_contains_credentials(to_jsonb(p_name))
    or public.tool_data_contains_credentials(to_jsonb(p_prompt)) then
    raise exception 'Prompt template name or text is invalid.' using errcode = '22023';
  end if;

  if p_template_id is null then
    if p_expected_version is not null then
      raise exception 'A new prompt template cannot specify an expected version.' using errcode = '22023';
    end if;
    v_template_id := gen_random_uuid();
    insert into public.workflow_prompt_templates (
      id, workspace_id, name, prompt, current_version, created_by, updated_by
    ) values (
      v_template_id, p_workspace_id, trim(p_name), trim(p_prompt), 1, v_user_id, v_user_id
    );
    insert into public.workflow_prompt_template_versions (
      workspace_id, template_id, version, name, prompt, change_kind, changed_by
    ) values (
      p_workspace_id, v_template_id, 1, trim(p_name), trim(p_prompt), 'created', v_user_id
    );
    return jsonb_build_object(
      'id', v_template_id,
      'workspaceId', p_workspace_id,
      'name', trim(p_name),
      'prompt', trim(p_prompt),
      'version', 1,
      'archived', false
    );
  end if;

  select t.* into v_template
  from public.workflow_prompt_templates t
  where t.id = p_template_id
    and t.workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'Prompt template access is required.' using errcode = '42501';
  end if;
  if v_template.archived_at is not null then
    raise exception 'Archived prompt templates cannot be edited.' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version <> v_template.current_version then
    raise exception 'Prompt template changed since it was loaded. Reload before saving.' using errcode = '40001';
  end if;

  v_next_version := v_template.current_version + 1;
  update public.workflow_prompt_templates
  set name = trim(p_name),
      prompt = trim(p_prompt),
      current_version = v_next_version,
      updated_by = v_user_id,
      updated_at = now()
  where id = p_template_id and workspace_id = p_workspace_id;

  insert into public.workflow_prompt_template_versions (
    workspace_id, template_id, version, name, prompt, change_kind, changed_by
  ) values (
    p_workspace_id, p_template_id, v_next_version, trim(p_name), trim(p_prompt), 'updated', v_user_id
  );

  return jsonb_build_object(
    'id', p_template_id,
    'workspaceId', p_workspace_id,
    'name', trim(p_name),
    'prompt', trim(p_prompt),
    'version', v_next_version,
    'archived', false
  );
end;
$$;

revoke all on function public.save_workflow_prompt_template(uuid, uuid, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.save_workflow_prompt_template(uuid, uuid, text, text, integer)
  to authenticated;

create or replace function public.archive_workflow_prompt_template(
  p_workspace_id uuid,
  p_template_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_template public.workflow_prompt_templates%rowtype;
  v_next_version integer;
begin
  if v_user_id is null or p_workspace_id is null
    or not public.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access is required.' using errcode = '42501';
  end if;
  if p_template_id is null or p_expected_version is null then
    raise exception 'A template ID and expected version are required.' using errcode = '22023';
  end if;

  select t.* into v_template
  from public.workflow_prompt_templates t
  where t.id = p_template_id
    and t.workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'Prompt template access is required.' using errcode = '42501';
  end if;
  if v_template.archived_at is not null then
    raise exception 'Prompt template is already archived.' using errcode = '22023';
  end if;
  if p_expected_version <> v_template.current_version then
    raise exception 'Prompt template changed since it was loaded. Reload before archiving.' using errcode = '40001';
  end if;

  v_next_version := v_template.current_version + 1;
  update public.workflow_prompt_templates
  set current_version = v_next_version,
      archived_at = now(),
      updated_by = v_user_id,
      updated_at = now()
  where id = p_template_id and workspace_id = p_workspace_id;

  insert into public.workflow_prompt_template_versions (
    workspace_id, template_id, version, name, prompt, change_kind, changed_by
  ) values (
    p_workspace_id, p_template_id, v_next_version, v_template.name, v_template.prompt, 'archived', v_user_id
  );

  return jsonb_build_object('id', p_template_id, 'version', v_next_version, 'archived', true);
end;
$$;

revoke all on function public.archive_workflow_prompt_template(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.archive_workflow_prompt_template(uuid, uuid, integer)
  to authenticated;

commit;
