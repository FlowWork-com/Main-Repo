import {
  isCredentialLikeString,
  isPersistableJson,
  type JsonValue,
  type ToolMetadata,
} from '../tools/contracts';
import type { ToolRegistry } from '../tools/toolRegistry';

export const MAX_PLAN_STEPS = 10;
export const MAX_STRING_LENGTH = 4000;

export type PlannerErrorCode =
  | 'PLANNER_NOT_CONFIGURED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INVALID_RESPONSE'
  | 'INVALID_PLAN'
  | 'UNSUPPORTED_CAPABILITY';

export interface PlannerErrorDetails {
  readonly code: PlannerErrorCode;
  readonly message: string;
  readonly details?: string;
}

export interface PlannerRequest {
  readonly taskId: string;
  readonly goal: string;
  readonly toolCatalog: readonly ToolMetadata[];
  readonly availableAttachments?: readonly {
    readonly id: string;
    readonly fileName: string;
    readonly contentType: string | null;
  }[];
  readonly maxSteps?: number;
}

export interface PlannerProvider {
  generatePlan(request: PlannerRequest): Promise<WorkflowPlan>;
}

export type PlanValidationStatus = 'valid' | 'invalid';

export interface PlanStepValidation {
  readonly valid: boolean;
  readonly blockingReasons: readonly string[];
}

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly input: JsonValue;
  readonly dependencies: readonly string[];
  readonly expectedOutcome: string;
  readonly verificationCriteria: string;
  readonly validation: PlanStepValidation;
}

export interface WorkflowPlan {
  readonly id: string;
  readonly taskId: string;
  readonly goal: string;
  readonly summary: string;
  readonly steps: readonly PlanStep[];
  readonly dependencies: readonly string[];
  readonly createdAt: string;
  readonly version: number;
  readonly validationStatus: PlanValidationStatus;
  readonly limitations: readonly string[];
}

export class PlannerError extends Error {
  readonly code: PlannerErrorCode;
  readonly details?: string;

  constructor(code: PlannerErrorCode, message: string, details?: string) {
    super(message);
    this.name = 'PlannerError';
    this.code = code;
    this.details = details;
  }
}

export function createPlannerError(
  code: PlannerErrorCode,
  message: string,
  details?: string,
): PlannerError {
  const sanitizedMessage = sanitizePlannerMessage(message);
  const finalMessage = code === 'PLANNER_NOT_CONFIGURED' && !sanitizedMessage.toLowerCase().includes('not configured')
    ? 'The planner is not configured.'
    : sanitizedMessage;
  return new PlannerError(code, finalMessage, details?.trim() ? sanitizePlannerMessage(details) : undefined);
}

export function buildToolCatalogForPlanner(registry: ToolRegistry): readonly ToolMetadata[] {
  return registry.list().map((meta) => ({
    id: meta.id,
    name: meta.name,
    description: meta.description,
    version: meta.version,
    riskLevel: meta.riskLevel,
    requiresApproval: meta.requiresApproval,
    inputSchema: meta.inputSchema,
  }));
}

export function planFromModelResponse(raw: unknown): WorkflowPlan {
  const plan = normalizePlan(raw);
  return plan;
}

export function validatePlan(
  plan: unknown,
  registry: ToolRegistry,
  expected?: { readonly taskId: string; readonly goal?: string },
): WorkflowPlan {
  const normalized = normalizePlan(plan);
  if (expected && (normalized.taskId !== expected.taskId || (expected.goal !== undefined && normalized.goal !== expected.goal))) {
    throw createPlannerError('INVALID_PLAN', 'The plan does not match the requested task and goal.');
  }
  const unsupported = detectUnsupportedCapabilities(normalized.goal, normalized.limitations);
  const explicitlyBlocked = normalized.steps.length === 0 && normalized.limitations.length > 0;
  ensureStepCount(normalized, unsupported.length > 0 || explicitlyBlocked);
  if (explicitlyBlocked && unsupported.length === 0) {
    return {
      ...normalized,
      steps: [],
      dependencies: [],
      validationStatus: 'invalid',
      limitations: normalized.limitations,
    };
  }
  const stepIds = new Set(normalized.steps.map((step) => step.id));
  const graph = new Map<string, string[]>();

  for (const step of normalized.steps) {
    if (stepIds.size !== normalized.steps.length) {
      throw createPlannerError('INVALID_PLAN', `Duplicate step id "${step.id}".`);
    }
    graph.set(step.id, [...step.dependencies]);

    if (step.dependencies.some((dependency) => dependency === step.id)) {
      throw createPlannerError('INVALID_PLAN', `Step "${step.id}" cannot depend on itself.`);
    }
    if (new Set(step.dependencies).size !== step.dependencies.length) {
      throw createPlannerError('INVALID_PLAN', `Step "${step.id}" contains duplicate dependencies.`);
    }

    const definition = registry.get(step.toolId, step.toolVersion);
    if (!definition) {
      throw createPlannerError(
        'INVALID_PLAN',
        `Unknown tool "${step.toolId}" version "${step.toolVersion}" in plan.`,
      );
    }
    if (!definition.validateInput(step.input)) {
      throw createPlannerError(
        'INVALID_PLAN',
        `Input for tool "${step.toolId}" is invalid.`,
      );
    }
    if (containsCredentialLikeValue(step.input)) {
      throw createPlannerError('INVALID_PLAN', `Step "${step.id}" input contains credential-like data.`);
    }
    if (expected && containsCrossTaskReference(step.input, expected.taskId)) {
      throw createPlannerError('INVALID_PLAN', `Step "${step.id}" references a different task.`);
    }
    if (!isPersistableJson(step.input)) {
      throw createPlannerError('INVALID_PLAN', `Step "${step.id}" input is not safe JSON.`);
    }

    for (const dependency of step.dependencies) {
      if (!stepIds.has(dependency)) {
        throw createPlannerError(
          'INVALID_PLAN',
          `Step "${step.id}" depends on missing step "${dependency}".`,
        );
      }
    }

  }

  for (const dependency of normalized.dependencies) {
    if (!stepIds.has(dependency)) {
      throw createPlannerError('INVALID_PLAN', `Plan dependency references missing step "${dependency}".`);
    }
  }

  if (hasCycle(graph)) {
    throw createPlannerError('INVALID_PLAN', 'Plan dependency graph contains a cycle.');
  }

  if (unsupported.length > 0) {
    return {
      ...normalized,
      steps: [],
      dependencies: [],
      validationStatus: 'invalid',
      limitations: [...new Set([...normalized.limitations, ...unsupported])],
    };
  }

  return {
    ...normalized,
    steps: normalized.steps.map((step) => ({
      ...step,
      validation: { valid: true, blockingReasons: [] },
    })),
    validationStatus: 'valid',
    limitations: normalized.limitations,
  } as WorkflowPlan;
}

export function sanitizePlanResponse(value: unknown): WorkflowPlan | null {
  if (!value || typeof value !== 'object') return null;
  try {
    return planFromModelResponse(value);
  } catch {
    return null;
  }
}

function normalizePlan(raw: unknown): WorkflowPlan {
  if (!raw || typeof raw !== 'object') {
    throw createPlannerError('INVALID_RESPONSE', 'Planner returned a non-object payload.');
  }
  const record = raw as Record<string, unknown>;

  const id = readRequiredString(record.id, 'plan id');
  const taskId = readRequiredString(record.taskId, 'task id');
  const goal = readRequiredString(record.goal, 'goal');
  const summary = readRequiredString(record.summary, 'summary');
  const createdAt = readRequiredString(record.createdAt, 'createdAt');
  const version = readRequiredNumber(record.version, 'version');
  const dependencies = readStringArray(record.dependencies, 'dependencies', MAX_PLAN_STEPS);
  const limitations = readStringArray(record.limitations, 'limitations', 20);

  if (!Array.isArray(record.steps) || record.steps.length > MAX_PLAN_STEPS) {
    throw createPlannerError('INVALID_RESPONSE', `Plan cannot contain more than ${MAX_PLAN_STEPS} steps.`);
  }
  const steps = record.steps;
  const normalizedSteps: readonly PlanStep[] = steps.map((step, index) => normalizeStep(step, index));

  return Object.freeze({
    id,
    taskId,
    goal: sanitizeField(goal, 2000),
    summary: sanitizeField(summary, 400),
    steps: normalizedSteps,
    dependencies,
    createdAt,
    version,
    validationStatus: normalizeStatus(record.validationStatus),
    limitations,
  });
}

function normalizeStep(raw: unknown, index: number): PlanStep {
  if (!raw || typeof raw !== 'object') {
    throw createPlannerError('INVALID_RESPONSE', `Step ${index + 1} is not an object.`);
  }

  const record = raw as Record<string, unknown>;
  const id = readRequiredString(record.id, `step ${index + 1} id`);
  const title = readRequiredString(record.title, `step ${index + 1} title`);
  const description = readRequiredString(record.description, `step ${index + 1} description`);
  const toolId = readRequiredString(record.toolId, `step ${index + 1} toolId`);
  const toolVersion = readRequiredString(record.toolVersion, `step ${index + 1} toolVersion`);
  const expectedOutcome = readRequiredString(record.expectedOutcome, `step ${index + 1} expectedOutcome`);
  const verificationCriteria = readRequiredString(
    record.verificationCriteria,
    `step ${index + 1} verificationCriteria`,
  );
  const dependencies = readStringArray(record.dependencies, `step ${index + 1} dependencies`, MAX_PLAN_STEPS);
  const input = normalizeJsonInput(record.input, `step ${index + 1} input`);
  const validation = normalizeStepValidation(record.validation, `step ${index + 1}`);

  return Object.freeze({
    id: sanitizeField(id, 200),
    title: sanitizeField(title, 200),
    description: sanitizeField(description, 1_000),
    toolId: sanitizeField(toolId, 100),
    toolVersion: sanitizeField(toolVersion, 40),
    input,
    dependencies: dependencies.map((dependency) => sanitizeField(dependency, 200)),
    expectedOutcome: sanitizeField(expectedOutcome, 1_000),
    verificationCriteria: sanitizeField(verificationCriteria, 1_000),
    validation,
  });
}

function normalizeStepValidation(raw: unknown, label: string): PlanStepValidation {
  if (raw === undefined) return Object.freeze({ valid: false, blockingReasons: [] });
  if (!raw || typeof raw !== 'object') throw createPlannerError('INVALID_RESPONSE', `${label} validation block is invalid.`);
  const record = raw as Record<string, unknown>;
  const valid = record.valid === true;
  const blockingReasons = Array.isArray(record.blockingReasons)
    ? record.blockingReasons.filter((item): item is string => typeof item === 'string').map((item) => sanitizeField(item, 400))
    : [];
  return Object.freeze({ valid, blockingReasons });
}

function normalizeJsonInput(value: unknown, label: string): JsonValue {
  if (!isJsonCandidate(value)) {
    throw createPlannerError('INVALID_RESPONSE', `${label} must be safe JSON.`);
  }
  return value as JsonValue;
}

function isJsonCandidate(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return true;
  }
  if (typeof value === 'string') {
    return value.length <= 32_768;
  }
  if (Array.isArray(value)) {
    return value.length <= 4_096 && value.every((entry) => isJsonCandidate(entry, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > 4_096) return false;
  return keys.every((key) => key.length <= 32_768 && isJsonCandidate(record[key], depth + 1));
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw createPlannerError('INVALID_RESPONSE', `Missing or invalid ${label}.`);
  }
  return value.trim();
}

function readRequiredNumber(value: unknown, label: string): number {
  if (!Number.isFinite(value) || Number(value) <= 0) {
    throw createPlannerError('INVALID_RESPONSE', `Missing or invalid ${label}.`);
  }
  return Number(value);
}

function readStringArray(value: unknown, label: string, maximumItems: number): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumItems || !value.every((item) => typeof item === 'string')) {
    throw createPlannerError('INVALID_RESPONSE', `${label} must be an array of strings.`);
  }
  return value.map((item) => sanitizeField(item, 400));
}

function sanitizeField(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw createPlannerError('INVALID_RESPONSE', `Field exceeded the ${maxLength}-character limit.`);
  }
  return trimmed;
}

function normalizeStatus(value: unknown): PlanValidationStatus {
  if (value === 'valid' || value === 'invalid') return value;
  return 'invalid';
}

function ensureStepCount(plan: WorkflowPlan, allowEmpty: boolean): void {
  if (plan.steps.length === 0 && !allowEmpty) {
    throw createPlannerError('INVALID_PLAN', 'Plan must contain at least one step.');
  }
  if (plan.steps.length > MAX_PLAN_STEPS) {
    throw createPlannerError('INVALID_PLAN', `Plan exceeds the maximum of ${MAX_PLAN_STEPS} steps.`);
  }
}

function containsCredentialLikeValue(value: unknown): boolean {
  if (typeof value === 'string') return isCredentialLikeString(value);
  if (Array.isArray(value)) return value.some((entry) => containsCredentialLikeValue(entry));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((entry) => containsCredentialLikeValue(entry));
  }
  return false;
}

function containsCrossTaskReference(value: unknown, taskId: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsCrossTaskReference(entry, taskId));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) => {
    if (['taskId', 'task_id'].includes(key.toLowerCase()) && typeof entry === 'string' && entry !== taskId) {
      return true;
    }
    return containsCrossTaskReference(entry, taskId);
  });
}

function detectUnsupportedCapabilities(goal: string, limitations: readonly string[]): readonly string[] {
  const statement = `${goal} ${limitations.join(' ')}`.toLowerCase();
  const unsupported: string[] = [];
  const capabilityRules: readonly { pattern: RegExp; limitation: string }[] = [
    {
      pattern: /\b(?:browser automation|automate (?:the )?browser|playwright|puppeteer|selenium|scrape (?:a |the )?website)\b/i,
      limitation: 'Browser automation is unavailable in this workspace.',
    },
    {
      pattern: /\b(?:send (?:an? )?email|send mail|email (?:the|to) [a-z0-9])/i,
      limitation: 'Email sending is not supported by the registered tool catalog.',
    },
    {
      pattern: /\b(?:create|send|schedule|modify|cancel) (?:a |an )?(?:calendar event|calendar invite|meeting invite)\b/i,
      limitation: 'Calendar changes are not supported by the registered tool catalog.',
    },
    {
      pattern: /\b(?:update|modify|delete|create) (?:a |the )?(?:crm record|customer record|salesforce record)\b/i,
      limitation: 'CRM record changes are not supported by the registered tool catalog.',
    },
    {
      pattern: /\b(?:send|post) (?:a |the )?(?:slack message|message to slack)\b/i,
      limitation: 'Sending Slack messages is not supported by the registered tool catalog.',
    },
    {
      pattern: /\b(?:run|execute) (?:arbitrary )?(?:shell command|terminal command|script)\b|\bfilesystem access\b/i,
      limitation: 'Arbitrary shell and filesystem access are not supported by the registered tool catalog.',
    },
  ];
  for (const rule of capabilityRules) {
    if (rule.pattern.test(statement)) unsupported.push(rule.limitation);
  }
  return [...new Set(unsupported)];
}

function hasCycle(graph: Map<string, readonly string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(node: string): boolean {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    const neighbors = graph.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (visit(neighbor)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  }

  for (const node of graph.keys()) {
    if (visit(node)) return true;
  }
  return false;
}

function sanitizePlannerMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

export const plannerErrorCodes = [
  'PLANNER_NOT_CONFIGURED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'INVALID_RESPONSE',
  'INVALID_PLAN',
  'UNSUPPORTED_CAPABILITY',
] as const;

export type PlannerResponse = {
  readonly success: true;
  readonly plan: WorkflowPlan;
} | {
  readonly success: false;
  readonly error: PlannerErrorDetails;
};

export interface PlannerAdapter {
  readonly providerName: string;
  generatePlan(request: PlannerRequest): Promise<PlannerResponse>;
}

export type PlannerConfig = {
  readonly provider?: PlannerAdapter | null;
};

export function assertPlannerConfigured(config: PlannerConfig): PlannerAdapter {
  if (!config.provider) {
    throw createPlannerError('PLANNER_NOT_CONFIGURED', 'The planner is not configured.');
  }
  return config.provider;
}
