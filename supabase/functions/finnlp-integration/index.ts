import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createVerifiedAuthenticator } from '../execute-tool/auth.ts';
import { validateFinnhubApiKey } from '../execute-tool/finnlpProvider.ts';
import { createFinnlpIntegrationHandler } from './handler.ts';

const supabaseUrl = requiredEnvironment('SUPABASE_URL');
const anonKey = requiredEnvironment('SUPABASE_ANON_KEY');
const serviceRoleKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');

const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const handler = createFinnlpIntegrationHandler<SupabaseClient>({
  origins: parseAllowedOrigins(Deno.env.get('APP_ORIGINS')),
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
  getConnection: async (workspaceId, userId) => {
    const { data, error } = await serviceClient
      .from('workspace_finnlp_connections')
      .select('connected_at')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error('FinNLP connection lookup failed.');
    return data as { connected_at: string } | null;
  },
  connect: async (workspaceId, userId, apiKey) => {
    const { data, error } = await serviceClient.rpc('connect_finnlp_connection', {
      p_workspace_id: workspaceId,
      p_user_id: userId,
      p_api_key: apiKey,
    });
    if (error || !isRecord(data) || typeof data.connected_at !== 'string') {
      throw new Error('Secure FinNLP credential storage failed.');
    }
    return { connected_at: data.connected_at };
  },
  disconnect: async (workspaceId, userId) => {
    const { error } = await serviceClient.rpc('disconnect_finnlp_connection', {
      p_workspace_id: workspaceId,
      p_user_id: userId,
    });
    if (error) throw new Error('FinNLP connection removal failed.');
  },
  validateApiKey: async (apiKey) => (await validateFinnhubApiKey(apiKey)).status,
  logFailure: (code) => console.error('[finnlp-integration]', code),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
