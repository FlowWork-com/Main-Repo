import { describe, expect, it } from 'vitest';
import type {
  ToolDefinition,
  ToolExecutionContext,
} from './contracts';
import { ToolExecutor } from './toolExecutor';

const context: ToolExecutionContext = {
  userId: 'user-1',
  workspaceId: 'workspace-1',
  taskId: 'task-1',
  executionId: '44000000-0000-4000-8000-000000000001',
  toolId: 'test',
  toolVersion: '1.0.0',
  requestId: 'request-1',
  signal: new AbortController().signal,
};

function definition(
  execute: ToolDefinition['execute'],
): ToolDefinition {
  return {
    id: 'test',
    name: 'Test',
    description: 'Test tool',
    version: '1.0.0',
    riskLevel: 'low',
    requiresApproval: false,
    inputSchema: {},
    validateInput: () => true,
    execute,
  };
}

describe('ToolExecutor', () => {
  it('returns structured successful execution results', async () => {
    const result = await new ToolExecutor(100).execute(
      definition(async () => ({ success: true, output: { value: 'ok' } })),
      context,
      {},
    );

    expect(result).toEqual({ success: true, output: { value: 'ok' } });
  });

  it('converts thrown failures to a safe structured result', async () => {
    const result = await new ToolExecutor(100).execute(
      definition(async () => {
        throw new Error('private credential: do not expose');
      }),
      context,
      {},
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: 'EXECUTION_FAILED',
        message: 'Tool execution failed.',
        retryable: false,
      },
    });
  });

  it('times out and aborts the tool signal', async () => {
    let signal: AbortSignal | undefined;
    const result = await new ToolExecutor(5).execute(
      definition(
        (_toolContext) =>
          new Promise((resolve) => {
            signal = _toolContext.signal;
            setTimeout(
              () => resolve({ success: true, output: 'late' }),
              50,
            );
          }),
      ),
      context,
      {},
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: 'EXECUTION_TIMEOUT', retryable: true },
    });
    expect(signal?.aborted).toBe(true);
  });
});
