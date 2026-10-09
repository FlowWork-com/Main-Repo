import type { SupabaseClient } from '@supabase/supabase-js';
import { createMvpTools } from '../tools/mvpTools';
import { ToolExecutor } from '../tools/toolExecutor';
import { ToolRegistry } from '../tools/toolRegistry';
import { SupabaseToolExecutionRepository } from './toolExecutionRepository';
import { ToolExecutionService } from './toolExecutionService';
import type { WorkflowRepository } from './workflowRepository';

export function createToolExecutionService(
  client: SupabaseClient,
  workflowRepository: WorkflowRepository,
  timeoutMs = 5_000,
): ToolExecutionService {
  const executionRepository = new SupabaseToolExecutionRepository(client);
  const registry = new ToolRegistry();
  for (const tool of createMvpTools(executionRepository)) {
    registry.register(tool);
  }
  return new ToolExecutionService(
    registry,
    new ToolExecutor(timeoutMs),
    executionRepository,
    workflowRepository,
  );
}
