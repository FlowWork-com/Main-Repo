import { describe, expect, it, vi } from 'vitest';
import { executeTool } from './toolExecutionClient';

describe('executeTool browser adapter', () => {
  it('invokes the authenticated Edge Function with only client execution fields', async () => {
    const request = {
      taskId: '43000000-0000-4000-8000-000000000001',
      executionId: '44000000-0000-4000-8000-000000000001',
      requestId: 'request-1',
      toolId: 'echo',
      toolVersion: '1.0.0',
      input: { value: 'safe' },
    };
    const invoke = vi.fn().mockResolvedValue({
      data: {
        result: { success: true, output: { value: 'safe' } },
        workflowStatus: 'Verifying',
      },
      error: null,
    });
    const client = { functions: { invoke } };

    await expect(executeTool(client, request)).resolves.toEqual({
      result: { success: true, output: { value: 'safe' } },
      workflowStatus: 'Verifying',
    });
    expect(invoke).toHaveBeenCalledWith('execute-tool', { body: request });
  });

  it('does not expose raw Edge Function errors to the browser caller', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: null,
      error: new Error('database secret details'),
    });
    const client = { functions: { invoke } };

    await expect(
      executeTool(client, {
        taskId: '43000000-0000-4000-8000-000000000001',
        executionId: '44000000-0000-4000-8000-000000000001',
        requestId: 'request-1',
        toolId: 'echo',
        toolVersion: '1.0.0',
        input: {},
      }),
    ).rejects.toThrow('Unable to execute this tool. Please retry.');
  });
});
