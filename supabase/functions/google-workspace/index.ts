import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createVerifiedAuthenticator } from '../execute-tool/auth.ts';
import {
  createGoogleWorkspaceHandler,
  type GoogleOAuthState,
  type GoogleWorkspaceConnection,
} from './handler.ts';

const supabaseUrl = requiredEnvironment('SUPABASE_URL');
const anonKey = requiredEnvironment('SUPABASE_ANON_KEY');
const serviceRoleKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');

const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const handler = createGoogleWorkspaceHandler<SupabaseClient>({
  origins: parseAllowedOrigins(Deno.env.get('APP_ORIGINS')),
  environment: {
    FLOWWORK_GOOGLE_CLIENT_ID: Deno.env.get('FLOWWORK_GOOGLE_CLIENT_ID'),
    FLOWWORK_GOOGLE_CLIENT_SECRET: Deno.env.get('FLOWWORK_GOOGLE_CLIENT_SECRET'),
    FLOWWORK_GOOGLE_REDIRECT_URI: Deno.env.get('FLOWWORK_GOOGLE_REDIRECT_URI'),
    FLOWWORK_GOOGLE_APP_REDIRECT_URL: Deno.env.get('FLOWWORK_GOOGLE_APP_REDIRECT_URL'),
  },
  authenticate: createVerifiedAuthenticator((accessToken) =>
    createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    })),
  isWorkspaceMember: async (caller, workspaceId) => {
    const { data, error } = await caller.context
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', caller.userId)
      .maybeSingle();
    if (error) throw new Error('Membership verification failed.');
    return Boolean(data);
  },
  isCurrentMember: async (workspaceId, userId) => {
    const { data, error } = await serviceClient
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error('Membership verification failed.');
    return Boolean(data);
  },
  storeSecret: async (secret, name, description) => {
    const { data, error } = await serviceClient.rpc('store_google_workspace_secret', {
      p_secret: secret,
      p_name: name,
      p_description: description,
    });
    if (error || typeof data !== 'string' || !isUuid(data)) {
      throw new Error('Secret storage is unavailable.');
    }
    return data;
  },
  readSecret: async (secretId) => {
    if (!isUuid(secretId)) throw new Error('Secret reference is invalid.');
    const { data, error } = await serviceClient.rpc('read_google_workspace_secret', {
      p_secret_id: secretId,
    });
    if (error) throw new Error('Secret read failed.');
    return typeof data === 'string' && data.length > 0 ? data : null;
  },
  deleteSecret: async (secretId) => {
    if (!isUuid(secretId)) throw new Error('Secret reference is invalid.');
    const { error } = await serviceClient.rpc('delete_google_workspace_secret', {
      p_secret_id: secretId,
    });
    if (error) throw new Error('Secret deletion failed.');
  },
  createOAuthState: async (state: Omit<GoogleOAuthState, 'consumed_at'>) => {
    const { error } = await serviceClient.from('google_workspace_oauth_states').insert({
      state_hash: state.state_hash,
      workspace_id: state.workspace_id,
      user_id: state.user_id,
      pkce_verifier_secret_id: state.pkce_verifier_secret_id,
      redirect_uri: state.redirect_uri,
      created_at: state.created_at,
      expires_at: state.expires_at,
      requested_scope_set: state.requested_scope_set,
    });
    if (error) throw new Error('OAuth state persistence failed.');
  },
  consumeOAuthState: async (stateHash) => {
    const { data, error } = await serviceClient
      .from('google_workspace_oauth_states')
      .update({ consumed_at: new Date().toISOString() })
      .eq('state_hash', stateHash)
      .is('consumed_at', null)
      .select('state_hash, workspace_id, user_id, pkce_verifier_secret_id, redirect_uri, created_at, expires_at, consumed_at, requested_scope_set')
      .maybeSingle();
    if (error) throw new Error('OAuth state validation failed.');
    return data as GoogleOAuthState | null;
  },
  getConnection: async (workspaceId, userId) => {
    const { data, error } = await serviceClient
      .from('workspace_google_connections')
      .select('workspace_id, user_id, google_subject, google_email, granted_scopes, refresh_secret_id, connected_at')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error('Google connection lookup failed.');
    return data as GoogleWorkspaceConnection | null;
  },
  saveConnection: async (connection) => {
    const { error } = await serviceClient.from('workspace_google_connections').upsert({
      workspace_id: connection.workspace_id,
      user_id: connection.user_id,
      google_subject: connection.google_subject,
      google_email: connection.google_email,
      granted_scopes: connection.granted_scopes,
      refresh_secret_id: connection.refresh_secret_id,
      connected_at: connection.connected_at,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,user_id' });
    if (error) throw new Error('Google connection persistence failed.');
  },
  deleteConnection: async (workspaceId, userId) => {
    const { data, error } = await serviceClient
      .from('workspace_google_connections')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .select('workspace_id, user_id, google_subject, google_email, granted_scopes, refresh_secret_id, connected_at')
      .maybeSingle();
    if (error) throw new Error('Google connection removal failed.');
    return data as GoogleWorkspaceConnection | null;
  },
  logFailure: (code) => console.error('[google-workspace]', code),
});

Deno.serve(handler);

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value?.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseAllowedOrigins(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
