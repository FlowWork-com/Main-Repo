import type { SupabaseClient } from '@supabase/supabase-js';
import { createMvpTools } from '../../../src/tools/mvpTools.ts';
import { ToolExecutor } from '../../../src/tools/toolExecutor.ts';
import { ToolRegistry } from '../../../src/tools/toolRegistry.ts';
import { SupabaseToolExecutionRepository } from '../../../src/backend/toolExecutionRepository.ts';
import { ToolExecutionService } from '../../../src/backend/toolExecutionService.ts';
import type { WorkflowRepository } from '../../../src/backend/workflowRepository.ts';
import { readSpreadsheetWorkbook } from './xlsxReader.ts';
import { createInvoiceDocumentExtractorFromEnvironment } from './invoiceProvider.ts';
import { SupabaseFinnlpCompanyNewsProvider } from './finnlpProvider.ts';
import { createFinnlpFinancialReviewerFromEnvironment } from './finnlpReviewProvider.ts';

export function createServerToolExecutionService(
  privilegedClient: SupabaseClient,
  workflowRepository: WorkflowRepository,
  timeoutMs = 50_000,
): ToolExecutionService {
  const executionRepository = new SupabaseToolExecutionRepository(privilegedClient);
  const registry = new ToolRegistry();
  for (const tool of createMvpTools(
    executionRepository,
    executionRepository,
    readSpreadsheetWorkbook,
    createInvoiceDocumentExtractorFromEnvironment({
      FLOWWORK_INVOICE_PROVIDER: Deno.env.get('FLOWWORK_INVOICE_PROVIDER'),
      FLOWWORK_INVOICE_BASE_URL: Deno.env.get('FLOWWORK_INVOICE_BASE_URL'),
      FLOWWORK_INVOICE_MODEL: Deno.env.get('FLOWWORK_INVOICE_MODEL'),
      FLOWWORK_INVOICE_API_KEY: Deno.env.get('FLOWWORK_INVOICE_API_KEY'),
    }),
    new SupabaseFinnlpCompanyNewsProvider(privilegedClient),
    createFinnlpFinancialReviewerFromEnvironment({
      FLOWWORK_FINNLP_REVIEW_PROVIDER: Deno.env.get('FLOWWORK_FINNLP_REVIEW_PROVIDER'),
      FLOWWORK_FINNLP_REVIEW_BASE_URL: Deno.env.get('FLOWWORK_FINNLP_REVIEW_BASE_URL'),
      FLOWWORK_FINNLP_REVIEW_MODEL: Deno.env.get('FLOWWORK_FINNLP_REVIEW_MODEL'),
      FLOWWORK_FINNLP_REVIEW_API_KEY: Deno.env.get('FLOWWORK_FINNLP_REVIEW_API_KEY'),
    }),
  )) {
    registry.register(tool);
  }
  return new ToolExecutionService(
    registry,
    new ToolExecutor(timeoutMs),
    executionRepository,
    workflowRepository,
  );
}
