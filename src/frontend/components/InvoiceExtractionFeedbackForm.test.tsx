import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '../../tools/contracts';
import { InvoiceExtractionFeedbackForm } from './InvoiceExtractionFeedbackForm';

const workspaceId = 'a2000000-0000-4000-8000-000000000001';
const taskId = 'a3000000-0000-4000-8000-000000000001';
const fileId = 'a4000000-0000-4000-8000-000000000001';
const executionId = 'a6000000-0000-4000-8000-000000000001';

function makeOutput(): JsonValue {
  return {
    fileId,
    fields: {
      invoiceNumber: { value: 'INV-1', confidenceEstimate: 0.72, needsReview: true },
      invoiceDate: { value: '2026-10-22', confidenceEstimate: 0.96, needsReview: false },
      vendor: { value: 'Acme Ltd', confidenceEstimate: 0.94, needsReview: false },
      description: { value: 'Services', confidenceEstimate: 0.91, needsReview: false },
      currency: { value: 'INR', confidenceEstimate: 0.99, needsReview: false },
      subtotal: { value: 1000, confidenceEstimate: 0.95, needsReview: false },
      taxAmount: { value: 180, confidenceEstimate: 0.92, needsReview: false },
      totalAmount: { value: 1180, confidenceEstimate: 0.98, needsReview: false },
    },
    warnings: [],
    interpretationNotes: [],
  };
}

function createClient(options: {
  readonly existing?: boolean;
  readonly rpcError?: boolean;
} = {}) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    limit: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.limit.mockResolvedValue({
    data: options.existing ? [{ field_name: 'invoiceNumber' }] : [],
    error: null,
  });
  const rpc = vi.fn().mockResolvedValue({
    data: null,
    error: options.rpcError ? { message: 'internal details' } : null,
  });
  const client = {
    from: vi.fn(() => query),
    rpc,
  } as unknown as SupabaseClient;
  return { client, query, rpc };
}

describe('InvoiceExtractionFeedbackForm', () => {
  afterEach(() => vi.clearAllMocks());

  it('saves all eight reviewer-confirmed values with the extraction run identity', async () => {
    const { client, rpc, query } = createClient();
    render(
      <InvoiceExtractionFeedbackForm
        client={client}
        workspaceId={workspaceId}
        taskId={taskId}
        executionId={executionId}
        fileId={fileId}
        output={makeOutput()}
      />,
    );

    const invoiceNumber = await screen.findByRole('textbox', { name: 'Invoice number' });
    expect(invoiceNumber).toHaveValue('INV-1');
    expect(screen.getByText(/Model estimate: 0.72/)).toBeInTheDocument();
    fireEvent.change(invoiceNumber, { target: { value: 'INV-1-CORRECTED' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save field review' }));

    expect(await screen.findByText(/Field review saved/)).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('record_invoice_extraction_feedback', expect.objectContaining({
      p_task_id: taskId,
      p_execution_id: executionId,
      p_file_id: fileId,
      p_reviewed_values: {
        invoiceNumber: 'INV-1-CORRECTED',
        invoiceDate: '2026-10-22',
        vendor: 'Acme Ltd',
        description: 'Services',
        currency: 'INR',
        subtotal: 1000,
        taxAmount: 180,
        totalAmount: 1180,
      },
    }));
    expect(query.select).toHaveBeenCalledWith('field_name');
  });

  it('disables changes and duplicate saves when a prior review exists', async () => {
    const { client, rpc } = createClient({ existing: true });
    render(
      <InvoiceExtractionFeedbackForm
        client={client}
        workspaceId={workspaceId}
        taskId={taskId}
        executionId={executionId}
        fileId={fileId}
        output={makeOutput()}
      />,
    );

    expect(await screen.findByText(/This extraction run has already been reviewed/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Invoice number' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Review saved' })).toBeDisabled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('validates dates and currency codes before calling the RPC', async () => {
    const { client, rpc } = createClient();
    render(
      <InvoiceExtractionFeedbackForm
        client={client}
        workspaceId={workspaceId}
        taskId={taskId}
        executionId={executionId}
        fileId={fileId}
        output={makeOutput()}
      />,
    );

    fireEvent.change(await screen.findByLabelText('Invoice date'), {
      target: { value: '2026-02-31' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Save field review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid invoice date/);
    expect(rpc).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox', { name: 'Invoice date' }), {
      target: { value: '2026-10-22' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Currency' }), {
      target: { value: 'EURO' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save field review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/three-letter currency code/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('shows a generic save error without leaking server details', async () => {
    const { client } = createClient({ rpcError: true });
    render(
      <InvoiceExtractionFeedbackForm
        client={client}
        workspaceId={workspaceId}
        taskId={taskId}
        executionId={executionId}
        fileId={fileId}
        output={makeOutput()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Save field review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Unable to save this invoice review/);
    expect(screen.getByRole('alert')).not.toHaveTextContent('internal details');
  });
});
