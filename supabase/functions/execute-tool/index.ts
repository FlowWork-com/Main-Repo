import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SupabaseWorkflowRepository } from '../../../src/backend/workflowRepository.ts';
import { createVerifiedAuthenticator } from './auth.ts';
import { createServerToolExecutionService } from './createService.ts';
import {
  createExecuteToolHandler,
  parseAllowedOrigins,
  ToolRequestError,
} from './handler.ts';

const supabaseUrl = requiredEnvironment('SUPABASE_URL');
const anonKey = requiredEnvironment('SUPABASE_ANON_KEY');
const serviceRoleKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const handler = createExecuteToolHandler<SupabaseClient>({
  origins: parseAllowedOrigins(Deno.env.get('APP_ORIGINS')),
  authenticate: createVerifiedAuthenticator((accessToken) =>
    createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    })),
  execute: async (caller, request, signal) => {
    const workflowRepository = new SupabaseWorkflowRepository(caller.context);
    const task = await workflowRepository.getTask(request.taskId);
    if (!task) {
      throw new ToolRequestError(
        403,
        'PERMISSION_DENIED',
        'Workspace access is required to execute this tool.',
      );
    }

    const { data: membership, error: membershipError } = await caller.context
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', task.workspaceId)
      .eq('user_id', caller.userId)
      .maybeSingle();
    if (membershipError) throw new Error('Unable to verify workspace membership.');
    if (!membership) {
      throw new ToolRequestError(
        403,
        'PERMISSION_DENIED',
        'Workspace access is required to execute this tool.',
      );
    }

    const service = createServerToolExecutionService(
      serviceClient,
      workflowRepository,
    );
    return service.execute(
      {
        ...request,
        userId: caller.userId,
        workspaceId: task.workspaceId,
      },
      task.workflow,
      signal,
    );
  },
  logFailure: (code) => console.error('[execute-tool]', code),
});

Deno.serve(handler);

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value?.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
