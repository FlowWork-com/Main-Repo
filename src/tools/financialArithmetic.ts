import {
  toolFailure,
  type JsonValue,
  type ToolDefinition,
} from './contracts.ts';

export const FINANCIAL_ARITHMETIC_TOOL_ID = 'financial-arithmetic';
export const FINANCIAL_ARITHMETIC_TOOL_VERSION = '1.0.0';

const MAX_AMOUNT = 1_000_000_000_000;
const AMOUNT_KEYS = [
  'netSales',
  'costOfGoodsSold',
  'reportedGrossProfit',
  'grossSales',
  'returns',
  'reportedNetSales',
  'grossProfit',
  'operatingExpenses',
  'reportedOperatingProfit',
  'taxableAmount',
  'taxRatePercent',
  'reportedTaxAmount',
  'subtotal',
  'taxAmount',
  'discount',
  'shipping',
  'reportedInvoiceTotal',
] as const;

type Calculation =
  | 'gross-profit'
  | 'net-sales'
  | 'operating-profit'
  | 'tax-amount'
  | 'invoice-total';

type AmountKey = typeof AMOUNT_KEYS[number];

interface FinancialArithmeticInput {
  readonly calculation: Calculation;
  readonly currency?: string;
  readonly reportingPeriod?: string;
  readonly netSales?: number;
  readonly costOfGoodsSold?: number;
  readonly reportedGrossProfit?: number;
  readonly grossSales?: number;
  readonly returns?: number;
  readonly reportedNetSales?: number;
  readonly grossProfit?: number;
  readonly operatingExpenses?: number;
  readonly reportedOperatingProfit?: number;
  readonly taxableAmount?: number;
  readonly taxRatePercent?: number;
  readonly reportedTaxAmount?: number;
  readonly subtotal?: number;
  readonly taxAmount?: number;
  readonly discount?: number;
  readonly shipping?: number;
  readonly reportedInvoiceTotal?: number;
}

interface CalculationDefinition {
  readonly formula: string;
  readonly resultLabel: string;
  readonly required: readonly AmountKey[];
  readonly reportedKey: AmountKey;
  readonly calculate: (input: FinancialArithmeticInput) => number;
}

const definitions: Readonly<Record<Calculation, CalculationDefinition>> = {
  'gross-profit': {
    formula: 'net sales − cost of goods sold',
    resultLabel: 'Gross profit',
    required: ['netSales', 'costOfGoodsSold'],
    reportedKey: 'reportedGrossProfit',
    calculate: (input) => input.netSales! - input.costOfGoodsSold!,
  },
  'net-sales': {
    formula: 'gross sales − returns and refunds',
    resultLabel: 'Net sales',
    required: ['grossSales', 'returns'],
    reportedKey: 'reportedNetSales',
    calculate: (input) => input.grossSales! - input.returns!,
  },
  'operating-profit': {
    formula: 'gross profit − operating expenses',
    resultLabel: 'Operating profit',
    required: ['grossProfit', 'operatingExpenses'],
    reportedKey: 'reportedOperatingProfit',
    calculate: (input) => input.grossProfit! - input.operatingExpenses!,
  },
  'tax-amount': {
    formula: 'taxable amount × tax rate ÷ 100',
    resultLabel: 'Tax amount',
    required: ['taxableAmount', 'taxRatePercent'],
    reportedKey: 'reportedTaxAmount',
    calculate: (input) => input.taxableAmount! * input.taxRatePercent! / 100,
  },
  'invoice-total': {
    formula: 'subtotal + tax − discount + shipping',
    resultLabel: 'Invoice total',
    required: ['subtotal', 'taxAmount'],
    reportedKey: 'reportedInvoiceTotal',
    calculate: (input) =>
      input.subtotal! + input.taxAmount! - (input.discount ?? 0) + (input.shipping ?? 0),
  },
};

const allowedKeys = new Set<string>([
  'calculation',
  'currency',
  'reportingPeriod',
  ...AMOUNT_KEYS,
]);

/**
 * Validate an explicit, structured arithmetic request. The tool deliberately
 * accepts numbers rather than parsing model-written prose.
 */
export function isFinancialArithmeticInput(value: unknown): value is FinancialArithmeticInput {
  if (!isPlainObject(value) ||
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    typeof value.calculation !== 'string' ||
    !Object.prototype.hasOwnProperty.call(definitions, value.calculation)) {
    return false;
  }

  const calculation = value.calculation as Calculation;
  const definition = definitions[calculation];
  if (!definition.required.every((key) => isValidAmount(value[key], key === 'taxRatePercent'))) {
    return false;
  }

  for (const key of AMOUNT_KEYS) {
    if (key in value && !isValidAmount(value[key], key === 'taxRatePercent')) return false;
  }

  if (value.currency !== undefined &&
    (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency))) {
    return false;
  }
  if (value.reportingPeriod !== undefined &&
    (typeof value.reportingPeriod !== 'string' ||
      !value.reportingPeriod.trim() ||
      value.reportingPeriod.length > 40 ||
      hasControlCharacters(value.reportingPeriod))) {
    return false;
  }

  return true;
}

export function calculateFinancialArithmetic(input: FinancialArithmeticInput): {
  readonly calculation: Calculation;
  readonly label: string;
  readonly formula: string;
  readonly status: 'calculated' | 'consistent' | 'mismatch_detected';
  readonly calculatedAmount: number;
  readonly reportedAmount: number | null;
  readonly difference: number | null;
  readonly differenceDirection: 'overstated' | 'understated' | null;
  readonly currency: string | null;
  readonly reportingPeriod: string | null;
  readonly warnings: readonly string[];
} {
  const definition = definitions[input.calculation];
  const calculatedAmount = roundMoney(definition.calculate(input));
  const reportedValue = input[definition.reportedKey];
  const reportedAmount = typeof reportedValue === 'number' ? roundMoney(reportedValue) : null;
  const difference = reportedAmount === null
    ? null
    : roundMoney(reportedAmount - calculatedAmount);
  const mismatch = difference !== null && Math.abs(difference) > 0.01;

  const warnings: string[] = [
    'The tool calculates only from the supplied figures; it does not authenticate inputs or consult source documents.',
  ];
  if (!input.currency) {
    warnings.push('No currency code was supplied. Confirm all figures use the same currency and unit.');
  }
  if (!input.reportingPeriod) {
    warnings.push('No reporting period was supplied. Confirm the figures relate to the same reporting period.');
  }
  if (reportedAmount === null) {
    warnings.push('No reported result was supplied, so no discrepancy comparison was performed.');
  }

  return {
    calculation: input.calculation,
    label: definition.resultLabel,
    formula: definition.formula,
    status: reportedAmount === null
      ? 'calculated'
      : mismatch
        ? 'mismatch_detected'
        : 'consistent',
    calculatedAmount,
    reportedAmount,
    difference,
    differenceDirection: difference === null || Math.abs(difference) <= 0.01
      ? null
      : difference > 0
        ? 'overstated'
        : 'understated',
    currency: input.currency ?? null,
    reportingPeriod: input.reportingPeriod ?? null,
    warnings,
  };
}

export function createFinancialArithmeticTool(): ToolDefinition {
  return {
    id: FINANCIAL_ARITHMETIC_TOOL_ID,
    name: 'Financial arithmetic',
    description:
      'Calculate supported accounting formulas from explicit numeric inputs and compare an optional reported result. Supports gross profit, net sales, operating profit, tax amount, and invoice total. Deterministic and read-only: it does not consult source documents, authenticate supplied figures, provide financial advice, or authorize actions. Human review remains required.',
    version: FINANCIAL_ARITHMETIC_TOOL_VERSION,
    riskLevel: 'low',
    requiresApproval: false,
    inputSchema: {
      type: 'object',
      required: ['calculation'],
      additionalProperties: false,
      properties: {
        calculation: {
          type: 'string',
          enum: ['gross-profit', 'net-sales', 'operating-profit', 'tax-amount', 'invoice-total'],
        },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        reportingPeriod: { type: 'string', minLength: 1, maxLength: 40 },
        netSales: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
        costOfGoodsSold: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
        reportedGrossProfit: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
        grossSales: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
        returns: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
        reportedNetSales: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
        grossProfit: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
        operatingExpenses: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
        reportedOperatingProfit: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
        taxableAmount: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
        taxRatePercent: { type: 'number', minimum: 0, maximum: 100 },
        reportedTaxAmount: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
        subtotal: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
        taxAmount: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
        discount: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
        shipping: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
        reportedInvoiceTotal: { type: 'number', minimum: 0, maximum: MAX_AMOUNT },
      },
    },
    validateInput: isFinancialArithmeticInput,
    async execute(_context, input) {
      if (!isFinancialArithmeticInput(input)) {
        return toolFailure(
          'INVALID_TOOL_INPUT',
          'Provide a supported calculation and its required finite, non-negative numeric inputs.',
        );
      }

      const result = calculateFinancialArithmetic(input);
      const output: JsonValue = {
        ...result,
        warnings: [...result.warnings],
        sourceVerification: 'not_performed' as const,
        externalDataConsulted: false,
        requiresHumanReview: true,
        financialAdvice: false,
        executionApproval: false,
      };
      return {
        success: true,
        output,
        evidence: {
          type: 'deterministic-financial-arithmetic',
          reference: `financial-arithmetic://task/${_context.taskId}/execution/${_context.executionId}`,
          summary: `${result.label}: ${result.status}; human review required; source verification not performed.`,
        },
      };
    },
  };
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isValidAmount(value: unknown, isRate = false): value is number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= (isRate ? 100 : MAX_AMOUNT) &&
    Number.isSafeInteger(Math.round(value * 100));
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
