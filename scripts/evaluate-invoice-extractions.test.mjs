import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = join(process.cwd(), 'scripts/evaluate-invoice-extractions.mjs');
const fixturePath = join(process.cwd(), 'fixtures/invoice-extraction/synthetic-smoke-v1.json');
const temporaryDirectories = [];

function runEvaluator(dataset) {
  let inputPath;
  if (dataset !== undefined) {
    const directory = mkdtempSync(join(tmpdir(), 'flowwork-invoice-eval-'));
    temporaryDirectories.push(directory);
    inputPath = join(directory, 'dataset.json');
    writeFileSync(inputPath, JSON.stringify(dataset), 'utf8');
  }

  const args = inputPath ? [scriptPath, '--input', inputPath] : [scriptPath];
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 });
}

afterEach(() => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe('invoice extraction evaluation runner', () => {
  it('scores the synthetic smoke fixture but clearly disclaims performance claims', () => {
    const result = runEvaluator();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);

    expect(report.dataset).toMatchObject({ datasetType: 'synthetic-smoke', recordCount: 3 });
    expect(report.summary).toMatchObject({
      labeledFieldCount: 24,
      correct: 18,
      incorrect: 6,
      abstentions: 2,
      unexpectedValues: 2,
      accuracy: 0.75,
      coverage: 22 / 24,
    });
    expect(report.confidenceCalibration).toBeNull();
    expect(report.interpretation.join(' ')).toMatch(/not model performance/i);
    expect(result.stdout).not.toContain('Acme Ltd');
    expect(result.stdout).not.toContain('INV-220');
  });

  it('computes confidence-band calibration summaries only for held-out human-reviewed labels', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    fixture.datasetId = 'held-out-test-only';
    fixture.datasetType = 'human-verified-holdout';
    fixture.split = 'held_out';
    fixture.reviewProtocol = 'Test-only fixture for exercising held-out report generation.';
    fixture.records.forEach((record) => { record.truthStatus = 'human_verified'; });

    const result = runEvaluator(fixture);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.confidenceCalibration.expectedCalibrationError).toBeGreaterThanOrEqual(0);
    expect(report.confidenceCalibration.expectedCalibrationError).toBeLessThanOrEqual(1);
    expect(report.confidenceCalibration.bins.reduce((total, bin) => total + bin.samples, 0)).toBe(24);
    expect(report.confidenceCalibration.bins.every((bin) => bin.smallSample)).toBe(true);
  });

  it('rejects duplicate case IDs and malformed confidence without emitting a report', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    fixture.records[1].caseId = fixture.records[0].caseId;
    let result = runEvaluator(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Duplicate caseId/);
    expect(result.stdout).toBe('');

    const clean = JSON.parse(readFileSync(fixturePath, 'utf8'));
    clean.records[0].prediction.vendor.confidenceEstimate = 1.5;
    result = runEvaluator(clean);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/confidenceEstimate must be between 0 and 1/);
    expect(result.stdout).toBe('');
  });
});
