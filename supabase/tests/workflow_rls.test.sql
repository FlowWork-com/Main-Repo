begin;

select plan(26);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  (
    '10000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'member@example.test',
    '',
    now(),
    now(),
    now()
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'outsider@example.test',
    '',
    now(),
    now(),
    now()
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'reviewer@example.test',
    '',
    now(),
    now(),
    now()
  )
on conflict (id) do nothing;

insert into public.workspaces (id, name, created_by)
values (
  '20000000-0000-4000-8000-000000000001',
  'Member workspace',
  '10000000-0000-4000-8000-000000000001'
)
on conflict (id) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'owner'
)
on conflict (workspace_id, user_id) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000003',
  'member'
)
on conflict (workspace_id, user_id) do nothing;

insert into public.tasks (
  id, workspace_id, owner_id, title, details, status, attempt
) values (
  '30000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'Private task',
  '',
  'Planning',
  1
)
on conflict (id) do nothing;

insert into public.task_events (
  workspace_id, task_id, sequence, event_type, actor_id, occurred_at,
  idempotency_key, request_fingerprint, status_after, attempt, payload
) values (
  '20000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  1,
  'task.created',
  '10000000-0000-4000-8000-000000000001',
  now(),
  'created',
  'fingerprint',
  'Planning',
  1,
  '{}'::jsonb
)
on conflict (task_id, sequence) do nothing;

insert into public.task_steps (
  workspace_id, task_id, event_sequence, label, status, occurred_at
) values (
  '20000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  1,
  'Planning',
  'Planning',
  now()
)
on conflict (task_id, event_sequence) do nothing;

insert into public.task_approvals (
  workspace_id, task_id, request_id, requested_by, requested_at
) values (
  '20000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  'approval-1',
  '10000000-0000-4000-8000-000000000001',
  now()
)
on conflict (task_id, request_id) do nothing;

insert into public.task_files (
  workspace_id, task_id, file_name, storage_path, uploaded_by
) values (
  '20000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  'evidence.txt',
  'private/evidence.txt',
  '10000000-0000-4000-8000-000000000001'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select is((select count(*) from public.workspaces), 1::bigint, 'members can read their workspace');
select is((select count(*) from public.workspace_members), 2::bigint, 'members can read their workspace membership');
select is((select count(*) from public.tasks), 1::bigint, 'members can read their tasks');
select is((select count(*) from public.task_events), 1::bigint, 'members can read persisted task events');
select is((select count(*) from public.task_steps), 1::bigint, 'members can read task steps');
select is((select count(*) from public.task_approvals), 1::bigint, 'members can read approval records');
select is((select count(*) from public.task_files), 1::bigint, 'members can read task file metadata');

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);

select is((select count(*) from public.workspaces), 0::bigint, 'non-members cannot read workspaces');
select is((select count(*) from public.workspace_members), 0::bigint, 'non-members cannot read membership records');
select is((select count(*) from public.tasks), 0::bigint, 'non-members cannot read tasks');
select is((select count(*) from public.task_events), 0::bigint, 'non-members cannot read events');
select is((select count(*) from public.task_steps), 0::bigint, 'non-members cannot read task steps');
select is((select count(*) from public.task_approvals), 0::bigint, 'non-members cannot read approvals');
select is((select count(*) from public.task_files), 0::bigint, 'non-members cannot read file metadata');

select throws_ok(
  $$ update public.tasks set owner_id = '10000000-0000-4000-8000-000000000002' where id = '30000000-0000-4000-8000-000000000001' $$,
  '42501',
  'permission denied for table tasks',
  'authenticated users cannot directly modify task ownership or state'
);
select throws_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role) values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'owner') $$,
  '42501',
  'permission denied for table workspace_members',
  'authenticated users cannot self-assign workspace membership'
);

select throws_ok(
  $$ select public.persist_workflow_events(
       '30000000-0000-4000-8000-000000000001',
       1,
       'Running',
       1,
       '[]'::jsonb
     ) $$,
  '42501',
  'Task access is required.',
  'non-members cannot write task events through the persistence RPC'
);

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);

select throws_ok(
  $$ select public.persist_workflow_events(
       '30000000-0000-4000-8000-000000000001',
       1,
       'Completed',
       1,
       jsonb_build_array(jsonb_build_object(
         'sequence', 2,
         'eventType', 'status.changed',
         'actorId', '10000000-0000-4000-8000-000000000001',
         'occurredAt', '2026-10-08T10:00:00Z',
         'idempotencyKey', 'invalid-shortcut',
         'requestFingerprint', 'invalid-shortcut-fingerprint',
         'statusAfter', 'Completed',
         'attempt', 1,
         'payload', jsonb_build_object('from', 'Planning', 'to', 'Completed')
       ))
     ) $$,
  '22023',
  'Workflow transition is not allowed.',
  'persistence rejects transitions that bypass the workflow domain graph'
);
select is(
  (select status from public.tasks where id = '30000000-0000-4000-8000-000000000001'),
  'Planning',
  'a rejected event batch leaves task state unchanged'
);

select public.create_workflow_task(
  '30000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001',
  'Workflow RPC test',
  '',
  jsonb_build_object(
    'sequence', 1,
    'eventType', 'task.created',
    'actorId', '10000000-0000-4000-8000-000000000001',
    'occurredAt', '2026-10-08T10:00:00Z',
    'idempotencyKey', 'rpc-create',
    'requestFingerprint', 'rpc-create-fingerprint',
    'statusAfter', 'Planning',
    'attempt', 1,
    'payload', '{}'::jsonb
  )
);

select public.persist_workflow_events(
  '30000000-0000-4000-8000-000000000002',
  1,
  'Running',
  1,
  jsonb_build_array(jsonb_build_object(
    'sequence', 2,
    'eventType', 'status.changed',
    'actorId', '10000000-0000-4000-8000-000000000001',
    'occurredAt', '2026-10-08T10:01:00Z',
    'idempotencyKey', 'rpc-start',
    'requestFingerprint', 'rpc-start-fingerprint',
    'statusAfter', 'Running',
    'attempt', 1,
    'payload', jsonb_build_object('from', 'Planning', 'to', 'Running')
  ))
);
select public.persist_workflow_events(
  '30000000-0000-4000-8000-000000000002',
  2,
  'Waiting for approval',
  1,
  jsonb_build_array(
    jsonb_build_object(
      'sequence', 3,
      'eventType', 'status.changed',
      'actorId', '10000000-0000-4000-8000-000000000001',
      'occurredAt', '2026-10-08T10:02:00Z',
      'idempotencyKey', 'rpc-request-approval',
      'requestFingerprint', 'rpc-request-approval-fingerprint',
      'statusAfter', 'Waiting for approval',
      'attempt', 1,
      'payload', jsonb_build_object('from', 'Running', 'to', 'Waiting for approval')
    ),
    jsonb_build_object(
      'sequence', 4,
      'eventType', 'approval.requested',
      'actorId', '10000000-0000-4000-8000-000000000001',
      'occurredAt', '2026-10-08T10:02:00Z',
      'idempotencyKey', 'rpc-request-approval',
      'requestFingerprint', 'rpc-request-approval-fingerprint',
      'statusAfter', 'Waiting for approval',
      'attempt', 1,
      'payload', jsonb_build_object('requestId', 'rpc-approval')
    )
  )
);
select is(
  (select requested_by from public.task_approvals
   where task_id = '30000000-0000-4000-8000-000000000002'
     and request_id = 'rpc-approval'),
  '10000000-0000-4000-8000-000000000001'::uuid,
  'approval requests record the authenticated requester'
);
select throws_ok(
  $$ select public.persist_workflow_events(
       '30000000-0000-4000-8000-000000000002',
       4,
       'Running',
       1,
       jsonb_build_array(
         jsonb_build_object(
           'sequence', 5,
           'eventType', 'approval.recorded',
           'actorId', '10000000-0000-4000-8000-000000000001',
           'occurredAt', '2026-10-08T10:03:00Z',
           'idempotencyKey', 'rpc-self-approve',
           'requestFingerprint', 'rpc-self-approve-fingerprint',
           'statusAfter', 'Waiting for approval',
           'attempt', 1,
           'payload', jsonb_build_object('result', jsonb_build_object(
             'requestId', 'rpc-approval',
             'decision', 'approved',
             'approverId', '10000000-0000-4000-8000-000000000001',
             'decidedAt', '2026-10-08T10:03:00Z'
           ))
         ),
         jsonb_build_object(
           'sequence', 6,
           'eventType', 'status.changed',
           'actorId', '10000000-0000-4000-8000-000000000001',
           'occurredAt', '2026-10-08T10:03:00Z',
           'idempotencyKey', 'rpc-self-approve',
           'requestFingerprint', 'rpc-self-approve-fingerprint',
           'statusAfter', 'Running',
           'attempt', 1,
           'payload', jsonb_build_object('from', 'Waiting for approval', 'to', 'Running')
         )
       )
     ) $$,
  '23514',
  'new row for relation "task_approvals" violates check constraint "task_approvals_no_self_approval"',
  'the persistence RPC rejects approval by the requester'
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);
select public.persist_workflow_events(
  '30000000-0000-4000-8000-000000000002',
  4,
  'Running',
  1,
  jsonb_build_array(
    jsonb_build_object(
      'sequence', 5,
      'eventType', 'approval.recorded',
      'actorId', '10000000-0000-4000-8000-000000000003',
      'occurredAt', '2026-10-08T10:03:00Z',
      'idempotencyKey', 'rpc-approve',
      'requestFingerprint', 'rpc-approve-fingerprint',
      'statusAfter', 'Waiting for approval',
      'attempt', 1,
      'payload', jsonb_build_object('result', jsonb_build_object(
        'requestId', 'rpc-approval',
        'decision', 'approved',
        'approverId', '10000000-0000-4000-8000-000000000003',
        'decidedAt', '2026-10-08T10:03:00Z'
      ))
    ),
    jsonb_build_object(
      'sequence', 6,
      'eventType', 'status.changed',
      'actorId', '10000000-0000-4000-8000-000000000003',
      'occurredAt', '2026-10-08T10:03:00Z',
      'idempotencyKey', 'rpc-approve',
      'requestFingerprint', 'rpc-approve-fingerprint',
      'statusAfter', 'Running',
      'attempt', 1,
      'payload', jsonb_build_object('from', 'Waiting for approval', 'to', 'Running')
    )
  )
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select public.persist_workflow_events(
  '30000000-0000-4000-8000-000000000002',
  6,
  'Verifying',
  1,
  jsonb_build_array(jsonb_build_object(
    'sequence', 7,
    'eventType', 'status.changed',
    'actorId', '10000000-0000-4000-8000-000000000001',
    'occurredAt', '2026-10-08T10:04:00Z',
    'idempotencyKey', 'rpc-verify',
    'requestFingerprint', 'rpc-verify-fingerprint',
    'statusAfter', 'Verifying',
    'attempt', 1,
    'payload', jsonb_build_object('from', 'Running', 'to', 'Verifying')
  ))
);
select public.persist_workflow_events(
  '30000000-0000-4000-8000-000000000002',
  7,
  'Completed',
  1,
  jsonb_build_array(
    jsonb_build_object(
      'sequence', 8,
      'eventType', 'verification.recorded',
      'actorId', '10000000-0000-4000-8000-000000000001',
      'occurredAt', '2026-10-08T10:05:00Z',
      'idempotencyKey', 'rpc-record-verification',
      'requestFingerprint', 'rpc-record-verification-fingerprint',
      'statusAfter', 'Verifying',
      'attempt', 1,
      'payload', jsonb_build_object('result', jsonb_build_object(
        'passed', true,
        'evidenceReference', 'receipt://rpc-test/evidence',
        'verifiedBy', '10000000-0000-4000-8000-000000000001',
        'verifiedAt', '2026-10-08T10:05:00Z'
      ))
    ),
    jsonb_build_object(
      'sequence', 9,
      'eventType', 'status.changed',
      'actorId', '10000000-0000-4000-8000-000000000001',
      'occurredAt', '2026-10-08T10:05:00Z',
      'idempotencyKey', 'rpc-record-verification',
      'requestFingerprint', 'rpc-record-verification-fingerprint',
      'statusAfter', 'Completed',
      'attempt', 1,
      'payload', jsonb_build_object('from', 'Verifying', 'to', 'Completed')
    )
  )
);

select is(
  (select status from public.tasks where id = '30000000-0000-4000-8000-000000000002'),
  'Completed',
  'atomic persistence RPC stores the final task state'
);
select is(
  (select count(*) from public.task_events where task_id = '30000000-0000-4000-8000-000000000002'),
  9::bigint,
  'atomic persistence RPC appends ordered lifecycle events'
);
select is(
  (select decision from public.task_approvals where task_id = '30000000-0000-4000-8000-000000000002'),
  'approved',
  'approval decisions are persisted with the workflow event'
);
select is(
  (select approver_id from public.task_approvals where task_id = '30000000-0000-4000-8000-000000000002'),
  '10000000-0000-4000-8000-000000000003'::uuid,
  'another authorized workspace member can approve the request'
);
select is(
  (select payload->'result'->>'evidenceReference' from public.task_events where task_id = '30000000-0000-4000-8000-000000000002' and event_type = 'verification.recorded'),
  'receipt://rpc-test/evidence',
  'verification evidence is persisted in the event history'
);

select * from finish();
rollback;
