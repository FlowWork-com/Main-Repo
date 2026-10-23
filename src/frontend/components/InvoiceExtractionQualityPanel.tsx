import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

interface FeedbackSummaryRow {
  readonly workspace_id: string;
  readonly field_name: string;
  readonly tool_version: string;
  readonly reviewed_field_count: number;
  readonly corrected_field_count: number;
  readonly unchanged_field_count: number;
  readonly observed_correction_rate: number | null;
  readonly mean_confidence_when_corrected: number | null;
  readonly mean_confidence_when_unchanged: number | null;
  readonly reviewed_as_missing_count: number;
}

interface ConfidenceBandRow {
  readonly workspace_id: string;
  readonly field_name: string;
  readonly tool_version: string;
  readonly confidence_band: string;
  readonly confidence_band_order: number;
  readonly reviewed_field_count: number;
  readonly corrected_field_count: number;
  readonly unchanged_field_count: number;
  readonly observed_correction_rate: number | null;
  readonly mean_reported_confidence: number | null;
}

interface InvoiceExtractionQualityPanelProps {
  readonly client: SupabaseClient;
  readonly workspaceId: string;
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  invoiceNumber: 'Invoice number',
  invoiceDate: 'Invoice date',
  vendor: 'Vendor',
  description: 'Description',
  currency: 'Currency',
  subtotal: 'Subtotal',
  taxAmount: 'Tax amount',
  totalAmount: 'Grand total',
};

const LOW_SAMPLE_COUNT = 20;

export function InvoiceExtractionQualityPanel({
  client,
  workspaceId,
}: InvoiceExtractionQualityPanelProps) {
  const [summary, setSummary] = useState<FeedbackSummaryRow[]>([]);
  const [confidenceBands, setConfidenceBands] = useState<ConfidenceBandRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedField, setSelectedField] = useState('all');
  const [selectedVersion, setSelectedVersion] = useState('all');

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const [summaryResult, bandResult] = await Promise.all([
          client
            .from('invoice_extraction_feedback_summary')
            .select(
              'workspace_id, field_name, tool_version, reviewed_field_count, corrected_field_count, unchanged_field_count, observed_correction_rate, mean_confidence_when_corrected, mean_confidence_when_unchanged, reviewed_as_missing_count',
            )
            .eq('workspace_id', workspaceId)
            .order('field_name', { ascending: true })
            .order('tool_version', { ascending: true }),
          client
            .from('invoice_extraction_confidence_summary')
            .select(
              'workspace_id, field_name, tool_version, confidence_band, confidence_band_order, reviewed_field_count, corrected_field_count, unchanged_field_count, observed_correction_rate, mean_reported_confidence',
            )
            .eq('workspace_id', workspaceId)
            .order('field_name', { ascending: true })
            .order('tool_version', { ascending: true })
            .order('confidence_band_order', { ascending: true }),
        ]);
        if (!active) return;
        if (summaryResult.error || bandResult.error) {
          setError('Unable to load invoice review metrics. Check workspace access and retry.');
          setSummary([]);
          setConfidenceBands([]);
          return;
        }
        setSummary(Array.isArray(summaryResult.data)
          ? summaryResult.data as unknown as FeedbackSummaryRow[]
          : []);
        setConfidenceBands(Array.isArray(bandResult.data)
          ? bandResult.data as unknown as ConfidenceBandRow[]
          : []);
      } catch {
        if (active) {
          setError('Unable to load invoice review metrics. Check workspace access and retry.');
          setSummary([]);
          setConfidenceBands([]);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [client, workspaceId]);

  const totalReviewed = summary.reduce((total, row) => total + safeCount(row.reviewed_field_count), 0);
  const totalCorrected = summary.reduce((total, row) => total + safeCount(row.corrected_field_count), 0);
  const totalUnchanged = summary.reduce((total, row) => total + safeCount(row.unchanged_field_count), 0);
  const correctionRate = totalReviewed > 0 ? totalCorrected / totalReviewed : null;

  const fields = useMemo(
    () => [...new Set(summary.map((row) => row.field_name))].sort(),
    [summary],
  );
  const versions = useMemo(
    () => [...new Set(summary.map((row) => row.tool_version))].sort(),
    [summary],
  );
  const filteredBands = confidenceBands.filter((row) =>
    (selectedField === 'all' || row.field_name === selectedField) &&
    (selectedVersion === 'all' || row.tool_version === selectedVersion),
  );

  return (
    <section className="invoice-quality" aria-labelledby="invoice-quality-title">
      <header className="invoice-quality__intro">
        <div>
          <p className="eyebrow">Extraction feedback</p>
          <h2 id="invoice-quality-title">Invoice extraction quality</h2>
          <p>
            See which extracted fields reviewers change, split by parser version and the
            confidence estimate reported at extraction time.
          </p>
        </div>
        <button
          className="button button--secondary"
          disabled={loading}
          onClick={() => {
            setError('');
            setLoading(true);
            // Changing the workspace key triggers the same safe, RLS-scoped read path.
            setSelectedField('all');
            setSelectedVersion('all');
            void refreshMetrics(client, workspaceId).then((result) => {
              setSummary(result.summary);
              setConfidenceBands(result.bands);
            }).catch(() => {
              setError('Unable to refresh invoice review metrics. Check workspace access and retry.');
            }).finally(() => setLoading(false));
          }}
          type="button"
        >
          Refresh metrics
        </button>
      </header>

      <p className="invoice-quality__disclaimer">
        These are observed human-review outcomes, not independently verified extraction
        accuracy or calibrated probabilities. A reviewer can also miss an error. Low sample
        counts are shown rather than hidden.
      </p>

      {loading ? (
        <p role="status">Loading invoice review metrics…</p>
      ) : error ? (
        <p className="error-message" role="alert">{error}</p>
      ) : summary.length === 0 ? (
        <section className="panel empty-state">
          <h3>No reviewed extractions yet</h3>
          <p>
            Once a teammate reviews a saved PDF/image extraction, field-level correction
            metrics will appear here.
          </p>
        </section>
      ) : (
        <>
          <div className="invoice-quality__stats" aria-label="Workspace review totals">
            <article className="invoice-quality__stat">
              <span>Field reviews</span>
              <strong>{formatCount(totalReviewed)}</strong>
            </article>
            <article className="invoice-quality__stat">
              <span>Corrections recorded</span>
              <strong>{formatCount(totalCorrected)}</strong>
            </article>
            <article className="invoice-quality__stat">
              <span>Observed correction rate</span>
              <strong>{formatRate(correctionRate)}</strong>
            </article>
            <article className="invoice-quality__stat">
              <span>Unchanged fields accepted</span>
              <strong>{formatCount(totalUnchanged)}</strong>
            </article>
          </div>

          <section className="invoice-quality__section" aria-labelledby="invoice-quality-fields-title">
            <h3 id="invoice-quality-fields-title">Field review summary</h3>
            <p>Counts represent reviewed field values, not invoice documents.</p>
            <div className="invoice-quality__table-wrap">
              <table className="invoice-quality__table">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Parser version</th>
                    <th scope="col">Reviewed</th>
                    <th scope="col">Corrected</th>
                    <th scope="col">Observed correction rate</th>
                    <th scope="col">Mean confidence when corrected</th>
                    <th scope="col">Mean confidence when unchanged</th>
                    <th scope="col">Reviewed as missing</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((row) => {
                    const reviewed = safeCount(row.reviewed_field_count);
                    return (
                      <tr key={`${row.field_name}:${row.tool_version}`}>
                        <th scope="row">{fieldLabel(row.field_name)}</th>
                        <td>{row.tool_version}</td>
                        <td>
                          {formatCount(reviewed)}
                          {reviewed < LOW_SAMPLE_COUNT && (
                            <span className="invoice-quality__sample-note">Small sample</span>
                          )}
                        </td>
                        <td>{formatCount(row.corrected_field_count)}</td>
                        <td>{formatRate(safeRate(row.observed_correction_rate))}</td>
                        <td>{formatConfidence(row.mean_confidence_when_corrected)}</td>
                        <td>{formatConfidence(row.mean_confidence_when_unchanged)}</td>
                        <td>{formatCount(row.reviewed_as_missing_count)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="invoice-quality__section" aria-labelledby="invoice-quality-bands-title">
            <h3 id="invoice-quality-bands-title">Observed corrections by confidence band</h3>
            <p>
              This checks whether reviewers tend to correct fields in different reported-confidence
              ranges. It is a monitoring signal only—not a calibration score.
            </p>
            <div className="invoice-quality__filters">
              <label>
                Field
                <select
                  onChange={(event) => setSelectedField(event.target.value)}
                  value={selectedField}
                >
                  <option value="all">All fields</option>
                  {fields.map((field) => (
                    <option key={field} value={field}>{fieldLabel(field)}</option>
                  ))}
                </select>
              </label>
              <label>
                Parser version
                <select
                  onChange={(event) => setSelectedVersion(event.target.value)}
                  value={selectedVersion}
                >
                  <option value="all">All versions</option>
                  {versions.map((version) => (
                    <option key={version} value={version}>{version}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="invoice-quality__table-wrap">
              <table className="invoice-quality__table">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Parser version</th>
                    <th scope="col">Reported confidence</th>
                    <th scope="col">Reviewed</th>
                    <th scope="col">Corrected</th>
                    <th scope="col">Observed correction rate</th>
                    <th scope="col">Mean reported confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBands.length === 0 ? (
                    <tr>
                      <td colSpan={7}>No reviewed fields match these filters.</td>
                    </tr>
                  ) : filteredBands.map((row) => {
                    const reviewed = safeCount(row.reviewed_field_count);
                    return (
                      <tr key={`${row.field_name}:${row.tool_version}:${row.confidence_band_order}`}>
                        <th scope="row">{fieldLabel(row.field_name)}</th>
                        <td>{row.tool_version}</td>
                        <td>{row.confidence_band}</td>
                        <td>
                          {formatCount(reviewed)}
                          {reviewed < LOW_SAMPLE_COUNT && (
                            <span className="invoice-quality__sample-note">Small sample</span>
                          )}
                        </td>
                        <td>{formatCount(row.corrected_field_count)}</td>
                        <td>{formatRate(safeRate(row.observed_correction_rate))}</td>
                        <td>{formatConfidence(row.mean_reported_confidence)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </section>
  );
}

async function refreshMetrics(
  client: SupabaseClient,
  workspaceId: string,
): Promise<{ readonly summary: FeedbackSummaryRow[]; readonly bands: ConfidenceBandRow[] }> {
  const [summaryResult, bandResult] = await Promise.all([
    client
      .from('invoice_extraction_feedback_summary')
      .select(
        'workspace_id, field_name, tool_version, reviewed_field_count, corrected_field_count, unchanged_field_count, observed_correction_rate, mean_confidence_when_corrected, mean_confidence_when_unchanged, reviewed_as_missing_count',
      )
      .eq('workspace_id', workspaceId)
      .order('field_name', { ascending: true })
      .order('tool_version', { ascending: true }),
    client
      .from('invoice_extraction_confidence_summary')
      .select(
        'workspace_id, field_name, tool_version, confidence_band, confidence_band_order, reviewed_field_count, corrected_field_count, unchanged_field_count, observed_correction_rate, mean_reported_confidence',
      )
      .eq('workspace_id', workspaceId)
      .order('field_name', { ascending: true })
      .order('tool_version', { ascending: true })
      .order('confidence_band_order', { ascending: true }),
  ]);
  if (summaryResult.error || bandResult.error) throw new Error('Metrics read failed.');
  return {
    summary: Array.isArray(summaryResult.data) ? summaryResult.data as unknown as FeedbackSummaryRow[] : [],
    bands: Array.isArray(bandResult.data) ? bandResult.data as unknown as ConfidenceBandRow[] : [],
  };
}

function fieldLabel(value: string): string {
  return FIELD_LABELS[value] ?? value;
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function safeRate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function formatCount(value: unknown): string {
  return safeCount(value).toLocaleString();
}

function formatRate(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function formatConfidence(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value.toFixed(2)
    : '—';
}
