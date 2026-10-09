import type { SupabaseClient } from '@supabase/supabase-js';
import { createMvpTools } from '../../../src/tools/mvpTools.ts';
import { ToolExecutor } from '../../../src/tools/toolExecutor.ts';
import { ToolRegistry } from '../../../src/tools/toolRegistry.ts';
import { SupabaseToolExecutionRepository } from '../../../src/backend/toolExecutionRepository.ts';
import { ToolExecutionService } from '../../../src/backend/toolExecutionService.ts';
import type { WorkflowRepository } from '../../../src/backend/workflowRepository.ts';

export function createServerToolExecutionService(
  privilegedClient: SupabaseClient,
  workflowRepository: WorkflowRepository,
  timeoutMs = 5_000,
): ToolExecutionService {
  const executionRepository = new SupabaseToolExecutionRepository(privilegedClient);
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
