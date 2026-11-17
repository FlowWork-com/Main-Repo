import { describe, expect, it } from 'vitest';
import { analyzeFinancialArithmetic } from './finnlpArithmetic';

describe('deterministic FinNLP financial arithmetic', () => {
  it('detects an overstated gross profit even when all amounts are labelled', () => {
    const result = analyzeFinancialArithmetic([
      'Net sales: INR 96,000',
      'Cost of goods sold: INR 58,000',
      'Reported gross profit: INR 42,000',
    ].join(String.fromCharCode(10)));

    expect(result.status).toBe('mismatch_detected');
    expect(result.calculations).toMatchObject([{
      id: 'gross-profit',
      status: 'mismatch',
      expectedAmount: 38_000,
      reportedAmount: 42_000,
      difference: 4_000,
      currency: 'INR',
    }]);
    expect(result.calculations[0].message).toContain('4,000 overstated');
  });

  it('accepts a correct gross-profit calculation and recognizes its reporting period', () => {
    const result = analyzeFinancialArithmetic([
      'Net sales are INR 96,000',
      'Cost of goods sold is INR 58,000',
      'Reported gross profit is INR 38,000',
      'FY 2025-26',
    ].join('; '));

    expect(result.status).toBe('no_mismatch_detected');
    expect(result.calculations[0]).toMatchObject({
      id: 'gross-profit',
      status: 'consistent',
      expectedAmount: 38_000,
      reportedAmount: 38_000,
    });
    expect(result.reportingPeriodProvided).toBe(true);
  });

  it('detects net-sales, gross-profit, and operating-profit differences', () => {
    const result = analyzeFinancialArithmetic([
      'Gross sales: INR 110,000',
      'Returns and refunds: INR 14,000',
      'Net sales: INR 96,000',
      'Cost of goods sold: INR 58,000',
      'Reported gross profit: INR 42,000',
      'Operating expenses: INR 20,000',
      'Reported operating profit: INR 22,000',
      'Quarter ended 2026-09-30',
    ].join(String.fromCharCode(10)));

    expect(result.calculations.map((item) => item.id)).toEqual([
      'net-sales',
      'gross-profit',
      'operating-profit',
    ]);
    expect(result.calculations).toMatchObject([
      { id: 'net-sales', expectedAmount: 96_000, reportedAmount: 96_000, status: 'consistent' },
      { id: 'gross-profit', expectedAmount: 38_000, reportedAmount: 42_000, status: 'mismatch' },
      { id: 'operating-profit', expectedAmount: 18_000, reportedAmount: 22_000, status: 'mismatch' },
    ]);
  });

  it('checks invoice totals including tax, discount, and shipping', () => {
    const result = analyzeFinancialArithmetic([
      'Subtotal: INR 1,000',
      'Tax amount: INR 180',
      'Discount: INR 20',
      'Shipping: INR 40',
      'Grand total: INR 1,200',
      'Invoice date: 2026-11-01',
    ].join(String.fromCharCode(10)));

    expect(result.calculations).toMatchObject([{
      id: 'invoice-total',
      status: 'consistent',
      expectedAmount: 1_200,
      reportedAmount: 1_200,
    }]);
  });

  it('refuses to calculate across explicitly different currencies', () => {
    const result = analyzeFinancialArithmetic([
      'Net sales: INR 96,000',
      'Cost of goods sold: USD 58,000',
      'Reported gross profit: INR 38,000',
    ].join(String.fromCharCode(10)));

    expect(result.status).toBe('mismatch_detected');
    expect(result.calculations[0]).toMatchObject({
      id: 'gross-profit',
      status: 'currency_mismatch',
      expectedAmount: null,
      difference: null,
    });
    expect(result.calculations[0].message).toContain('Do not compare or add');
  });

  it('does not derive operating profit from a cross-currency gross-profit calculation', () => {
    const result = analyzeFinancialArithmetic([
      'Net sales: INR 96,000',
      'Cost of goods sold: USD 58,000',
      'Operating expenses: INR 20,000',
      'Reported operating profit: INR 18,000',
    ].join(String.fromCharCode(10)));

    expect(result.calculations).toMatchObject([{
      id: 'gross-profit',
      status: 'currency_mismatch',
      expectedAmount: null,
      reportedAmount: null,
    }]);
    expect(result.calculations.some((item) => item.id === 'operating-profit')).toBe(false);
  });

  it('warns when financial amounts have no identifiable reporting period', () => {
    const result = analyzeFinancialArithmetic([
      'Net sales: INR 96,000',
      'Cost of goods sold: INR 58,000',
      'Reported gross profit: INR 38,000',
    ].join(String.fromCharCode(10)));

    expect(result.reportingPeriodProvided).toBe(false);
    expect(result.contextWarnings.join(' ')).toContain('No reporting period');
  });

  it('does not calculate an invoice total when tax inclusion or extra charges are ambiguous', () => {
    const inclusive = analyzeFinancialArithmetic([
      'Subtotal: INR 1,000',
      'Tax amount: INR 180',
      'Grand total: INR 1,180',
      'Tax inclusive invoice',
    ].join(String.fromCharCode(10)));
    expect(inclusive.calculations).toEqual([]);
    expect(inclusive.contextWarnings.join(' ')).toContain('tax may already be included');

    const extraCharges = analyzeFinancialArithmetic([
      'Subtotal: INR 1,000',
      'Tax amount: INR 180',
      'Other charges apply',
      'Grand total: INR 1,180',
    ].join(String.fromCharCode(10)));
    expect(extraCharges.calculations).toEqual([]);
    expect(extraCharges.contextWarnings.join(' ')).toContain('additional charges');
  });

  it('does not invent a calculation when required labelled operands are absent', () => {
    const result = analyzeFinancialArithmetic('The company reported good profitability and improved margins.');

    expect(result.status).toBe('not_assessed');
    expect(result.calculations).toEqual([]);
  });
});
