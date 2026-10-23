import { useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JsonValue } from '../../tools/contracts';

const FIELD_SPEC = [
  { key: 'invoiceNumber', label: 'Invoice number', type: 'text' },
  { key: 'invoiceDate', label: 'Invoice date', type: 'date' },
  { key: 'vendor', label: 'Vendor', type: 'text' },
  { key: 'description', label: 'Description', type: 'text' },
  { key: 'currency', label: 'Currency', type: 'text' },
  { key: 'subtotal', label: 'Subtotal', type: 'number' },
  { key: 'taxAmount', label: 'Tax amount', type: 'number' },
  { key: 'totalAmount', label: 'Grand total', type: 'number' },
] as const;

type FieldName = (typeof FIELD_SPEC)[number]['key'];
type ReviewValues = Record<FieldName, string>;

interface ExtractionField {
  readonly value: string | number | null;
  readonly confidenceEstimate: number;
}

interface InvoiceExtractionFeedbackFormProps {
  readonly client: SupabaseClient;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly fileId: string;
  readonly output: JsonValue;
}

export function InvoiceExtractionFeedbackForm({
  client,
  workspaceId,
  taskId,
  executionId,
  fileId,
  output,
}: InvoiceExtractionFeedbackFormProps) {
  const extractionFields = readExtractionFields(output);
  const [values, setValues] = useState<ReviewValues>(() => initialValues(extractionFields));
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || saved) return;

    const subtotal = normalizeAmount(values.subtotal);
    const taxAmount = normalizeAmount(values.taxAmount);
    const totalAmount = normalizeAmount(values.totalAmount);
    if (subtotal === INVALID_AMOUNT || taxAmount === INVALID_AMOUNT || totalAmount === INVALID_AMOUNT) {
      setError('Enter valid finite amounts within the supported range, or leave them blank.');
      return;
    }

    const reviewedValues: Record<FieldName, string | number | null> = {
      invoiceNumber: normalizeText(values.invoiceNumber),
      invoiceDate: normalizeText(values.invoiceDate),
      vendor: normalizeText(values.vendor),
      description: normalizeText(values.description),
      currency: normalizeText(values.currency)?.toUpperCase() ?? null,
      subtotal,
      taxAmount,
      totalAmount,
    };

    if (reviewedValues.invoiceDate !== null && !isValidDate(reviewedValues.invoiceDate)) {
      setError('Enter a valid invoice date or leave it blank to mark it missing.');
      return;
    }
    if (reviewedValues.currency !== null && !/^[A-Z]{3}$/.test(reviewedValues.currency)) {
      setError('Enter a three-letter currency code (for example, INR) or leave it blank.');
      return;
    }

    const id = submissionId ?? crypto.randomUUID();
    setSubmissionId(id);
    setBusy(true);
    setError('');
    try {
      const { error: saveError } = await client.rpc('record_invoice_extraction_feedback', {
        p_task_id: taskId,
        p_execution_id: executionId,
        p_file_id: fileId,
        p_submission_id: id,
        p_reviewed_values: reviewedValues,
      });
      if (saveError) {
        setError('Unable to save this invoice review. Check workspace access and retry.');
        return;
      }
      setSaved(true);
    } catch {
      // Keep the same submission ID after an ambiguous failure so retrying remains idempotent.
      setError('Unable to confirm that this invoice review was saved. Retry to safely check its outcome.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="invoice-feedback" aria-labelledby={`invoice-feedback-${executionId}`}>
      <h5 id={`invoice-feedback-${executionId}`}>Review extracted fields</h5>
      <p className="invoice-feedback__description">
        Verify each field against the original document. Leaving a field blank records it as missing;
        saving unchanged values records that you accepted the extraction.
      </p>
      <form className="form-stack" onSubmit={submit}>
        {FIELD_SPEC.map((field) => {
          const original = extractionFields[field.key];
          const inputId = `invoice-feedback-${executionId}-${field.key}`;
          return (
            <fieldset className="invoice-feedback__field" key={field.key}>
              <label htmlFor={inputId}>{field.label}</label>
              <p className="invoice-feedback__source">
                Extracted: <strong>{formatValue(original.value)}</strong>
                {' · '}Model estimate: {original.confidenceEstimate.toFixed(2)}
              </p>
              <input
                autoComplete="off"
                disabled={busy || saved}
                id={inputId}
                inputMode={field.type === 'number' ? 'decimal' : undefined}
                maxLength={field.type === 'text' ? 500 : undefined}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  setValues((current) => ({ ...current, [field.key]: nextValue }));
                  setSubmissionId(null);
                  setSaved(false);
                  setError('');
                }}
                step={field.type === 'number' ? 'any' : undefined}
                type={field.type}
                value={values[field.key]}
              />
            </fieldset>
          );
        })}
        {error && <p className="error-message" role="alert">{error}</p>}
        {saved && (
          <p className="notice" role="status">
            Field review saved. This contributes to observed correction-rate metrics; it is not an independent accuracy certification.
          </p>
        )}
        <button className="button button--secondary" disabled={busy || saved} type="submit">
          {busy ? 'Saving review…' : saved ? 'Review saved' : 'Save field review'}
        </button>
      </form>
    </section>
  );
}

const INVALID_AMOUNT = Symbol('invalid amount');

function normalizeAmount(value: string): number | null | typeof INVALID_AMOUNT {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) && Math.abs(number) <= 1_000_000_000_000
    ? number
    : INVALID_AMOUNT;
}

function normalizeText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

function initialValues(fields: Record<FieldName, ExtractionField>): ReviewValues {
  return Object.fromEntries(
    FIELD_SPEC.map((field) => [field.key, fields[field.key].value === null ? '' : String(fields[field.key].value)]),
  ) as ReviewValues;
}

function readExtractionFields(output: JsonValue): Record<FieldName, ExtractionField> {
  if (!isRecord(output) || !isRecord(output.fields)) {
    throw new Error('Saved invoice extraction does not contain reviewable fields.');
  }
  const fields = {} as Record<FieldName, ExtractionField>;
  for (const spec of FIELD_SPEC) {
    const candidate = output.fields[spec.key];
    if (
      !isRecord(candidate) ||
      !(typeof candidate.value === 'string' || typeof candidate.value === 'number' || candidate.value === null) ||
      typeof candidate.confidenceEstimate !== 'number' ||
      !Number.isFinite(candidate.confidenceEstimate) ||
      candidate.confidenceEstimate < 0 ||
      candidate.confidenceEstimate > 1
    ) {
      throw new Error('Saved invoice extraction contains an invalid field.');
    }
    fields[spec.key] = {
      value: candidate.value,
      confidenceEstimate: candidate.confidenceEstimate,
    };
  }
  return fields;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function formatValue(value: string | number | null): string {
  if (value === null) return 'Missing';
  return String(value);
}

function isValidDate(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
