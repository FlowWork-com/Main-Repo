export type FinancialArithmeticStatus = 'consistent' | 'mismatch' | 'currency_mismatch';

export interface FinancialArithmeticOperand {
  readonly label: string;
  readonly amount: number;
  readonly currency: string | null;
}

export interface FinancialArithmeticCheck {
  readonly id: string;
  readonly label: string;
  readonly formula: string;
  readonly status: FinancialArithmeticStatus;
  readonly operands: readonly FinancialArithmeticOperand[];
  readonly expectedAmount: number | null;
  readonly reportedAmount: number;
  /** Positive means the reported amount is overstated; negative means understated. */
  readonly difference: number | null;
  readonly currency: string | null;
  readonly message: string;
}

export interface DeterministicFinancialChecks {
  readonly status: 'mismatch_detected' | 'no_mismatch_detected' | 'not_assessed';
  readonly calculations: readonly FinancialArithmeticCheck[];
  readonly reportingPeriodProvided: boolean;
  readonly contextWarnings: readonly string[];
}

type AmountKey =
  | 'netSales' | 'grossSales' | 'returns' | 'costOfGoodsSold'
  | 'grossProfit' | 'operatingExpenses' | 'operatingProfit'
  | 'subtotal' | 'tax' | 'discount' | 'shipping' | 'invoiceTotal';

interface ParsedAmount {
  readonly key: AmountKey;
  readonly label: string;
  readonly amount: number;
  readonly currency: string | null;
}

const amountPatterns: readonly {
  readonly key: AmountKey;
  readonly label: string;
  readonly pattern: RegExp;
}[] = [
  { key: 'netSales', label: 'net sales', pattern: /\bnet\s+sales\b/gi },
  { key: 'grossSales', label: 'gross sales', pattern: /\bgross\s+sales\b/gi },
  { key: 'returns', label: 'returns and refunds', pattern: /\b(?:sales\s+returns|returns\s+and\s+refunds|returns|refunds)\b/gi },
  { key: 'costOfGoodsSold', label: 'cost of goods sold', pattern: /\b(?:cost\s+of\s+goods\s+sold|cogs)\b/gi },
  { key: 'grossProfit', label: 'reported gross profit', pattern: /\breported\s+gross\s+profit\b/gi },
  { key: 'grossProfit', label: 'gross profit', pattern: /(?<!reported\s)\bgross\s+profit\b/gi },
  { key: 'operatingExpenses', label: 'operating expenses', pattern: /\boperating\s+expenses\b/gi },
  { key: 'operatingProfit', label: 'reported operating profit', pattern: /\breported\s+operating\s+profit\b/gi },
  { key: 'operatingProfit', label: 'operating profit', pattern: /(?<!reported\s)\boperating\s+profit\b/gi },
  { key: 'subtotal', label: 'subtotal', pattern: /\bsubtotal\b/gi },
  { key: 'tax', label: 'tax amount', pattern: /\b(?:tax\s+amount|tax)(?!\s+rate)\b/gi },
  { key: 'discount', label: 'discount', pattern: /\bdiscount\b/gi },
  { key: 'shipping', label: 'shipping or delivery', pattern: /\b(?:shipping|delivery\s+charge)\b/gi },
  { key: 'invoiceTotal', label: 'invoice total', pattern: /\b(?:invoice\s+total|grand\s+total|total\s+amount|amount\s+due|total\s+due)\b/gi },
];

const amountAfterLabel =
  /^\s*(?:(?:is|are|was|were|of|at|equals?|reported\s+as)\s+|[:=]\s*)?(INR|Rs\.?|rupees|₹|USD|US\$|EUR|€|GBP|£|JPY|¥|\$)?\s*([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)/i;

export function analyzeFinancialArithmetic(text: string): DeterministicFinancialChecks {
  const amounts = extractAmounts(text);
  const calculations: FinancialArithmeticCheck[] = [];
  const get = (key: AmountKey) => amounts.get(key);

  const netSales = get('netSales');
  const grossSales = get('grossSales');
  const returns = get('returns');
  const cogs = get('costOfGoodsSold');
  const grossProfit = get('grossProfit');
  const operatingExpenses = get('operatingExpenses');
  const operatingProfit = get('operatingProfit');
  const subtotal = get('subtotal');
  const tax = get('tax');
  const discount = get('discount');
  const shipping = get('shipping');
  const invoiceTotal = get('invoiceTotal');

  if (grossSales && returns && netSales) {
    calculations.push(compareAmounts({
      id: 'net-sales',
      label: 'Net sales',
      formula: 'gross sales − returns and refunds',
      operands: [grossSales, returns],
      expectedAmount: grossSales.amount - returns.amount,
      reported: netSales,
    }));
  }

  let calculatedGrossProfit: number | null = null;
  if (netSales && cogs) {
    calculatedGrossProfit = roundMoney(netSales.amount - cogs.amount);
    if (grossProfit) {
      calculations.push(compareAmounts({
        id: 'gross-profit',
        label: 'Gross profit',
        formula: 'net sales − cost of goods sold',
        operands: [netSales, cogs],
        expectedAmount: calculatedGrossProfit,
        reported: grossProfit,
      }));
    }
  }

  if (operatingExpenses && operatingProfit && (calculatedGrossProfit !== null || grossProfit)) {
    const calculated = calculatedGrossProfit ?? grossProfit!.amount;
    const grossProfitOperand: ParsedAmount = calculatedGrossProfit !== null
      ? {
          key: 'grossProfit',
          label: 'calculated gross profit',
          amount: calculatedGrossProfit,
          currency: netSales?.currency ?? cogs?.currency ?? grossProfit?.currency ?? null,
        }
      : grossProfit!;
    calculations.push(compareAmounts({
      id: 'operating-profit',
      label: 'Operating profit',
      formula: 'gross profit − operating expenses',
      operands: [grossProfitOperand, operatingExpenses],
      expectedAmount: calculated - operatingExpenses.amount,
      reported: operatingProfit,
    }));
  }

  const hasUnitemizedInvoiceCharges = /\b(?:other\s+charges|service\s+charge|handling\s+charge|freight|surcharge)\b/i.test(text);
  const taxAlreadyIncluded = /\b(?:tax[- ]inclusive|inclusive\s+of\s+tax|tax\s+included\s+in\s+(?:the\s+)?subtotal)\b/i.test(text);
  if (subtotal && tax && invoiceTotal && !hasUnitemizedInvoiceCharges && !taxAlreadyIncluded) {
    const operands: ParsedAmount[] = [subtotal, tax];
    let expected = subtotal.amount + tax.amount;
    if (discount) {
      operands.push(discount);
      expected -= discount.amount;
    }
    if (shipping) {
      operands.push(shipping);
      expected += shipping.amount;
    }
    calculations.push(compareAmounts({
      id: 'invoice-total',
      label: 'Invoice total',
      formula: 'subtotal + tax − discount + shipping/delivery (where supplied)',
      operands,
      expectedAmount: expected,
      reported: invoiceTotal,
    }));
  }

  const financialAmountsPresent = amounts.size > 0;
  const reportingPeriodProvided = hasReportingPeriod(text);
  const contextWarnings: string[] = [];
  if (financialAmountsPresent && !reportingPeriodProvided) {
    contextWarnings.push(
      'No reporting period or invoice date was identified. Confirm the relevant financial year, quarter, month, or document date before comparing records.',
    );
  }
  if (financialAmountsPresent && [...amounts.values()].every((amount) => amount.currency === null)) {
    contextWarnings.push(
      'No currency was explicitly identified. Arithmetic assumes the compared amounts use the same currency and unit.',
    );
  }

  if (financialAmountsPresent && [...amounts.values()].some((amount) => amount.currency === null) &&
    [...amounts.values()].some((amount) => amount.currency !== null)) {
    contextWarnings.push('Currency is missing from one or more labelled amounts. Confirm that all compared figures use the same currency and unit.');
  }
  if (hasUnitemizedInvoiceCharges) {
    contextWarnings.push('Invoice total was not checked because additional charges were mentioned but not individually identified.');
  }
  if (taxAlreadyIncluded) {
    contextWarnings.push('Invoice total was not checked because tax may already be included in the subtotal.');
  }
  const hasMismatch = calculations.some((calculation) =>
    calculation.status === 'mismatch' || calculation.status === 'currency_mismatch');
  return {
    status: calculations.length === 0
      ? 'not_assessed'
      : hasMismatch
        ? 'mismatch_detected'
        : 'no_mismatch_detected',
    calculations,
    reportingPeriodProvided,
    contextWarnings,
  };
}

function extractAmounts(text: string): Map<AmountKey, ParsedAmount> {
  const amounts = new Map<AmountKey, ParsedAmount>();
  for (const item of amountPatterns) {
    const pattern = new RegExp(item.pattern.source, item.pattern.flags);
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      const parsed = amountAfterLabel.exec(text.slice(index + match[0].length));
      if (!parsed) continue;
      const amount = Number(parsed[2].replaceAll(',', ''));
      if (!Number.isFinite(amount)) continue;
      const currency = normalizeCurrency(parsed[1]);
      const current = amounts.get(item.key);
      if (!current || item.label.startsWith('reported ')) {
        amounts.set(item.key, { key: item.key, label: item.label, amount, currency });
      }
      break;
    }
  }
  return amounts;
}

function compareAmounts(input: {
  readonly id: string;
  readonly label: string;
  readonly formula: string;
  readonly operands: readonly ParsedAmount[];
  readonly expectedAmount: number;
  readonly reported: ParsedAmount;
}): FinancialArithmeticCheck {
  const explicitCurrencies = new Set(
    [...input.operands, input.reported]
      .map((operand) => operand.currency)
      .filter((currency): currency is string => currency !== null),
  );
  const allAmountsHaveCurrency = [...input.operands, input.reported].every((operand) => operand.currency !== null);
  const currency = explicitCurrencies.size === 1 && allAmountsHaveCurrency ? [...explicitCurrencies][0] : null;
  const operands: FinancialArithmeticOperand[] = [
    ...input.operands,
    input.reported,
  ].map((operand) => ({
    label: operand.label,
    amount: operand.amount,
    currency: operand.currency,
  }));

  if (explicitCurrencies.size > 1) {
    const currencyList = [...explicitCurrencies].join(', ');
    return {
      id: input.id,
      label: input.label,
      formula: input.formula,
      status: 'currency_mismatch',
      operands,
      expectedAmount: null,
      reportedAmount: input.reported.amount,
      difference: null,
      currency: null,
      message: `${input.label} was not recalculated because its operands use different currencies (${currencyList}). Do not compare or add these amounts without an explicit conversion rate and date.`,
    };
  }

  const expectedAmount = roundMoney(input.expectedAmount);
  const reportedAmount = roundMoney(input.reported.amount);
  const difference = roundMoney(reportedAmount - expectedAmount);
  const status = Math.abs(difference) <= 0.01 ? 'consistent' : 'mismatch';
  const currencyPrefix = currency ? `${currency} ` : '';
  const currencyWarning = allAmountsHaveCurrency ? '' : ' Currency was not explicitly stated on every amount; confirm units match.';
  const formula = input.operands
    .map((operand) => `${operand.label}: ${currencyPrefix}${formatAmount(operand.amount)}`)
    .join('; ');
  const message = status === 'consistent'
    ? `${input.label} is arithmetically consistent. Formula: ${input.formula}. Inputs: ${formula}. Expected and reported amount: ${currencyPrefix}${formatAmount(reportedAmount)}.${currencyWarning}`
    : `${input.label} mismatch. Formula: ${input.formula}. Inputs: ${formula}. Correct amount: ${currencyPrefix}${formatAmount(expectedAmount)}; reported amount: ${currencyPrefix}${formatAmount(reportedAmount)} (${currencyPrefix}${formatAmount(Math.abs(difference))} ${difference > 0 ? 'overstated' : 'understated'}).${currencyWarning}`;

  return {
    id: input.id,
    label: input.label,
    formula: input.formula,
    status,
    operands,
    expectedAmount,
    reportedAmount,
    difference,
    currency,
    message,
  };
}

function normalizeCurrency(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.toUpperCase().replaceAll('.', '');
  if (normalized === '₹' || normalized === 'RS' || normalized === 'RUPEES') return 'INR';
  if (normalized === 'US$' || normalized === 'USD') return 'USD';
  if (normalized === '$') return 'USD_OR_OTHER';
  if (normalized === '€' || normalized === 'EUR') return 'EUR';
  if (normalized === '£' || normalized === 'GBP') return 'GBP';
  if (normalized === '¥' || normalized === 'JPY') return 'JPY_OR_CNY';
  return normalized;
}

function hasReportingPeriod(text: string): boolean {
  return /\b(?:FY\s*20\d{2}(?:[-/]\d{2,4})?|Q[1-4]\s*20\d{2}|(?:financial\s+)?(?:year|quarter|month)\s+ended|(?:for|during)\s+(?:the\s+)?(?:financial\s+)?(?:year|quarter|month)\s+(?:of\s+)?20\d{2}|20\d{2}[-/]\d{1,2}(?:[-/]\d{1,2})?)\b/i.test(text);
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatAmount(value: number): string {
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}
