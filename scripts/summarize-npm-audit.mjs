import { appendFile, readFile } from 'node:fs/promises';
import { error, log } from 'node:console';
import process from 'node:process';

const reportPath = process.argv[2];
const commandExitCode = Number(process.argv[3] ?? '0');

if (!reportPath) {
  error('Usage: node scripts/summarize-npm-audit.mjs <audit-json-path> [npm-audit-exit-code]');
  process.exitCode = 1;
} else {
  try {
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    if (report.error) {
      const code = typeof report.error.code === 'string'
        ? report.error.code.replace(/[^A-Z0-9_]/gi, '').slice(0, 40)
        : 'UNKNOWN';
      error(`[npm-audit] Registry audit did not return a vulnerability report (code: ${code}).`);
      process.exitCode = 1;
    } else {
      const vulnerabilities = report.vulnerabilities && typeof report.vulnerabilities === 'object'
        ? report.vulnerabilities
        : {};
      const entries = Object.entries(vulnerabilities);
      const counts = report.metadata?.vulnerabilities ?? {};
      const total = Number(counts.total ?? entries.length);
      const summary = [
        '| Severity | Count |',
        '| --- | ---: |',
        ...['critical', 'high', 'moderate', 'low', 'info'].map((severity) =>
          `| ${severity} | ${Number(counts[severity] ?? 0)} |`),
        `| **Total** | **${total}** |`,
      ];
      log(`[npm-audit] ${total} finding(s); npm audit exit code: ${commandExitCode}.`);
      log(summary.join('\n'));

      for (const [rawName, vulnerability] of entries.sort(([a], [b]) => a.localeCompare(b))) {
        const name = String(rawName).replace(/[\r\n]/g, ' ').slice(0, 120);
        const severity = String(vulnerability.severity ?? 'unknown').toUpperCase();
        const direct = vulnerability.isDirect === true ? 'direct' : 'transitive';
        const range = String(vulnerability.range ?? 'unknown').replace(/[\r\n]/g, ' ').slice(0, 160);
        const fixAvailable = vulnerability.fixAvailable;
        let fix = 'unknown';
        if (fixAvailable === true) {
          fix = 'available within the current dependency range';
        } else if (fixAvailable === false) {
          fix = 'no automatic fix available';
        } else if (fixAvailable && typeof fixAvailable === 'object') {
          const fixName = typeof fixAvailable.name === 'string' ? fixAvailable.name : name;
          const fixVersion = typeof fixAvailable.version === 'string' ? fixAvailable.version : 'unspecified';
          const major = fixAvailable.isSemVerMajor === true ? '; semver-major update required' : '';
          fix = `${fixName}@${fixVersion}${major}`;
        }
        log(`[npm-audit] ${name}: ${severity}; ${direct}; affected range: ${range}; fix: ${fix}`);

        const nodes = Array.isArray(vulnerability.nodes) ? vulnerability.nodes : [];
        for (const node of nodes.slice(0, 20)) {
          if (typeof node !== 'string') continue;
          log(`[npm-audit]   installed path: ${node.replace(/[\\r\\n]/g, ' ').slice(0, 240)}`);
        }

        const advisories = Array.isArray(vulnerability.via) ? vulnerability.via : [];
        for (const advisory of advisories) {
          if (!advisory || typeof advisory !== 'object') continue;
          const title = String(advisory.title ?? 'transitive dependency path')
            .replace(/[\r\n]/g, ' ').slice(0, 180);
          const url = typeof advisory.url === 'string' && /^https:\/\//.test(advisory.url)
            ? advisory.url.slice(0, 300)
            : '';
          log(`[npm-audit]   advisory: ${title}${url ? ` (${url})` : ''}`);
        }
      }

      if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, [
          '## npm dependency audit (report-only)',
          '',
          ...summary,
          '',
          'This report is non-blocking while findings are triaged. Do not apply broad or forced dependency updates without reviewing direct/transitive impact.',
          '',
        ].join('\n'));
      }
    }
  } catch {
    error('[npm-audit] Could not parse the npm audit JSON report; no raw report was emitted.');
    process.exitCode = 1;
  }
}
