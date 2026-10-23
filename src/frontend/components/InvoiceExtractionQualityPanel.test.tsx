import { fireEvent, render, screen, within } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { InvoiceExtractionQualityPanel } from './InvoiceExtractionQualityPanel';

const workspaceId = 'a2000000-0000-4000-8000-000000000001';

const summaryRows = [
  {
    workspace_id: workspaceId,
    field_name: 'invoiceNumber',
    tool_version: '1.0.0',
    reviewed_field_count: 4,
    corrected_field_count: 1,
    unchanged_field_count: 3,
    observed_correction_rate: 0.25,
    mean_confidence_when_corrected: 0.72,
    mean_confidence_when_unchanged: 0.91,
    reviewed_as_missing_count: 0,
  },
  {
    workspace_id: workspaceId,
    field_name: 'vendor',
    tool_version: '1.0.0',
    reviewed_field_count: 2,
    corrected_field_count: 1,
    unchanged_field_count: 1,
    observed_correction_rate: 0.5,
    mean_confidence_when_corrected: 0.64,
    mean_confidence_when_unchanged: 0.94,
    reviewed_as_missing_count: 0,
  },
];

const bandRows = [
  {
    workspace_id: workspaceId,
    field_name: 'invoiceNumber',
    tool_version: '1.0.0',
    confidence_band: '0.70–0.79',
    confidence_band_order: 3,
    reviewed_field_count: 2,
    corrected_field_count: 1,
    unchanged_field_count: 1,
    observed_correction_rate: 0.5,
    mean_reported_confidence: 0.74,
  },
  {
    workspace_id: workspaceId,
    field_name: 'vendor',
    tool_version: '1.0.0',
    confidence_band: '0.90–1.00',
    confidence_band_order: 5,
    reviewed_field_count: 1,
    corrected_field_count: 0,
    unchanged_field_count: 1,
    observed_correction_rate: 0,
    mean_reported_confidence: 0.94,
  },
];

function resultQuery(result: { data: unknown; error: unknown }) {
  const query: {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    order: ReturnType<typeof vi.fn>;
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => Promise<unknown>;
  } = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValue(query);
  return query;
}

function createClient(options: {
  readonly summary?: unknown[];
  readonly bands?: unknown[];
  readonly error?: boolean;
} = {}) {
  const summaryQuery = resultQuery({
    data: options.summary ?? summaryRows,
    error: options.error ? { message: 'private database detail' } : null,
  });
  const bandQuery = resultQuery({
    data: options.bands ?? bandRows,
    error: options.error ? { message: 'private database detail' } : null,
  });
  const from = vi.fn((table: string) => {
    if (table === 'invoice_extraction_feedback_summary') return summaryQuery;
    if (table === 'invoice_extraction_confidence_summary') return bandQuery;
    throw new Error('Unexpected table');
  });
  return {
    client: { from } as unknown as SupabaseClient,
    from,
    summaryQuery,
    bandQuery,
  };
}

describe('InvoiceExtractionQualityPanel', () => {
  it('shows workspace review totals, field metrics, and reported-confidence bands', async () => {
    const { client, from, summaryQuery, bandQuery } = createClient();
    render(<InvoiceExtractionQualityPanel client={client} workspaceId={workspaceId} />);

    expect(await screen.findByRole('heading', { name: 'Invoice extraction quality' })).toBeInTheDocument();
    expect(screen.getByText('6', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('2', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('33.3%', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader', { name: 'Observed correction rate' })).toHaveLength(2);
    expect(screen.getByText('Invoice number')).toBeInTheDocument();
    expect(screen.getByText('0.70–0.79')).toBeInTheDocument();
    expect(screen.getByText(/not independently verified extraction accuracy/i)).toBeInTheDocument();
    expect(from).toHaveBeenNthCalledWith(1, 'invoice_extraction_feedback_summary');
    expect(from).toHaveBeenNthCalledWith(2, 'invoice_extraction_confidence_summary');
    expect(summaryQuery.eq).toHaveBeenCalledWith('workspace_id', workspaceId);
    expect(bandQuery.eq).toHaveBeenCalledWith('workspace_id', workspaceId);
  });

  it('filters confidence bands by field and parser version', async () => {
    const { client } = createClient();
    render(<InvoiceExtractionQualityPanel client={client} workspaceId={workspaceId} />);

    const bandHeading = screen.getByRole('heading', { name: 'Observed corrections by confidence band' });
    const bandSection = bandHeading.closest('section');
    if (!bandSection) throw new Error('Confidence-band section not found.');
    const bandTable = within(bandSection).getByRole('table') as HTMLTableElement;
    await screen.findByText('0.70–0.79');
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: 'invoiceNumber' } });
    expect(within(bandTable).getByText('0.70–0.79')).toBeInTheDocument();
    expect(within(bandTable).queryByText('0.90–1.00')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Field'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Parser version'), { target: { value: 'missing-version' } });
    expect(within(bandTable).getByText('No reviewed fields match these filters.')).toBeInTheDocument();
  });

  it('explains when no extraction feedback has been collected yet', async () => {
    const { client } = createClient({ summary: [], bands: [] });
    render(<InvoiceExtractionQualityPanel client={client} workspaceId={workspaceId} />);
    expect(await screen.findByRole('heading', { name: 'No reviewed extractions yet' })).toBeInTheDocument();
  });

  it('shows a generic error rather than exposing database details', async () => {
    const { client } = createClient({ error: true });
    render(<InvoiceExtractionQualityPanel client={client} workspaceId={workspaceId} />);
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent(/Unable to load invoice review metrics/);
    expect(error).not.toHaveTextContent('private database detail');
  });
});
