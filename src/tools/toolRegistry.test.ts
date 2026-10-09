import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from './contracts';
import { ToolRegistry } from './toolRegistry';

function tool(version = '1.0.0'): ToolDefinition {
  return {
    id: 'echo',
    name: 'Echo',
    description: 'Return a JSON value.',
    version,
    riskLevel: 'low',
    requiresApproval: false,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    validateInput: (input): boolean =>
      Boolean(input && typeof input === 'object'),
    async execute() {
      return { success: true, output: { value: 'test' } };
    },
  };
}

describe('ToolRegistry', () => {
  it('registers and looks up immutable, versioned tool definitions', () => {
    const registry = new ToolRegistry();
    registry.register(tool());
    registry.register(tool('2.0.0'));

    expect(registry.has('echo', '1.0.0')).toBe(true);
    expect(registry.get('echo', '2.0.0')?.version).toBe('2.0.0');
    expect(registry.list().map(({ version }) => version)).toEqual([
      '1.0.0',
      '2.0.0',
    ]);
    expect(Object.isFrozen(registry.list()[0])).toBe(true);
    expect(Object.isFrozen(registry.list()[0].inputSchema)).toBe(true);
  });

  it('rejects duplicate id and version registrations and reports missing tools', () => {
    const registry = new ToolRegistry();
    registry.register(tool());

    expect(() => registry.register(tool())).toThrow('already registered');
    expect(registry.get('not-registered', '1.0.0')).toBeUndefined();
    expect(registry.has('not-registered', '1.0.0')).toBe(false);
  });

  it('does not permit high-risk tools without the approval gate', () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        ...tool(),
        riskLevel: 'destructive',
        requiresApproval: false,
      }),
    ).toThrow('must require workflow approval');
  });
});
