begin;

-- Keep task attachments private and tightly bound to workspace/task-scoped paths.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'workflow-files',
  'workflow-files',
  false,
  10485760,
  array[
    'application/pdf',
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

drop policy if exists "workflow task attachments workspace read" on storage.objects;
create policy "workflow task attachments workspace read"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'workflow-files'
    and coalesce(array_length(storage.foldername(name), 1), 0) = 3
    and (storage.foldername(name))[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and exists (
      select 1
      from public.tasks t
      where t.id::text = (storage.foldername(name))[2]
        and t.workspace_id::text = (storage.foldername(name))[1]
        and public.is_workspace_member(t.workspace_id)
    )
  );

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
    and exists (
      select 1
      from public.tasks t
      where t.id::text = (storage.foldername(name))[2]
        and t.workspace_id::text = (storage.foldername(name))[1]
        and t.status = 'Planning'
        and public.is_workspace_member(t.workspace_id)
    )
  );

drop policy if exists "workflow task attachments uploader delete" on storage.objects;
create policy "workflow task attachments uploader delete"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'workflow-files'
    and owner_id = (select auth.uid()::text)
    and coalesce(array_length(storage.foldername(name), 1), 0) = 3
    and exists (
      select 1
      from public.tasks t
      where t.id::text = (storage.foldername(name))[2]
        and t.workspace_id::text = (storage.foldername(name))[1]
        and public.is_workspace_member(t.workspace_id)
    )
  );

-- Metadata is registered only after Storage has accepted and persisted the object.
-- The RPC validates object ownership, the task/workspace association, and Planning status.
drop policy if exists "members can register their own task files" on public.task_files;
revoke insert on public.task_files from anon, authenticated;
grant select, delete on public.task_files to authenticated;
create unique index if not exists task_files_storage_path_unique
  on public.task_files (storage_path);

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
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
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

commit;
