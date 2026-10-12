import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SupabaseWorkflowRepository } from '../../../src/backend/workflowRepository.ts';
import { createVerifiedAuthenticator } from '../execute-tool/auth.ts';
import { createPlanWorkflowHandler, parseAllowedOrigins } from './handler.ts';

const supabaseUrl = requiredEnvironment('SUPABASE_URL');
const anonKey = requiredEnvironment('SUPABASE_ANON_KEY');

const handler = createPlanWorkflowHandler<SupabaseClient>({
  origins: parseAllowedOrigins(Deno.env.get('APP_ORIGINS')),
  authenticate: createVerifiedAuthenticator((accessToken) =>
    createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    })),
  loadTask: async (caller, taskId) => {
    const repository = new SupabaseWorkflowRepository(caller.context);
    const task = await repository.getTask(taskId);
    if (!task) return null;
    const { data: membership, error: membershipError } = await caller.context
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', task.workspaceId)
      .eq('user_id', caller.userId)
      .maybeSingle();
    if (membershipError) throw new Error('Unable to verify workspace membership.');
    if (!membership) return null;
    return {
      id: task.id,
      workspaceId: task.workspaceId,
      ownerId: task.ownerId,
      title: task.title,
      details: task.details,
    };
  },
  logFailure: (code) => console.error('[plan-workflow]', code),
});

Deno.serve(handler);

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value?.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
