begin;

select plan(16);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  (
    '81000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'attachment-owner@example.test', '',
    now(), now(), now()
  ),
  (
    '81000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'attachment-member@example.test', '',
    now(), now(), now()
  ),
  (
    '81000000-0000-4000-8000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'attachment-outsider@example.test', '',
    now(), now(), now()
  )
on conflict (id) do nothing;

insert into public.workspaces (id, name, created_by)
values (
  '82000000-0000-4000-8000-000000000001',
  'Attachment workspace',
  '81000000-0000-4000-8000-000000000001'
)
on conflict (id) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
values
  (
    '82000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    '82000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000002',
    'member'
  )
on conflict (workspace_id, user_id) do nothing;

insert into public.tasks (id, workspace_id, owner_id, title, details, status, attempt)
values
  (
    '83000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    'Planning attachment task', '',
    'Planning', 1
  ),
  (
    '83000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    'Running attachment task', '',
    'Running', 1
  )
on conflict (id) do nothing;

-- Test fixtures model objects already accepted by Storage; production uploads are made through the Storage API.
insert into storage.objects (bucket_id, name, owner_id, metadata)
values
  (
    'workflow-files',
    '82000000-0000-4000-8000-000000000001/83000000-0000-4000-8000-000000000001/84000000-0000-4000-8000-000000000001/evidence.txt',
    '81000000-0000-4000-8000-000000000001',
    '{"mimetype":"text/plain","size":12}'::jsonb
  ),
  (
    'workflow-files',
    '82000000-0000-4000-8000-000000000001/83000000-0000-4000-8000-000000000002/84000000-0000-4000-8000-000000000002/running.txt',
    '81000000-0000-4000-8000-000000000001',
    '{"mimetype":"text/plain","size":12}'::jsonb
  ),
  (
    'workflow-files',
    '82000000-0000-4000-8000-000000000001/83000000-0000-4000-8000-000000000001/84000000-0000-4000-8000-000000000003/payload.exe',
    '81000000-0000-4000-8000-000000000001',
    '{"mimetype":"text/plain","size":4}'::jsonb
  )
on conflict (bucket_id, name) do nothing;

select is(
  (select public from storage.buckets where id = 'workflow-files'),
  false,
  'task attachment bucket is private'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select lives_ok(
  $$ select public.register_task_file(
       '82000000-0000-4000-8000-000000000001',
       '83000000-0000-4000-8000-000000000001',
       'evidence.txt',
       '82000000-0000-4000-8000-000000000001/83000000-0000-4000-8000-000000000001/84000000-0000-4000-8000-000000000001/evidence.txt',
       'text/plain'
     ) $$,
  'a workspace member can register their uploaded file on a Planning task'
);

select is(
  (select count(*) from public.task_files
   where task_id = '83000000-0000-4000-8000-000000000001'),
  1::bigint,
  'valid uploaded file metadata is persisted'
);

select is(
  (select count(*) from storage.objects
   where bucket_id = 'workflow-files'
     and name = '82000000-0000-4000-8000-000000000001/83000000-0000-4000-8000-000000000001/84000000-0000-4000-8000-000000000001/evidence.txt'),
  1::bigint,
  'the uploader can read the registered private object'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000002', true);

select is(
  (select count(*) from public.task_files
   where task_id = '83000000-0000-4000-8000-000000000001'),
  1::bigint,
  'workspace members can read task attachment metadata'
);

select lives_ok(
  $$ delete from public.task_files where task_id = '83000000-0000-4000-8000-000000000001' $$,
  'a different workspace member cannot cause a metadata deletion error'
);

select is(
  (select count(*) from public.task_files
   where task_id = '83000000-0000-4000-8000-000000000001'),
  1::bigint,
  'only the uploader can delete attachment metadata'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000003', true);

select is(
  (select count(*) from public.task_files),
  0::bigint,
  'non-members cannot read attachment metadata'
);

select is(
  (select count(*) from storage.objects where bucket_id = 'workflow-files'),
  0::bigint,
  'non-members cannot read private task attachments'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000001', true);

select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner_id, metadata)
     values (
       'workflow-files',
       '82000000-0000-4000-8000-000000000001/83000000-0000-4000-8000-000000000001/84000000-0000-4000-8000-000000000004/new.txt',
       '81000000-0000-4000-8000-000000000001',
       '{"mimetype":"text/plain","size":4}'::jsonb
     ) $$,
  'authenticated workspace members can upload supported files to Planning tasks'
);

select is(
  (select count(*) from storage.objects
   where bucket_id = 'workflow-files'
     and name = '82000000-0000-4000-8000-000000000001/83000000-0000-4000-8000-000000000001/84000000-0000-4000-8000-000000000004/new.txt'),
  1::bigint,
  'the valid upload path and file type are accepted by Storage RLS'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner_id, metadata)
     values (
       'workflow-files',
       '82000000-0000-4000-8000-000000000001/83000000-0000-4000-8000-000000000001/84000000-0000-4000-8000-000000000005/payload.exe',
       '81000000-0000-4000-8000-000000000001',
       '{"mimetype":"text/plain","size":4}'::jsonb
     ) $$,
  '42501',
  'new row violates row-level security policy for table "objects"',
  'Storage RLS rejects unsupported extensions even when MIME is spoofed'
);

select throws_ok(
  $$ select public.register_task_file(
       '82000000-0000-4000-8000-000000000001',
       '83000000-0000-4000-8000-000000000002',
       'running.txt',
       '82000000-0000-4000-8000-000000000001/83000000-0000-4000-8000-000000000002/84000000-0000-4000-8000-000000000002/running.txt',
       'text/plain'
     ) $$,
  '22023',
  'Only Planning tasks accept attachments.',
  'attachments cannot be registered after a task leaves Planning'
);

select throws_ok(
  $$ insert into public.task_files (
       workspace_id, task_id, file_name, storage_path, uploaded_by
     ) values (
       '82000000-0000-4000-8000-000000000001',
       '83000000-0000-4000-8000-000000000001',
       'forged.txt',
       '82000000-0000-4000-8000-000000000001/83000000-0000-4000-8000-000000000001/84000000-0000-4000-8000-000000000001/forged.txt',
       '81000000-0000-4000-8000-000000000001'
     ) $$,
  '42501',
  'permission denied for table task_files',
  'authenticated clients cannot directly forge attachment metadata'
);

select throws_ok(
  $$ select public.register_task_file(
       '82000000-0000-4000-8000-000000000001',
       '83000000-0000-4000-8000-000000000001',
       'renamed.txt',
       '82000000-0000-4000-8000-000000000001/83000000-0000-4000-8000-000000000001/84000000-0000-4000-8000-000000000001/evidence.txt',
       'text/plain'
     ) $$,
  '22023',
  'Invalid task file path.',
  'registered file name must match the object path'
);

select throws_ok(
  $$ select public.register_task_file(
       '82000000-0000-4000-8000-000000000001',
       '83000000-0000-4000-8000-000000000001',
       'payload.exe',
       '82000000-0000-4000-8000-000000000001/83000000-0000-4000-8000-000000000001/84000000-0000-4000-8000-000000000003/payload.exe',
       'text/plain'
     ) $$,
  '22023',
  'Invalid task file metadata.',
  'unsupported file extensions cannot be registered even with an allowed MIME type'
);

select * from finish();
rollback;
