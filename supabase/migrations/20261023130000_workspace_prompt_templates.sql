begin;

create table public.workspace_prompt_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 120),
  category text check (category is null or char_length(trim(category)) <= 80),
  current_version integer not null default 1 check (current_version > 0),
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (workspace_id, id)
);

create unique index workspace_prompt_templates_active_name_idx
  on public.workspace_prompt_templates (workspace_id, lower(trim(name)))
  where archived_at is null;

create index workspace_prompt_templates_workspace_updated_idx
  on public.workspace_prompt_templates (workspace_id, updated_at desc)
  where archived_at is null;

create table public.workspace_prompt_template_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  template_id uuid not null,
  version integer not null check (version > 0),
  prompt_text text not null check (char_length(trim(prompt_text)) between 3 and 4000),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (workspace_id, template_id, version),
  foreign key (workspace_id, template_id)
    references public.workspace_prompt_templates (workspace_id, id) on delete cascade
);

create index workspace_prompt_template_versions_history_idx
  on public.workspace_prompt_template_versions (workspace_id, template_id, version desc);

alter table public.workspace_prompt_templates enable row level security;
alter table public.workspace_prompt_template_versions enable row level security;

create policy "workspace members can read prompt templates"
  on public.workspace_prompt_templates
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "workspace members can read prompt template versions"
  on public.workspace_prompt_template_versions
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

revoke all on public.workspace_prompt_templates from public, anon, authenticated, service_role;
revoke all on public.workspace_prompt_template_versions from public, anon, authenticated, service_role;
grant select on public.workspace_prompt_templates to authenticated;
grant select on public.workspace_prompt_template_versions to authenticated;

create or replace function public.save_workspace_prompt_template(
  p_workspace_id uuid,
  p_template_id uuid,
  p_expected_version integer,
  p_name text,
  p_category text,
  p_prompt_text text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_template public.workspace_prompt_templates%rowtype;
  v_template_id uuid;
  v_version integer;
  v_name text;
  v_category text;
  v_prompt text;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_workspace_id is null or not public.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access is required.' using errcode = '42501';
  end if;

  v_name := trim(coalesce(p_name, ''));
  v_category := nullif(trim(coalesce(p_category, '')), '');
  v_prompt := trim(coalesce(p_prompt_text, ''));

  if char_length(v_name) not between 1 and 120
    or (v_category is not null and char_length(v_category) > 80)
    or char_length(v_prompt) not between 3 and 4000
    or public.tool_data_contains_credentials(to_jsonb(v_prompt)) then
    raise exception 'Prompt template fields are invalid or contain credential-like data.' using errcode = '22023';
  end if;

  if p_template_id is null then
    if p_expected_version is not null then
      raise exception 'A new prompt template cannot specify an expected version.' using errcode = '22023';
    end if;
    v_template_id := gen_random_uuid();
    v_version := 1;
    insert into public.workspace_prompt_templates (
      id, workspace_id, name, category, current_version, created_by, updated_by
    ) values (
      v_template_id, p_workspace_id, v_name, v_category, v_version, v_user_id, v_user_id
    );
  else
    if p_expected_version is null or p_expected_version < 1 then
      raise exception 'An expected prompt template version is required.' using errcode = '22023';
    end if;
    select t.* into v_template
    from public.workspace_prompt_templates t
    where t.workspace_id = p_workspace_id and t.id = p_template_id
    for update;
    if not found then
      raise exception 'Prompt template access is required.' using errcode = '42501';
    end if;
    if v_template.archived_at is not null then
      raise exception 'An archived prompt template cannot be edited.' using errcode = '22023';
    end if;
    if v_template.current_version is distinct from p_expected_version then
      raise exception 'Prompt template changed. Reload the latest version before saving.' using errcode = '40001';
    end if;
    v_template_id := v_template.id;
    v_version := v_template.current_version + 1;
    update public.workspace_prompt_templates
    set name = v_name,
        category = v_category,
        current_version = v_version,
        updated_by = v_user_id,
        updated_at = now()
    where workspace_id = p_workspace_id and id = v_template_id;
  end if;

  insert into public.workspace_prompt_template_versions (
    workspace_id, template_id, version, prompt_text, created_by
  ) values (
    p_workspace_id, v_template_id, v_version, v_prompt, v_user_id
  );

  return jsonb_build_object(
    'id', v_template_id,
    'workspaceId', p_workspace_id,
    'name', v_name,
    'category', v_category,
    'version', v_version,
    'promptText', v_prompt,
    'archived', false
  );
end;
$$;

create or replace function public.archive_workspace_prompt_template(
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
  v_template public.workspace_prompt_templates%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_workspace_id is null or not public.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace access is required.' using errcode = '42501';
  end if;
  if p_template_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'A prompt template and expected version are required.' using errcode = '22023';
  end if;

  select t.* into v_template
  from public.workspace_prompt_templates t
  where t.workspace_id = p_workspace_id and t.id = p_template_id
  for update;
  if not found then
    raise exception 'Prompt template access is required.' using errcode = '42501';
  end if;
  if v_template.archived_at is not null then
    return jsonb_build_object(
      'id', v_template.id,
      'version', v_template.current_version,
      'archived', true,
      'alreadyArchived', true
    );
  end if;
  if v_template.current_version is distinct from p_expected_version then
    raise exception 'Prompt template changed. Reload the latest version before archiving.' using errcode = '40001';
  end if;

  update public.workspace_prompt_templates
  set archived_at = now(),
      updated_by = v_user_id,
      updated_at = now()
  where workspace_id = p_workspace_id and id = p_template_id
  returning * into v_template;

  return jsonb_build_object(
    'id', v_template.id,
    'version', v_template.current_version,
    'archived', true,
    'alreadyArchived', false
  );
end;
$$;

revoke all on function public.save_workspace_prompt_template(uuid, uuid, integer, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.archive_workspace_prompt_template(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.save_workspace_prompt_template(uuid, uuid, integer, text, text, text)
  to authenticated;
grant execute on function public.archive_workspace_prompt_template(uuid, uuid, integer)
  to authenticated;

comment on table public.workspace_prompt_templates is
  'Workspace-scoped prompt templates. Edits create immutable versions; archive is a soft delete.';
comment on table public.workspace_prompt_template_versions is
  'Immutable prompt template versions, readable only by workspace members.';

commit;
