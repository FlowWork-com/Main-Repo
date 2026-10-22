import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SupabaseWorkflowRepository } from '../../../src/backend/workflowRepository.ts';
import type { WorkflowPlan } from '../../../src/planning/planning.ts';
import { createVerifiedAuthenticator } from '../execute-tool/auth.ts';
import { createPlanWorkflowHandler, parseAllowedOrigins } from './handler.ts';

const supabaseUrl = requiredEnvironment('SUPABASE_URL');
const anonKey = requiredEnvironment('SUPABASE_ANON_KEY');

const handler = createPlanWorkflowHandler<SupabaseClient>({
  origins: parseAllowedOrigins(Deno.env.get('APP_ORIGINS')),
  plannerEnvironment: {
    FLOWWORK_PLANNER_PROVIDER: Deno.env.get('FLOWWORK_PLANNER_PROVIDER'),
    FLOWWORK_PLANNER_BASE_URL: Deno.env.get('FLOWWORK_PLANNER_BASE_URL'),
    FLOWWORK_PLANNER_MODEL: Deno.env.get('FLOWWORK_PLANNER_MODEL'),
    FLOWWORK_PLANNER_API_KEY: Deno.env.get('FLOWWORK_PLANNER_API_KEY'),
    FLOWWORK_PLANNER_ALLOW_MOCK: Deno.env.get('FLOWWORK_PLANNER_ALLOW_MOCK'),
  },
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
    const { data: attachments, error: attachmentsError } = await caller.context
      .from('task_files')
      .select('id, file_name, content_type')
      .eq('workspace_id', task.workspaceId)
      .eq('task_id', task.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (attachmentsError) throw new Error('Unable to load task attachment references.');

    return {
      id: task.id,
      workspaceId: task.workspaceId,
      ownerId: task.ownerId,
      title: task.title,
      details: task.details,
      availableAttachments: (attachments ?? []).map((file) => ({
        id: file.id,
        fileName: file.file_name,
        contentType: file.content_type,
      })),
    };
  },
  persistPlan: async (caller, task, plan) => {
    const signingKey = Deno.env.get('FLOWWORK_PLAN_SIGNING_KEY')?.trim();
    if (!signingKey || signingKey.length < 32) {
      throw new Error('Plan signing configuration is unavailable.');
    }
    const planJson = JSON.stringify(plan);
    const signature = await signPlan(planJson, signingKey);
    const { data, error } = await caller.context.rpc('create_workflow_plan', {
      p_task_id: task.id,
      p_plan_json: planJson,
      p_signature: signature,
    });
    if (error || !isRecord(data) || !isRecord(data.plan)) {
      throw new Error('Unable to persist plan proposal.');
    }
    return data.plan as unknown as WorkflowPlan;
  },
  logFailure: (code) => console.error('[plan-workflow]', code),
});

Deno.serve(handler);

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value?.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function signPlan(planJson: string, signingKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(planJson)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
