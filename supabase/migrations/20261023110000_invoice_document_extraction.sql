-- Enable secure upload and signed-plan validation for PDF/image invoice extraction.
begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'workflow-files',
  'workflow-files',
  false,
  10485760,
  array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'text/plain',
    'text/csv',
    'text/tab-separated-values',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "workflow task attachments planning upload" on storage.objects;
create policy "workflow task attachments planning upload"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'workflow-files'
    and coalesce(array_length(storage.foldername(name), 1), 0) = 3
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (storage.foldername(name))[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (
      (storage.filename(name) ~* '[.]pdf$' and lower(coalesce(metadata->>'mimetype', '')) = 'application/pdf')
      or (storage.filename(name) ~* '[.](jpg|jpeg)$' and lower(coalesce(metadata->>'mimetype', '')) = 'image/jpeg')
      or (storage.filename(name) ~* '[.]png$' and lower(coalesce(metadata->>'mimetype', '')) = 'image/png')
      or (storage.filename(name) ~* '[.]txt$' and lower(coalesce(metadata->>'mimetype', '')) = 'text/plain')
      or (storage.filename(name) ~* '[.]csv$' and lower(coalesce(metadata->>'mimetype', '')) = 'text/csv')
      or (storage.filename(name) ~* '[.]tsv$' and lower(coalesce(metadata->>'mimetype', '')) = 'text/tab-separated-values')
      or (storage.filename(name) ~* '[.]xls$' and lower(coalesce(metadata->>'mimetype', '')) = 'application/vnd.ms-excel')
      or (storage.filename(name) ~* '[.]xlsx$' and lower(coalesce(metadata->>'mimetype', '')) = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    )
    and exists (
      select 1
      from public.tasks t
      where t.id::text = (storage.foldername(name))[2]
        and t.workspace_id::text = (storage.foldername(name))[1]
        and t.status = 'Planning'
        and public.is_workspace_member(t.workspace_id)
    )
  );

create or replace function public.register_task_file(
  p_workspace_id uuid,
  p_task_id uuid,
  p_file_name text,
  p_storage_path text,
  p_content_type text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, storage, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_task public.tasks%rowtype;
  v_object storage.objects%rowtype;
  v_folders text[];
  v_file_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select t.* into v_task
  from public.tasks t
  where t.id = p_task_id
  for share;

  if not found
    or v_task.workspace_id is distinct from p_workspace_id
    or not public.is_workspace_member(p_workspace_id) then
    raise exception 'Task access is required.' using errcode = '42501';
  end if;

  if v_task.status is distinct from 'Planning' then
    raise exception 'Only Planning tasks accept attachments.' using errcode = '22023';
  end if;

  if p_file_name is null
    or char_length(trim(p_file_name)) not between 1 and 255
    or p_file_name ~ '[[:cntrl:]/]'
    or position(chr(92) in p_file_name) > 0
    or p_storage_path is null
    or p_content_type is null
    or lower(p_content_type) not in (
      'application/pdf',
      'text/plain',
      'text/csv',
      'text/tab-separated-values',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/jpeg',
      'image/png'
    ) then
    raise exception 'Invalid task file metadata.' using errcode = '22023';
  end if;

  if not (
    (p_file_name ~* '[.]pdf$' and lower(p_content_type) = 'application/pdf')
    or (p_file_name ~* '[.]txt$' and lower(p_content_type) = 'text/plain')
    or (p_file_name ~* '[.]csv$' and lower(p_content_type) = 'text/csv')
    or (p_file_name ~* '[.]tsv$' and lower(p_content_type) = 'text/tab-separated-values')
    or (p_file_name ~* '[.]xls$' and lower(p_content_type) = 'application/vnd.ms-excel')
    or (p_file_name ~* '[.]xlsx$' and lower(p_content_type) = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    or (p_file_name ~* '[.](jpg|jpeg)$' and lower(p_content_type) = 'image/jpeg')
    or (p_file_name ~* '[.]png$' and lower(p_content_type) = 'image/png')
  ) then
    raise exception 'Invalid task file metadata.' using errcode = '22023';
  end if;

  v_folders := storage.foldername(p_storage_path);
  if coalesce(array_length(v_folders, 1), 0) <> 3
    or v_folders[1] is distinct from p_workspace_id::text
    or v_folders[2] is distinct from p_task_id::text
    or v_folders[3] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or storage.filename(p_storage_path) is distinct from p_file_name then
    raise exception 'Invalid task file path.' using errcode = '22023';
  end if;

  select o.* into v_object
  from storage.objects o
  where o.bucket_id = 'workflow-files'
    and o.name = p_storage_path
    and o.owner_id = v_user_id::text;

  if not found then
    raise exception 'Uploaded task file not found or not owned by the uploader.' using errcode = '42501';
  end if;

  if lower(coalesce(v_object.metadata->>'mimetype', '')) is distinct from lower(p_content_type)
    or coalesce(v_object.metadata->>'size', '') !~ '^[0-9]+$'
    or (v_object.metadata->>'size')::bigint > 10485760 then
    raise exception 'Uploaded task file metadata is invalid.' using errcode = '22023';
  end if;

  insert into public.task_files (
    workspace_id, task_id, file_name, storage_path, content_type, uploaded_by
  ) values (
    p_workspace_id, p_task_id, p_file_name, p_storage_path, lower(p_content_type), v_user_id
  )
  returning id into v_file_id;

  return v_file_id;
end;
$$;

revoke all on function public.register_task_file(uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.register_task_file(uuid, uuid, text, text, text)
  to authenticated;

comment on function public.register_task_file(uuid, uuid, text, text, text)
  is 'Registers an uploaded private task attachment after validating workspace membership, Planning status, storage ownership, path, MIME type, and size.';

create or replace function public.create_workflow_plan(
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
    or encode(
      extensions.hmac(p_plan_json::text, v_signing_key::text, 'sha256'::text),
      'hex'
    ) <> p_signature then
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
      or v_step->>'toolId' not in ('echo', 'file-metadata', 'invoice-csv-review', 'invoice-document-extract', 'json-inspect', 'text-transform') then
      raise exception 'Plan contains an unsupported tool.' using errcode = '22023';
    end if;

    v_input := v_step->'input';
    if v_step->>'toolId' in ('text-transform', 'json-inspect', 'file-metadata', 'invoice-csv-review', 'invoice-document-extract')
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
      or (select count(*) from jsonb_object_keys(
        case when jsonb_typeof(v_input) = 'object' then v_input else '{}'::jsonb end
      )) <> 1
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
      or (select count(*) from jsonb_object_keys(
        case when jsonb_typeof(v_input) = 'object' then v_input else '{}'::jsonb end
      )) <> 1
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

    if v_step->>'toolId' = 'invoice-csv-review' and (
      jsonb_typeof(v_input) is distinct from 'object'
      or (select count(*) from jsonb_object_keys(
        case when jsonb_typeof(v_input) = 'object' then v_input else '{}'::jsonb end
      )) <> 1
      or coalesce(v_input->>'fileId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or not exists (
        select 1
        from public.task_files f
        where f.id = (v_input->>'fileId')::uuid
          and f.task_id = p_task_id
          and f.workspace_id = v_workspace_id
          and (
            (f.file_name ~* '[.]csv$' and lower(coalesce(f.content_type, '')) = 'text/csv')
            or (f.file_name ~* '[.]tsv$' and lower(coalesce(f.content_type, '')) = 'text/tab-separated-values')
            or (f.file_name ~* '[.]xls$' and lower(coalesce(f.content_type, '')) = 'application/vnd.ms-excel')
            or (f.file_name ~* '[.]xlsx$' and lower(coalesce(f.content_type, '')) = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          )
      )
    ) then
      raise exception 'Plan contains invalid invoice-csv-review input.' using errcode = '22023';
    end if;

    if v_step->>'toolId' = 'invoice-document-extract' and (
      jsonb_typeof(v_input) is distinct from 'object'
      or (select count(*) from jsonb_object_keys(
        case when jsonb_typeof(v_input) = 'object' then v_input else '{}'::jsonb end
      )) <> 1
      or coalesce(v_input->>'fileId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or not exists (
        select 1
        from public.task_files f
        where f.id = (v_input->>'fileId')::uuid
          and f.task_id = p_task_id
          and f.workspace_id = v_workspace_id
          and (
            (f.file_name ~* '[.]pdf$' and lower(coalesce(f.content_type, '')) = 'application/pdf')
            or (f.file_name ~* '[.](jpg|jpeg)$' and lower(coalesce(f.content_type, '')) = 'image/jpeg')
            or (f.file_name ~* '[.]png$' and lower(coalesce(f.content_type, '')) = 'image/png')
          )
      )
    ) then
      raise exception 'Plan contains invalid invoice-document-extract input.' using errcode = '22023';
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


commit;
