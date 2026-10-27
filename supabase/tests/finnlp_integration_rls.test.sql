begin;

select plan(28);

select ok(
  not has_table_privilege('authenticated', 'public.workspace_finnlp_connections', 'select'),
  'authenticated users cannot read the FinNLP connection metadata table directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.workspace_finnlp_connections', 'insert'),
  'authenticated users cannot insert FinNLP connections directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.workspace_finnlp_connections', 'update'),
  'authenticated users cannot replace FinNLP connection secrets directly'
);
select ok(
  not has_function_privilege('authenticated', 'public.connect_finnlp_connection(uuid,uuid,text)', 'execute'),
  'authenticated users cannot call the privileged credential write RPC'
);
select ok(
  not has_function_privilege('authenticated', 'public.read_finnlp_api_key(uuid,uuid)', 'execute'),
  'authenticated users cannot read provider credentials from Vault'
);
select ok(
  not has_function_privilege('authenticated', 'public.disconnect_finnlp_connection(uuid,uuid)', 'execute'),
  'authenticated users cannot call the privileged credential removal RPC'
);
select ok(
  has_function_privilege('service_role', 'public.connect_finnlp_connection(uuid,uuid,text)', 'execute'),
  'the server service role can store a validated FinNLP credential'
);
select ok(
  has_function_privilege('service_role', 'public.read_finnlp_api_key(uuid,uuid)', 'execute'),
  'the server service role can read the Vault credential for a verified member'
);
select ok(
  has_function_privilege('service_role', 'public.disconnect_finnlp_connection(uuid,uuid)', 'execute'),
  'the server service role can remove the connection and its Vault credential'
);
select has_trigger(
  'public',
  'workspace_finnlp_connections',
  'workspace_finnlp_connections_delete_secret',
  'connection row deletion invokes Vault secret cleanup'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values (
  'a1000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'finnlp-owner@example.test', '',
  now(), now(), now()
)
on conflict (id) do nothing;

insert into public.workspaces (id, name, created_by)
values (
  'a2000000-0000-4000-8000-000000000001',
  'FinNLP test workspace',
  'a1000000-0000-4000-8000-000000000001'
)
on conflict (id) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'a2000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'owner'
)
on conflict (workspace_id, user_id) do nothing;

create temporary table finnlp_test_secret_ids(id uuid);
insert into finnlp_test_secret_ids
select vault.create_secret(
  'finnlp-trigger-cleanup-test-key-123456',
  'finnlp-trigger-cleanup-test',
  'Temporary secret to verify cascade cleanup.'
);

insert into public.workspace_finnlp_connections (
  workspace_id, user_id, api_key_secret_id
)
select
  'a2000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  id
from finnlp_test_secret_ids;

select lives_ok(
  $$ delete from public.workspace_finnlp_connections
     where workspace_id = 'a2000000-0000-4000-8000-000000000001'
       and user_id = 'a1000000-0000-4000-8000-000000000001' $$,
  'removing a connection row succeeds and runs secret cleanup'
);
select ok(
  not exists (
    select 1 from vault.secrets s
    join finnlp_test_secret_ids x on x.id = s.id
  ),
  'deleting a connection row also deletes its stored Vault secret'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;

select is(
  public.connect_finnlp_connection(
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'finnlp-initial-test-key-123456789'
  )->>'connected',
  'true',
  'the service role can store a validated provider key in Vault'
);

select is(
  public.read_finnlp_api_key(
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001'
  ),
  'finnlp-initial-test-key-123456789',
  'the trusted reader returns the saved key only for its workspace member'
);

select is(
  public.read_finnlp_api_key(
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000099'
  ),
  null::text,
  'the trusted reader returns no key for a nonmember'
);

create temporary table finnlp_secret_rotation_ids(old_id uuid, new_id uuid);
insert into finnlp_secret_rotation_ids(old_id)
select api_key_secret_id
from public.workspace_finnlp_connections
where workspace_id = 'a2000000-0000-4000-8000-000000000001'
  and user_id = 'a1000000-0000-4000-8000-000000000001';

select is(
  public.connect_finnlp_connection(
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'finnlp-replacement-test-key-123456789'
  )->>'connected',
  'true',
  'replacing a provider key succeeds atomically'
);

update finnlp_secret_rotation_ids
set new_id = c.api_key_secret_id
from public.workspace_finnlp_connections c
where c.workspace_id = 'a2000000-0000-4000-8000-000000000001'
  and c.user_id = 'a1000000-0000-4000-8000-000000000001';

select ok(
  not exists (
    select 1 from vault.secrets s
    join finnlp_secret_rotation_ids r on r.old_id = s.id
  ),
  'key replacement deletes the old Vault secret'
);

select is(
  public.read_finnlp_api_key(
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001'
  ),
  'finnlp-replacement-test-key-123456789',
  'after replacement, only the newest key is returned'
);

select is(
  public.disconnect_finnlp_connection(
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001'
  ),
  true,
  'disconnect removes a member connection through the guarded service RPC'
);

select ok(
  not exists (
    select 1 from vault.secrets s
    join finnlp_secret_rotation_ids r on r.new_id = s.id
  )
  and not exists (
    select 1 from public.workspace_finnlp_connections c
    where c.workspace_id = 'a2000000-0000-4000-8000-000000000001'
      and c.user_id = 'a1000000-0000-4000-8000-000000000001'
  ),
  'disconnect removes both connection metadata and current Vault secret'
);

reset role;

insert into public.tasks (
  id, workspace_id, owner_id, title, details, status, attempt
) values (
  'a3000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'Read company news', 'Retrieve bounded public company news for a ticker.', 'Planning', 1
)
on conflict (id) do nothing;

select vault.create_secret(
  'finnlp-plan-signing-key-at-least-32-characters',
  'flowwork-plan-signing-key',
  'Temporary signing key for FinNLP plan validation tests.'
);

create temporary table finnlp_plan_payload(value jsonb);
insert into finnlp_plan_payload values (
  jsonb_build_object(
    'id', 'ignored-by-server',
    'taskId', 'a3000000-0000-4000-8000-000000000001',
    'goal', 'Retrieve public company news for AAPL for a short date range.',
    'summary', 'Retrieve public company news as reviewable evidence.',
    'steps', jsonb_build_array(jsonb_build_object(
      'id', 'read_company_news',
      'title', 'Read company news',
      'description', 'Retrieve source-linked public news for the requested ticker and dates.',
      'toolId', 'finnlp-company-news',
      'toolVersion', '1.0.0',
      'input', jsonb_build_object(
        'ticker', 'AAPL',
        'startDate', '2026-10-01',
        'endDate', '2026-10-03'
      ),
      'dependencies', '[]'::jsonb,
      'expectedOutcome', 'A bounded list of source-linked news articles is returned.',
      'verificationCriteria', 'The ticker and date range match the request and sources remain marked as untrusted external data.'
    )),
    'dependencies', '[]'::jsonb,
    'createdAt', now()::text,
    'version', 1,
    'validationStatus', 'invalid',
    'limitations', '[]'::jsonb
  )
);

grant select on finnlp_plan_payload to authenticated;

create function pg_temp.create_signed_finnlp_plan(p_task_id uuid, p_plan jsonb)
returns jsonb
language sql
as $$
  select public.create_workflow_plan(
    p_task_id,
    p_plan::text,
    encode(
      extensions.hmac(
        p_plan::text,
        'finnlp-plan-signing-key-at-least-32-characters'::text,
        'sha256'::text
      ),
      'hex'
    )
  );
$$;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select lives_ok(
  $$ select pg_temp.create_signed_finnlp_plan(
       'a3000000-0000-4000-8000-000000000001',
       (select value from finnlp_plan_payload)
     ) $$,
  'a signed FinNLP plan may use a valid ticker and an inclusive range of up to 31 days'
);

select throws_ok(
  $$ select pg_temp.create_signed_finnlp_plan(
       'a3000000-0000-4000-8000-000000000001',
       jsonb_set((select value from finnlp_plan_payload), '{steps,0,input,ticker}', '"AAPL;DROP"'::jsonb)
     ) $$,
  '22023',
  'Plan contains invalid finnlp-company-news input.',
  'the database rejects malformed ticker values'
);

select throws_ok(
  $$ select pg_temp.create_signed_finnlp_plan(
       'a3000000-0000-4000-8000-000000000001',
       jsonb_set((select value from finnlp_plan_payload), '{steps,0,input,startDate}', '"2026-02-30"'::jsonb)
     ) $$,
  '22023',
  'Plan contains invalid finnlp-company-news input.',
  'the database rejects impossible calendar dates'
);

select throws_ok(
  $$ select pg_temp.create_signed_finnlp_plan(
       'a3000000-0000-4000-8000-000000000001',
       jsonb_set(
         jsonb_set((select value from finnlp_plan_payload), '{steps,0,input,startDate}', '"2026-09-01"'::jsonb),
         '{steps,0,input,endDate}', '"2026-10-02"'::jsonb
       )
     ) $$,
  '22023',
  'Plan contains invalid finnlp-company-news input.',
  'the database rejects date ranges longer than 31 days'
);

select throws_ok(
  $$ select pg_temp.create_signed_finnlp_plan(
       'a3000000-0000-4000-8000-000000000001',
       jsonb_set(
         (select value from finnlp_plan_payload),
         '{steps,0,input,providerUrl}',
         '"https://attacker.example"'::jsonb,
         true
       )
     ) $$,
  '22023',
  'Plan contains invalid finnlp-company-news input.',
  'the database rejects extra input keys that could add provider URL control'
);

select throws_ok(
  $$ select pg_temp.create_signed_finnlp_plan(
       'a3000000-0000-4000-8000-000000000001',
       jsonb_set(
         (select value from finnlp_plan_payload),
         '{steps,0,input,endDate}',
         to_jsonb((timezone('utc', now())::date + 1)::text)
       )
     ) $$,
  '22023',
  'Plan contains invalid finnlp-company-news input.',
  'the database rejects future end dates'
);

reset role;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values (
  'a1000000-0000-4000-8000-000000000002',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'finnlp-cascade@example.test', '',
  now(), now(), now()
)
on conflict (id) do nothing;

insert into public.workspaces (id, name, created_by)
values (
  'a2000000-0000-4000-8000-000000000002',
  'FinNLP cascade cleanup test workspace',
  'a1000000-0000-4000-8000-000000000002'
)
on conflict (id) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'a2000000-0000-4000-8000-000000000002',
  'a1000000-0000-4000-8000-000000000002',
  'owner'
)
on conflict (workspace_id, user_id) do nothing;

create temporary table finnlp_cascade_secret_ids(id uuid);
insert into finnlp_cascade_secret_ids
select vault.create_secret(
  'finnlp-cascade-cleanup-test-key-123456',
  'finnlp-cascade-cleanup-test',
  'Temporary secret to verify workspace-membership cascade cleanup.'
);

insert into public.workspace_finnlp_connections (
  workspace_id, user_id, api_key_secret_id
)
select
  'a2000000-0000-4000-8000-000000000002',
  'a1000000-0000-4000-8000-000000000002',
  id
from finnlp_cascade_secret_ids;

select lives_ok(
  $$ delete from public.workspace_members
     where workspace_id = 'a2000000-0000-4000-8000-000000000002'
       and user_id = 'a1000000-0000-4000-8000-000000000002' $$,
  'removing a workspace member also removes their FinNLP connection'
);
select ok(
  not exists (
    select 1 from public.workspace_finnlp_connections c
    where c.workspace_id = 'a2000000-0000-4000-8000-000000000002'
      and c.user_id = 'a1000000-0000-4000-8000-000000000002'
  )
  and not exists (
    select 1 from vault.secrets s
    join finnlp_cascade_secret_ids x on x.id = s.id
  ),
  'workspace-membership cascade deletes the associated Vault secret'
);

select * from finish();
rollback;
