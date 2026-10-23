import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { analyzeTrace } from './analyze.js';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const fixtureDirectory = new URL('../fixtures/', import.meta.url);
export const defaultReportPath = resolve(projectDirectory, 'reports/latest-benchmark.json');

export async function loadBenchmarkFixtures() {
  const names = (await readdir(fixtureDirectory)).filter(name => name.endsWith('.json')).sort();
  const documents = await Promise.all(names.map(async name => JSON.parse(await readFile(new URL(name, fixtureDirectory), 'utf8'))));
  return {
    fixtures: documents.filter(document => document.input && document.expected),
    reference: documents.find(document => document.id === 'dynamic-observed-comparison') ?? null,
  };
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function transfersFor(analysis, direction, address) {
  const assets = direction === 'in' ? analysis.inAssets : analysis.outAssets;
  const field = direction === 'in' ? 'transferIn' : 'transferOut';
  return (assets ?? []).filter(item => item.asset?.address?.toLowerCase() === address.toLowerCase())
    .flatMap(item => item[field] ?? []);
}

function rawAmount(transfers) {
  if (!transfers.length) return null;
  try { return transfers.reduce((total, transfer) => total + BigInt(transfer.rawValue), 0n).toString(); }
  catch { return null; }
}

export function evaluateFixture(fixture, analysis) {
  const checks = [];
  const expected = fixture.expected;
  function check(name, actual, wanted, matched = equal(actual, wanted)) {
    checks.push({ name, passed: Boolean(matched), expected: wanted, actual: actual ?? null });
  }
  function checkFields(prefix, actual, wanted) {
    for (const [key, value] of Object.entries(wanted ?? {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) checkFields(`${prefix} ${key}`, actual?.[key], value);
      else check(`${prefix} ${key}`, actual?.[key], value);
    }
  }
  check('execution status', analysis.execution?.status, expected.executionStatus);
  check('security is explicitly not assessed', analysis.security?.status, 'not_assessed');
  if (expected.coverageStatus) check('coverage status', analysis.coverage?.status, expected.coverageStatus);
  if (expected.allowedCoverageStatuses) {
    check('unknown coverage is not promoted to supported', analysis.coverage?.status,
      expected.allowedCoverageStatuses, expected.allowedCoverageStatuses.includes(analysis.coverage?.status));
  }
  if (expected.gasUsed) check('observed gas used', analysis.execution?.gasUsed, expected.gasUsed);
  if (expected.movementCount !== undefined) check('committed movement count', analysis.movements?.length, expected.movementCount);
  if (expected.emptyAssets) {
    check('no incoming assets', analysis.inAssets?.length, 0);
    check('no outgoing assets', analysis.outAssets?.length, 0);
  }
  checkFields('protocol', analysis.protocol, expected.protocol);
  checkFields('revert', analysis.execution?.revert, expected.revert);
  for (const transfer of expected.assetTransfers ?? []) {
    const actual = transfersFor(analysis, transfer.direction, transfer.address);
    check(`${transfer.direction} ${transfer.address} exact raw amount`, rawAmount(actual), transfer.amountRaw);
    if (actual.length === 1) check(`${transfer.direction} ${transfer.address} exact decimal display`, actual[0].value, transfer.value);
    else check(`${transfer.direction} ${transfer.address} single transfer`, actual.length, 1);
  }
  for (const interest of expected.interestAccruals ?? []) {
    const actual = analysis.interestAccruals?.find(item => item.address?.toLowerCase() === interest.address);
    for (const [key, wanted] of Object.entries(interest)) check(`interest ${key}`, actual?.[key], wanted);
  }
  if (expected.warningIncludes) {
    const text = [...(analysis.warnings ?? []), ...(analysis.coverage?.reasons ?? [])].join(' ');
    check('coverage limitation is explained', text, expected.warningIncludes,
      text.toLowerCase().includes(expected.warningIncludes.toLowerCase()));
  }
  return checks;
}

function compareReference(cases, reference) {
  const observed = cases.find(item => item.id === 'hyperlend-observed-supply');
  if (!observed?.analysis || !reference) return { status: 'unavailable', aggregateVendorScore: null };
  const usdc = '0xb88339cb7199b77e23db6e890353e22632ba630f';
  const husdc = '0x744e4f26ee30213989216e1632d9be3547c4885b';
  const localOut = transfersFor(observed.analysis, 'out', usdc);
  const remoteOut = transfersFor(reference.response, 'out', usdc);
  const localIn = transfersFor(observed.analysis, 'in', husdc);
  const remoteIn = transfersFor(reference.response, 'in', husdc);
  return {
    status: 'limited_observational_comparison',
    aggregateVendorScore: null,
    sameBlock: false,
    reason: 'The two saved responses were captured at different times; neither exposes a shared recorded simulation block.',
    reference: { service: reference.provenance.service, recordedAt: reference.provenance.recordedAt, fixture: 'dynamic-observed-comparison.json' },
    principal: {
      localRaw: rawAmount(localOut), dynamicRaw: rawAmount(remoteOut),
      agreement: rawAmount(localOut) !== null && rawAmount(localOut) === rawAmount(remoteOut),
      localDecimalDisplay: localOut[0]?.value ?? null,
      dynamicDecimalDisplay: remoteOut[0]?.value ?? null,
    },
    receiptTokenMint: {
      localRaw: rawAmount(localIn), dynamicRaw: rawAmount(remoteIn),
      status: 'not_a_same_block_accuracy_test',
      reason: 'Accrued interest varies with state. A difference between these snapshots is not evidence that either simulation is inaccurate.',
    },
    security: {
      localStatus: observed.analysis.security?.status ?? 'unknown',
      dynamicReportedResult: reference.response.validation?.result ?? null,
      status: 'not_evaluated',
      reason: 'There is no security detector or labeled security corpus in this version.',
    },
  };
}

/** Runs offline, deterministic evidence checks. Never contacts an RPC or hosted service. */
export async function runBenchmarks({ writeReport = true, outputPath = defaultReportPath, analyzer = analyzeTrace, fixtures, reference } = {}) {
  if (!fixtures) ({ fixtures, reference } = await loadBenchmarkFixtures());
  const cases = [];
  for (const fixture of fixtures) {
    try {
      const analysis = await analyzer(structuredClone(fixture.input));
      const checks = evaluateFixture(fixture, analysis);
      cases.push({ id: fixture.id, label: fixture.label, kind: fixture.kind,
        provenance: fixture.provenance, status: checks.every(check => check.passed) ? 'passed' : 'failed', checks, analysis });
    } catch (error) {
      cases.push({ id: fixture.id, label: fixture.label, kind: fixture.kind, provenance: fixture.provenance,
        status: 'failed', checks: [{ name: 'analyzer completes', passed: false, expected: 'analysis result', actual: error?.message ?? String(error) }] });
    }
  }
  const passed = cases.filter(item => item.status === 'passed').length;
  const summary = { passed, failed: cases.length - passed, total: cases.length,
    observed: cases.filter(item => item.kind === 'observed_rpc_trace').length,
    synthetic: cases.filter(item => item.kind === 'synthetic_adversarial_fixture').length };
  const report = {
    status: summary.failed ? 'failed' : 'passed', generatedAt: new Date().toISOString(), summary, cases,
    comparison: compareReference(cases, reference),
    limitations: [
      'This small local corpus measures regression behavior only, not overall quality or superiority to Blockaid.',
      `${summary.observed} fixtures contain saved public RPC responses; ${summary.synthetic} are explicitly hand-constructed. The benchmark itself does not make new live RPC requests.`,
      'The observed Hyperlend trace was captured with latest and no block identity; its exact state cannot be reconstructed from this fixture.',
      'The historical CoreWriter trace covers EVM execution, not subsequent HyperCore processing, and was captured without trace logs.',
      'Transfer events are event-derived movements, not verified portfolio balance deltas. Accrued interest is identified separately where supported.',
      'The historical Hyperlend fixture separates the transferred deposit from the mint-event implied principal and checks a derived scaled-token rounding interval; it does not reconstruct an exact pre/post balance delta.',
      'Security detection, pricing quality, RPC availability and end-to-end live latency are not assessed by this offline benchmark.',
    ],
  };
  if (writeReport) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runBenchmarks();
    console.log(`Benchmark: ${report.summary.passed}/${report.summary.total} cases passed (${report.summary.observed} observed, ${report.summary.synthetic} synthetic).`);
    console.log('No overall Blockaid score. Report: reports/latest-benchmark.json');
    for (const item of report.cases.filter(item => item.status === 'failed')) {
      console.error(`${item.id}: ${item.checks.filter(check => !check.passed).map(check => check.name).join(', ')}`);
    }
    process.exitCode = report.summary.failed ? 1 : 0;
  } catch (error) {
    console.error(`Benchmark failed: ${error.message}`);
    process.exitCode = 1;
  }
}
