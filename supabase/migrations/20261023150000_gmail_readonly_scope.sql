-- Track which capability a Google OAuth state is granting. Drive and Gmail
-- are explicit consent paths; Gmail access is never inferred from Drive consent.
begin;

alter table public.google_workspace_oauth_states
  add column requested_scope_set text not null default 'drive'
  check (requested_scope_set in ('drive', 'gmail'));

alter table public.workspace_google_connections
  drop constraint if exists workspace_google_connections_granted_scopes_check;

alter table public.workspace_google_connections
  add constraint workspace_google_connections_granted_scopes_check
  check (
    'openid' = any(granted_scopes)
    and 'https://www.googleapis.com/auth/userinfo.email' = any(granted_scopes)
    and (
      'https://www.googleapis.com/auth/drive.file' = any(granted_scopes)
      or 'https://www.googleapis.com/auth/gmail.readonly' = any(granted_scopes)
    )
  );

comment on column public.google_workspace_oauth_states.requested_scope_set is
  'Explicit OAuth capability requested for this one-time state: Drive or Gmail read-only.';

comment on constraint workspace_google_connections_granted_scopes_check
  on public.workspace_google_connections is
  'Connection must have identity scopes and at least one explicitly granted supported capability: drive.file or gmail.readonly.';

commit;
