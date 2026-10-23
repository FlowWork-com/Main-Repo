begin;

select plan(10);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  (
    'c1000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'google-owner@example.test', '', now(), now(), now()
  ),
  (
    'c1000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'google-outsider@example.test', '', now(), now(), now()
  )
on conflict (id) do nothing;

insert into public.workspaces (id, name, created_by)
values (
  'c2000000-0000-4000-8000-000000000001',
  'Google connection workspace',
  'c1000000-0000-4000-8000-000000000001'
)
on conflict (id) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'c2000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'owner'
)
on conflict (workspace_id, user_id) do nothing;

insert into public.workspace_google_connections (
  id, workspace_id, user_id, google_subject, google_email, granted_scopes,
  refresh_secret_id, connected_at, updated_at
) values (
  'c3000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'google-subject-owner',
  'drive-owner@example.test',
  array[
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/drive.file'
  ]::text[],
  'c4000000-0000-4000-8000-000000000001',
  now(),
  now()
)
on conflict (id) do nothing;

insert into public.google_workspace_oauth_states (
  state_hash, workspace_id, user_id, pkce_verifier_secret_id, redirect_uri, created_at, expires_at
) values (
  repeat('a', 64),
  'c2000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'c4000000-0000-4000-8000-000000000002',
  'https://project.example/functions/v1/google-workspace',
  now(),
  now() + interval '10 minutes'
);

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select is(
  (select count(*) from public.workspace_google_connections),
  1::bigint,
  'a workspace member can read their own saved Google connection'
);

select is(
  (select google_email from public.workspace_google_connections
   where workspace_id = 'c2000000-0000-4000-8000-000000000001'),
  'drive-owner@example.test',
  'the connection status exposes account metadata but not its refresh token'
);

select throws_ok(
  $$ select count(*) from public.google_workspace_oauth_states $$,
  '42501',
  'permission denied for table google_workspace_oauth_states',
  'authenticated users cannot read OAuth state or PKCE secret references'
);

select throws_ok(
  $$ update public.workspace_google_connections
     set google_email = 'forged@example.test'
     where id = 'c3000000-0000-4000-8000-000000000001' $$,
  '42501',
  'permission denied for table workspace_google_connections',
  'authenticated clients cannot replace connection metadata directly'
);

select throws_ok(
  $$ insert into public.google_workspace_oauth_states (
       state_hash, workspace_id, user_id, pkce_verifier_secret_id, redirect_uri, expires_at
     ) values (
       repeat('b', 64),
       'c2000000-0000-4000-8000-000000000001',
       'c1000000-0000-4000-8000-000000000001',
       'c4000000-0000-4000-8000-000000000003',
       'https://project.example/functions/v1/google-workspace',
       now() + interval '10 minutes'
     ) $$,
  '42501',
  'permission denied for table google_workspace_oauth_states',
  'authenticated clients cannot forge OAuth state or PKCE verifier references'
);

select throws_ok(
  $$ select public.store_google_workspace_secret(
       'secret-that-must-never-be-returned',
       'test-google-secret',
       'test-only secret'
     ) $$,
  '42501',
  'permission denied for function store_google_workspace_secret',
  'authenticated users cannot write secrets to Vault through the RPC'
);

select throws_ok(
  $$ select public.read_google_workspace_secret('c4000000-0000-4000-8000-000000000001') $$,
  '42501',
  'permission denied for function read_google_workspace_secret',
  'authenticated users cannot read Google OAuth secrets from Vault'
);

reset role;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000002', true);
set local role authenticated;

select is(
  (select count(*) from public.workspace_google_connections),
  0::bigint,
  'a non-member cannot read another workspace user’s Google connection'
);

select throws_ok(
  $$ insert into public.workspace_google_connections (
       workspace_id, user_id, google_subject, google_email, granted_scopes, refresh_secret_id
     ) values (
       'c2000000-0000-4000-8000-000000000001',
       'c1000000-0000-4000-8000-000000000002',
       'forged-google-subject',
       'outsider@example.test',
       array['openid', 'https://www.googleapis.com/auth/drive.file']::text[],
       'c4000000-0000-4000-8000-000000000009'
     ) $$,
  '42501',
  'permission denied for table workspace_google_connections',
  'non-members cannot attach a Google connection to another workspace'
);

select throws_ok(
  $$ select public.delete_google_workspace_secret('c4000000-0000-4000-8000-000000000001') $$,
  '42501',
  'permission denied for function delete_google_workspace_secret',
  'non-members cannot delete provider secrets through the RPC'
);

select * from finish();
rollback;
