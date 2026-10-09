import { describe, expect, it, vi } from 'vitest';
import type { ToolExecutionContext } from './contracts';
import {
  createFileMetadataTool,
  createMvpTools,
  type TaskFileMetadataSource,
} from './mvpTools';
import { ToolRegistry } from './toolRegistry';

const context: ToolExecutionContext = {
  userId: 'user-1',
  workspaceId: 'workspace-1',
  taskId: 'task-1',
  executionId: '44000000-0000-4000-8000-000000000001',
  toolId: 'file-metadata',
  toolVersion: '1.0.0',
  requestId: 'request-1',
  signal: new AbortController().signal,
};

function registry(source: TaskFileMetadataSource): ToolRegistry {
  const result = new ToolRegistry();
  for (const tool of createMvpTools(source)) result.register(tool);
  return result;
}

describe('deterministic MVP tools', () => {
  it('echoes structured JSON without granting external capabilities', async () => {
    const source = { getTaskFileMetadata: vi.fn() };
    const tools = registry(source);
    const tool = tools.get('echo', '1.0.0');

    expect(tool).toBeDefined();
    expect(tool?.validateInput({ label: 'safe' })).toBe(true);
    expect(tool?.validateInput({ service_role_key: 'nope' })).toBe(false);
    expect(tool?.validateInput('Bearer abcdefghijklmnop')).toBe(false);
    await expect(
      tool?.execute(context, { label: 'safe' }),
    ).resolves.toEqual({
      success: true,
      output: { value: { label: 'safe' } },
    });
    expect(source.getTaskFileMetadata).not.toHaveBeenCalled();
  });

  it('performs deterministic text operations', async () => {
    const tools = registry({ getTaskFileMetadata: vi.fn() });
    const transform = tools.get('text-transform', '1.0.0');
    const transformContext = { ...context, toolId: 'text-transform' };

    await expect(
      transform?.execute(transformContext, {
        operation: 'replace',
        text: 'one one',
        search: 'one',
        replacement: 'two',
      }),
    ).resolves.toEqual({ success: true, output: { text: 'two two' } });
    await expect(
      transform?.execute(transformContext, {
        operation: 'extract',
        text: 'workflow',
        start: 0,
        end: 4,
      }),
    ).resolves.toEqual({ success: true, output: { text: 'work' } });
    expect(
      transform?.validateInput({
        operation: 'replace',
        text: 'secret',
        search: '',
        replacement: 'x',
      }),
    ).toBe(false);
  });

  it('inspects JSON deterministically and rejects malformed JSON', async () => {
    const tools = registry({ getTaskFileMetadata: vi.fn() });
    const inspect = tools.get('json-inspect', '1.0.0');
    const inspectContext = { ...context, toolId: 'json-inspect' };

    await expect(
      inspect?.execute(inspectContext, { json: '{"z":1,"a":true}' }),
    ).resolves.toEqual({
      success: true,
      output: { type: 'object', keys: ['a', 'z'] },
    });
    await expect(
      inspect?.execute(inspectContext, { json: '{bad json' }),
    ).resolves.toMatchObject({
      success: false,
      error: { code: 'INVALID_TOOL_INPUT' },
    });
  });

  it('reads only metadata returned for the given task file and produces evidence', async () => {
    const source = {
      getTaskFileMetadata: vi.fn(async (receivedContext, fileId) => {
        expect(receivedContext.taskId).toBe(context.taskId);
        expect(receivedContext.workspaceId).toBe(context.workspaceId);
        expect(fileId).toBe('55000000-0000-4000-8000-000000000001');
        return {
          id: fileId,
          fileName: 'receipt.pdf',
          contentType: 'application/pdf',
          createdAt: '2026-10-08T10:00:00.000Z',
        };
      }),
    };
    const fileTool = createFileMetadataTool(source);
    const result = await fileTool.execute(context, {
      fileId: '55000000-0000-4000-8000-000000000001',
    });

    expect(result).toEqual({
      success: true,
      output: {
        id: '55000000-0000-4000-8000-000000000001',
        fileName: 'receipt.pdf',
        contentType: 'application/pdf',
        createdAt: '2026-10-08T10:00:00.000Z',
      },
      evidence: {
        type: 'task-file-metadata',
        reference: '55000000-0000-4000-8000-000000000001',
        summary: 'Metadata for receipt.pdf',
      },
    });
    expect(fileTool.validateInput({ path: 'C:\\private\\file.txt' })).toBe(false);
  });
});
