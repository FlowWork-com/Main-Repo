import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProviderCallMetric } from '../../../src/tools/contracts.ts';

export async function persistProviderCallMetrics(
  client: SupabaseClient,
  metrics: readonly ProviderCallMetric[],
): Promise<void> {
  if (metrics.length === 0) return;

  const { error } = await client.from('provider_call_metrics').insert(
    metrics.map((metric) => ({
      workspace_id: metric.workspaceId,
      task_id: metric.taskId,
      plan_id: metric.planId ?? null,
      run_id: metric.runId ?? null,
      step_id: metric.stepId ?? null,
      edge_request_id: metric.edgeRequestId,
      execution_request_id: metric.executionRequestId ?? null,
      execution_id: metric.executionId ?? null,
      stage: metric.stage,
      provider_id: metric.providerId,
      model_id: metric.modelId ?? null,
      outcome: metric.outcome,
      duration_ms: metric.durationMs,
      retry_count: metric.retryCount,
      input_tokens: metric.inputTokens ?? null,
      output_tokens: metric.outputTokens ?? null,
      total_tokens: metric.totalTokens ?? null,
      provider_reported_cost: metric.providerReportedCost ?? null,
      provider_reported_cost_currency: metric.providerReportedCostCurrency ?? null,
      failure_category: metric.failureCategory ?? null,
    })),
  );
  if (error) throw new Error('Provider metrics could not be persisted.');
}
