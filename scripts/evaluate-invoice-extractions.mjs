#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIELD_NAMES = Object.freeze([
  'invoiceNumber',
  'invoiceDate',
  'vendor',
  'description',
  'currency',
  'subtotal',
  'taxAmount',
  'totalAmount',
]);

const STRING_FIELDS = new Set(['invoiceNumber', 'invoiceDate', 'vendor', 'description', 'currency']);
const MONEY_FIELDS = new Set(['subtotal', 'taxAmount', 'totalAmount']);
const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_RECORDS = 10000;
const MAX_TEXT_LENGTH = 1000;
const CONFIDENCE_BANDS = Object.freeze([
  { label: '<0.50', min: 0, max: 0.5 },
  { label: '0.50-0.69', min: 0.5, max: 0.7 },
  { label: '0.70-0.79', min: 0.7, max: 0.8 },
  { label: '0.80-0.89', min: 0.8, max: 0.9 },
  { label: '0.90-1.00', min: 0.9, max: 1.000000000001 },
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
}

function normalizeString(value) {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function valuesMatch(field, predicted, expected) {
  if (predicted === null || expected === null) return predicted === expected;

  if (MONEY_FIELDS.has(field)) {
    return Math.abs(predicted - expected) <= 0.01;
  }

  const left = normalizeString(predicted);
  const right = normalizeString(expected);
  if (field === 'vendor' || field === 'description') {
    return left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US');
  }
  if (field === 'currency') return left.toUpperCase() === right.toUpperCase();
  return left === right;
}

function validateScalar(field, value, label) {
  if (value === null) return;
  if (STRING_FIELDS.has(field)) {
    if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH || !value.trim()) {
      throw new Error(`${label} must be a non-empty string or null.`);
    }
    return;
  }
  if (MONEY_FIELDS.has(field)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) {
      throw new Error(`${label} must be a finite amount within the supported range or null.`);
    }
  }
}

function validateDataset(dataset) {
  if (!isRecord(dataset)) throw new Error('Input must be a JSON object.');
  if (dataset.schemaVersion !== 1) throw new Error('schemaVersion must equal 1.');
  assertText(dataset.datasetId, 'datasetId', 80);
  assertText(dataset.toolVersion, 'toolVersion', 40);
  assertText(dataset.modelId, 'modelId', 120);
  assertText(dataset.reviewProtocol, 'reviewProtocol', 300);

  if (!['synthetic-smoke', 'human-verified-holdout'].includes(dataset.datasetType)) {
    throw new Error('datasetType must be synthetic-smoke or human-verified-holdout.');
  }
  const isHumanHeldOut = dataset.datasetType === 'human-verified-holdout';
  if (dataset.split !== (isHumanHeldOut ? 'held_out' : 'smoke')) {
    throw new Error(isHumanHeldOut
      ? 'Human-verified evaluation data must use split=held_out.'
      : 'Synthetic smoke fixtures must use split=smoke.');
  }
  if (!Array.isArray(dataset.records) || dataset.records.length < 1 || dataset.records.length > MAX_RECORDS) {
    throw new Error(`records must contain between 1 and ${MAX_RECORDS} cases.`);
  }

  const seenIds = new Set();
  for (const [recordIndex, record] of dataset.records.entries()) {
    const label = `records[${recordIndex}]`;
    if (!isRecord(record)) throw new Error(`${label} must be an object.`);
    assertText(record.caseId, `${label}.caseId`, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(record.caseId)) {
      throw new Error(`${label}.caseId may contain only letters, digits, dot, underscore, and hyphen.`);
    }
    if (seenIds.has(record.caseId)) throw new Error(`Duplicate caseId: ${record.caseId}.`);
    seenIds.add(record.caseId);

    if (record.truthStatus !== (isHumanHeldOut ? 'human_verified' : 'synthetic')) {
      throw new Error(isHumanHeldOut
        ? `${label}.truthStatus must be human_verified for every held-out case.`
        : `${label}.truthStatus must be synthetic.`);
    }
    if (!isRecord(record.groundTruth) || !isRecord(record.prediction)) {
      throw new Error(`${label} must include groundTruth and prediction objects.`);
    }

    for (const field of FIELD_NAMES) {
      if (!Object.hasOwn(record.groundTruth, field)) throw new Error(`${label}.groundTruth is missing ${field}.`);
      validateScalar(field, record.groundTruth[field], `${label}.groundTruth.${field}`);
      const predictedField = record.prediction[field];
      if (!isRecord(predictedField) || !Object.hasOwn(predictedField, 'value')) {
        throw new Error(`${label}.prediction.${field} must include value and confidenceEstimate.`);
      }
      validateScalar(field, predictedField.value, `${label}.prediction.${field}.value`);
      if (typeof predictedField.confidenceEstimate !== 'number' ||
          !Number.isFinite(predictedField.confidenceEstimate) ||
          predictedField.confidenceEstimate < 0 ||
          predictedField.confidenceEstimate > 1) {
        throw new Error(`${label}.prediction.${field}.confidenceEstimate must be between 0 and 1.`);
      }
    }
  }
  return dataset;
}

function emptyFieldMetric() {
  return { samples: 0, correct: 0, incorrect: 0, abstentions: 0, unexpectedValues: 0 };
}

function addRateMetrics(metric) {
  return {
    ...metric,
    accuracy: metric.samples ? metric.correct / metric.samples : null,
    coverage: metric.samples ? (metric.samples - metric.abstentions) / metric.samples : null,
    accuracyWhenValueReturned: metric.samples - metric.abstentions
      ? metric.correct / (metric.samples - metric.abstentions)
      : null,
  };
}

function confidenceBand(value) {
  return CONFIDENCE_BANDS.find((band) => value >= band.min && value < band.max);
}

/**
 * Evaluates normalized model output against explicitly labeled values.
 * It never returns row-level values, source text, or document data.
 */
export function evaluateDataset(rawDataset) {
  const dataset = validateDataset(rawDataset);
  const fieldMetrics = Object.fromEntries(FIELD_NAMES.map((field) => [field, emptyFieldMetric()]));
  const confidenceBands = CONFIDENCE_BANDS.map((band) => ({
    band: band.label,
    samples: 0,
    correct: 0,
    confidenceTotal: 0,
  }));

  let correct = 0;
  let incorrect = 0;
  let abstentions = 0;
  let unexpectedValues = 0;

  for (const record of dataset.records) {
    for (const field of FIELD_NAMES) {
      const expected = record.groundTruth[field];
      const prediction = record.prediction[field];
      const actual = prediction.value;
      const isCorrect = valuesMatch(field, actual, expected);
      const metric = fieldMetrics[field];
      metric.samples += 1;
      if (isCorrect) {
        metric.correct += 1;
        correct += 1;
      } else {
        metric.incorrect += 1;
        incorrect += 1;
      }
      if (actual === null && expected !== null) {
        metric.abstentions += 1;
        abstentions += 1;
      }
      if (actual !== null && expected === null) {
        metric.unexpectedValues += 1;
        unexpectedValues += 1;
      }

      const band = confidenceBand(prediction.confidenceEstimate);
      if (band) {
        band.samples += 1;
        band.correct += Number(isCorrect);
        band.confidenceTotal += prediction.confidenceEstimate;
      }
    }
  }

  const totalFields = dataset.records.length * FIELD_NAMES.length;
  const humanVerified = dataset.datasetType === 'human-verified-holdout';
  const serializedBands = confidenceBands.map((band) => {
    const accuracy = band.samples ? band.correct / band.samples : null;
    const meanConfidence = band.samples ? band.confidenceTotal / band.samples : null;
    return {
      band: band.band,
      samples: band.samples,
      correct: band.correct,
      observedAccuracy: humanVerified ? accuracy : null,
      meanReportedConfidence: humanVerified ? meanConfidence : null,
      calibrationGap: humanVerified && accuracy !== null && meanConfidence !== null
        ? Math.abs(meanConfidence - accuracy)
        : null,
      smallSample: band.samples < 20,
    };
  });
  const expectedCalibrationError = humanVerified
    ? serializedBands.reduce((sum, band) => (
      band.samples && band.calibrationGap !== null
        ? sum + (band.samples / totalFields) * band.calibrationGap
        : sum
    ), 0)
    : null;

  return {
    dataset: {
      datasetId: dataset.datasetId,
      datasetType: dataset.datasetType,
      split: dataset.split,
      toolVersion: dataset.toolVersion,
      modelId: dataset.modelId,
      recordCount: dataset.records.length,
    },
    summary: {
      labeledFieldCount: totalFields,
      correct,
      incorrect,
      abstentions,
      unexpectedValues,
      accuracy: correct / totalFields,
      coverage: (totalFields - abstentions) / totalFields,
    },
    fields: Object.fromEntries(
      FIELD_NAMES.map((field) => [field, addRateMetrics(fieldMetrics[field])]),
    ),
    confidenceCalibration: humanVerified
      ? {
        expectedCalibrationError,
        bins: serializedBands,
        caveat: 'Descriptive estimate on this held-out labeled set; small bins are unstable and model-reported confidence is not guaranteed to be a probability.',
      }
      : null,
    interpretation: humanVerified
      ? [
        'Scores apply only to this held-out, human-verified dataset, tool version, and model identifier.',
        'Ground truth is treated as the reference; evaluator output does not establish universal model accuracy.',
        'The evaluator emits aggregates only and does not print field values, document content, or case-level errors.',
      ]
      : [
        'SYNTHETIC SMOKE TEST ONLY: these scores validate evaluator behavior and are not model performance or extraction accuracy.',
        'Use a distinct held-out dataset with independently human-verified field labels before reporting accuracy.',
        'The evaluator emits aggregates only and does not print field values, document content, or case-level errors.',
      ],
  };
}

export async function loadDatasetFile(inputPath) {
  const absolutePath = path.resolve(inputPath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile() || fileStat.size < 1 || fileStat.size > MAX_INPUT_BYTES) {
    throw new Error('Input must be a non-empty JSON file no larger than 5 MiB.');
  }
  const source = await readFile(absolutePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('Input is not valid JSON.');
  }
  return validateDataset(parsed);
}

function parseInputPath(args) {
  if (args.length === 0) {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/invoice-extraction/synthetic-smoke-v1.json');
  }
  if (args.length === 2 && args[0] === '--input') return args[1];
  throw new Error('Usage: npm run evaluate:invoices -- [--input <dataset.json>]');
}

async function main() {
  try {
    const inputPath = parseInputPath(process.argv.slice(2));
    const dataset = await loadDatasetFile(inputPath);
    process.stdout.write(`${JSON.stringify(evaluateDataset(dataset), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Invoice extraction evaluation failed: ${error instanceof Error ? error.message : 'Unknown error.'}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  await main();
}
