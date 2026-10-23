begin;

create table public.workspace_google_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  user_id uuid not null,
  google_subject text not null check (char_length(trim(google_subject)) between 1 and 255),
  google_email text not null check (char_length(trim(google_email)) between 3 and 320),
  granted_scopes text[] not null check (
    'https://www.googleapis.com/auth/drive.file' = any(granted_scopes)
    and 'openid' = any(granted_scopes)
  ),
  refresh_secret_id uuid not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id),
  foreign key (workspace_id, user_id)
    references public.workspace_members (workspace_id, user_id) on delete cascade
);

create index workspace_google_connections_workspace_idx
  on public.workspace_google_connections (workspace_id, user_id);

alter table public.workspace_google_connections enable row level security;

create policy "users can read their own workspace google connection"
  on public.workspace_google_connections
  for select to authenticated
  using (
    user_id = auth.uid()
    and public.is_workspace_member(workspace_id)
  );

revoke all on public.workspace_google_connections from public, anon, authenticated, service_role;
grant select on public.workspace_google_connections to authenticated;
grant select, insert, update, delete on public.workspace_google_connections to service_role;

create table public.google_workspace_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  workspace_id uuid not null,
  user_id uuid not null,
  pkce_verifier_secret_id uuid not null,
  redirect_uri text not null check (char_length(trim(redirect_uri)) between 1 and 2048),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at),
  foreign key (workspace_id, user_id)
    references public.workspace_members (workspace_id, user_id) on delete cascade
);

create index google_workspace_oauth_states_expiry_idx
  on public.google_workspace_oauth_states (expires_at);

alter table public.google_workspace_oauth_states enable row level security;
revoke all on public.google_workspace_oauth_states from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.google_workspace_oauth_states to service_role;

create or replace function public.store_google_workspace_secret(
  p_secret text,
  p_name text,
  p_description text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, vault, auth, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Privileged server access is required.' using errcode = '42501';
  end if;
  if p_secret is null or char_length(p_secret) not between 1 and 8192
    or p_name is null or char_length(trim(p_name)) not between 1 and 180
    or p_description is null or char_length(trim(p_description)) > 400 then
    raise exception 'Invalid Google secret metadata.' using errcode = '22023';
  end if;
  return vault.create_secret(p_secret, p_name, p_description);
end;
$$;

create or replace function public.read_google_workspace_secret(p_secret_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, vault, auth, pg_temp
as $$
declare
  v_secret text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Privileged server access is required.' using errcode = '42501';
  end if;
  if p_secret_id is null then
    raise exception 'A Google secret reference is required.' using errcode = '22023';
  end if;
  select s.decrypted_secret into v_secret
  from vault.decrypted_secrets s
  where s.id = p_secret_id;
  return v_secret;
end;
$$;

create or replace function public.delete_google_workspace_secret(p_secret_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, vault, auth, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Privileged server access is required.' using errcode = '42501';
  end if;
  if p_secret_id is null then
    raise exception 'A Google secret reference is required.' using errcode = '22023';
  end if;
  perform vault.delete_secret(p_secret_id);
  return true;
end;
$$;

revoke all on function public.store_google_workspace_secret(text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.read_google_workspace_secret(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_google_workspace_secret(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.store_google_workspace_secret(text, text, text) to service_role;
grant execute on function public.read_google_workspace_secret(uuid) to service_role;
grant execute on function public.delete_google_workspace_secret(uuid) to service_role;

comment on table public.workspace_google_connections is
  'Per-user, per-workspace Google connection metadata. OAuth refresh tokens are held in Supabase Vault; no token is exposed to authenticated clients.';
comment on table public.google_workspace_oauth_states is
  'Single-use, expiring Google OAuth state records. Only the service role may read or mutate OAuth state.';
comment on function public.store_google_workspace_secret(text, text, text) is
  'Stores Google OAuth material in Vault. Callable only by service-role JWTs.';
comment on function public.read_google_workspace_secret(uuid) is
  'Reads Google OAuth material from Vault. Callable only by service-role JWTs.';
comment on function public.delete_google_workspace_secret(uuid) is
  'Deletes Google OAuth material from Vault. Callable only by service-role JWTs.';

commit;
