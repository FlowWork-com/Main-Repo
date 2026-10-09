import {
  toToolMetadata,
  type ToolDefinition,
  type ToolMetadata,
} from './contracts';

function versionKey(id: string, version: string): string {
  return `${id}\u0000${version}`;
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();
  private readonly metadata = new Map<string, ToolMetadata>();

  register(tool: ToolDefinition): void {
    if (
      !tool.id.trim() ||
      tool.id.length > 100 ||
      !tool.name.trim() ||
      !tool.description.trim() ||
      !tool.version.trim() ||
      tool.version.length > 40
    ) {
      throw new Error('Tool id, name, description, and version are required.');
    }
    if (
      !['low', 'medium', 'high', 'destructive'].includes(tool.riskLevel) ||
      ((tool.riskLevel === 'high' || tool.riskLevel === 'destructive') &&
        !tool.requiresApproval)
    ) {
      throw new Error('High-risk tools must require workflow approval.');
    }
    const key = versionKey(tool.id, tool.version);
    if (this.definitions.has(key)) {
      throw new Error(`Tool "${tool.id}" version "${tool.version}" is already registered.`);
    }

    const definition = Object.freeze({
      ...tool,
      inputSchema: deepFreeze({ ...tool.inputSchema }),
    });
    this.definitions.set(key, definition);
    this.metadata.set(key, toToolMetadata(definition));
  }

  get(id: string, version: string): ToolDefinition | undefined {
    return this.definitions.get(versionKey(id, version));
  }

  list(): readonly ToolMetadata[] {
    return Object.freeze(
      [...this.metadata.values()].sort(
        (left, right) =>
          left.id.localeCompare(right.id) ||
          left.version.localeCompare(right.version),
      ),
    );
  }

  has(id: string, version: string): boolean {
    return this.definitions.has(versionKey(id, version));
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object') {
    if (seen.has(value)) return value;
    seen.add(value);
    for (const entry of Object.values(value)) deepFreeze(entry, seen);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}
