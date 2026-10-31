import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateLocalSimulation } from '../../src/local-simulation.js';
import { compilePreviewQueries } from '../../engines/local-evm/preview-queries.js';
import { CHANNELS, CURRENT_DENOMINATOR, TEMPLATE_FILES, PROVENANCE_FILES, originalTemplateBytes,
  readTemplates, deriveTemplates, deriveDeclarations, validateDeclarations } from './declarations.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bytes = originalTemplateBytes(root), sources = readTemplates(bytes), header = sources[0].parentHeader;
const digest = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const selected = () => deriveDeclarations({ templateBytes: bytes, header });

test('exact two original byte files and provenance pins form a fixed ten-channel denominator', () => {
  assert.deepEqual(CURRENT_DENOMINATOR, { cases: 2, originalPositions: 2, originalChannels: 10, queriesCompared: 0 });
  assert.deepEqual(CHANNELS, ['executionStatus', 'returnData', 'committedLogs', 'gasAccounting', 'fullObservedStateChanges']);
  assert.deepEqual(TEMPLATE_FILES.map(row => row.originalCaseId), ['002', '015']);
  assert.deepEqual(TEMPLATE_FILES.map(row => row.sha256), [
    '66b4909067567609c99d0efb587eab287457d2322a1fabf0a16f2c7668c771a9',
    '91fc4f5e9617921b062a01d16166a877425bd06d265a5a061f25ef34073f2287',
  ]);
  for (const row of [...PROVENANCE_FILES, ...TEMPLATE_FILES]) {
    const raw = readFileSync(join(root, row.path));
    assert.equal(raw.length, row.bytes); assert.equal(digest(raw), row.sha256);
  }
  assert.deepEqual(originalTemplateBytes(new URL('../../', import.meta.url)), bytes);
  assert(Object.isFrozen(CURRENT_DENOMINATOR)); assert(Object.isFrozen(TEMPLATE_FILES[0]));
});

test('both original envelopes, transaction identities and distinct historical headers remain exact', () => {
  const prepared = deriveTemplates({ templateBytes: bytes }), result = selected();
  assert.equal(prepared.mode, 'historical_headers_preparation_only');
  assert.equal(result.mode, 'shared_selected_header');
  assert.deepEqual(result.denominator, CURRENT_DENOMINATOR);
  assert.deepEqual(result.cases.map(c => c.id), ['delegated-usdt-002', 'delegated-usdt-015']);
  assert.deepEqual(result.cases.map(c => c.transactionHash), [
    '0x31cac6ebe975a4ca6666adf9b107fdb291af2cbeecbcf838397034e60daa03b8',
    '0xcb13cd67f13e57c3cd944c4ede2d9368a7e48c3a6a4aae8179f730c3a2c40314',
  ]);
  assert.notEqual(sources[0].parentHeader.hash, sources[1].parentHeader.hash);
  for (let i = 0; i < 2; i++) {
    const c = result.cases[i];
    assert.deepEqual(c.request, sources[i].projection.request);
    assert.deepEqual(c.historicalProvenance.parentHeader, sources[i].parentHeader);
    assert.deepEqual(prepared.cases[i].header, sources[i].parentHeader);
    assert.deepEqual(c.header, header); assert.equal(c.localInput.block, header.hash);
    assert.equal(c.headerVerification.status, 'verified');
    assert.equal(c.headerVerification.stateRoot, header.stateRoot);
    assert.deepEqual(validateLocalSimulation(c.localInput), c.localInput);
    for (const key of ['authorizationList', 'blobVersionedHashes', 'fees', 'executionProfile', 'stateOverrides', 'allocation']) {
      assert.equal(Object.hasOwn(c.localInput, key), false);
    }
    const restored = clone(c); restored.header = prepared.cases[i].header;
    restored.headerVerification = prepared.cases[i].headerVerification;
    restored.localInput.block = prepared.cases[i].localInput.block;
    assert.deepEqual(restored, prepared.cases[i]);
  }
  assert.deepEqual(validateDeclarations({ declarations: result, templateBytes: bytes, header }), result);
  assert.deepEqual(readTemplates(bytes), sources, 'Derivation must not mutate retained raw inputs.');
});

test('balanceOf query order is sender then the exact original ABI recipient; no query adds a comparison channel', () => {
  const expected = [
    ['0x08bb7baf5d5621dace37db11d81e4516c6697493', '0xc24526704a5a88f2dac16b35af15bc37a0809c7b'],
    ['0x3068aaa8e7e07693cf3066dd15f174f7afc30c40', '0xfbea74cd7e84295846bdd47bf248c00418718280'],
  ];
  const expectedAmounts = [BigInt('0xe5004480').toString(), BigInt('0x05a995c0').toString()];
  for (const [i, c] of selected().cases.entries()) {
    assert.equal(c.request.data.slice(0, 10), '0xa9059cbb');
    assert.equal(BigInt('0x' + c.request.data.slice(74)).toString(), expectedAmounts[i]);
    const queries = compilePreviewQueries(c.localInput.queries, { chainId: 1 });
    assert.deepEqual(queries.map(q => q.identity.account), expected[i]);
    assert(queries.every(q => q.identity.kind === 'balanceOf' && q.identity.chainId === '1'
      && q.identity.token === '0xdac17f958d2ee523a2206206994597c13d831ec7'));
    assert.deepEqual(c.queryRoles.map(q => q.role), ['sender_usdt_balance', 'recipient_usdt_balance']);
    assert.deepEqual(c.queryRoles.map(q => q.account), expected[i]);
    assert(c.queryRoles.every(q => q.compared === false));
  }
  assert.equal(selected().denominator.queriesCompared, 0);
});

test('reordered, truncated, reserialized or coherently substituted templates are refused before derivation', () => {
  for (const candidate of [[bytes[1], bytes[0]], [bytes[0]], [...bytes, bytes[0]],
    [Buffer.concat([bytes[0], Buffer.from('\n')]), bytes[1]], [bytes[0].toString(), bytes[1]],
    [Buffer.from(JSON.stringify(sources[0])), bytes[1]]]) {
    assert.throws(() => readTemplates(candidate));
  }
  for (const mutate of [
    s => { s.projection.request.value = '1'; },
    s => { s.projection.request.data = s.projection.request.data.slice(0, -1) + '1'; },
    s => { s.projection.request.from = '0x' + '11'.repeat(20); },
    s => { s.projection.request.authorizationList = []; },
    s => { s.transactionHash = '0x' + '00'.repeat(32); s.projection.transactionHash = s.transactionHash; },
    s => { s.parentHeader = clone(sources[1].parentHeader); s.projection.parentHeader = clone(s.parentHeader); },
  ]) {
    const source = clone(sources[0]); mutate(source);
    const changed = [Buffer.from(JSON.stringify(source, null, 2) + '\n'), bytes[1]];
    assert.throws(() => deriveDeclarations({ templateBytes: changed, header }), /Immutable input/);
  }
});

test('invalid header hash, changed consensus fields and unsupported header properties are rejected', () => {
  for (const mutate of [
    h => { h.hash = '0x' + '00'.repeat(32); },
    h => { h.stateRoot = '0x' + '11'.repeat(32); },
    h => { h.gasLimit = '0x3938701'; },
    h => { h.expectedState = {}; },
    h => { h.chainId = 999; },
    h => { Object.defineProperty(h, 'hash', { enumerable: true, get() { throw new Error('getter must not run'); } }); },
  ]) {
    const changed = clone(header); mutate(changed);
    assert.throws(() => deriveDeclarations({ templateBytes: bytes, header: changed }));
  }
  for (const value of [null, undefined, {}, 'latest', header.hash]) {
    assert.throws(() => deriveDeclarations({ templateBytes: bytes, header: value }));
  }
});

test('exact rederivation rejects altered envelopes, API context, headers, identities, query order or denominator', () => {
  for (const mutate of [
    d => { d.cases[0].request.value = '1'; d.cases[0].localInput.value = '1'; },
    d => { d.cases[0].localInput.chainId = 11155111; },
    d => { d.cases[0].localInput.authorizationList = []; },
    d => { d.cases[0].localInput.queries.reverse(); },
    d => { d.cases[0].localInput.block = 'latest'; },
    d => { d.cases[0].header = clone(sources[1].parentHeader); d.cases[0].localInput.block = sources[1].parentHeader.hash; },
    d => { d.cases[0].historicalProvenance.parentHeader = clone(sources[1].parentHeader); },
    d => { d.cases[0].historicalProvenance.requestFile.sha256 = '0'.repeat(64); },
    d => { d.cases[0].id = 'replacement'; },
    d => { d.cases[0].queryRoles[0].compared = true; },
    d => { d.cases.reverse(); },
    d => { d.cases.pop(); },
    d => { d.denominator.originalChannels = 5; },
    d => { d.scope.historicalPacketRepaired = true; },
    d => { d.expectedState = {}; },
  ]) {
    const changed = selected(); mutate(changed);
    assert.throws(() => validateDeclarations({ declarations: changed, templateBytes: bytes, header }), /Declarations differ/);
  }
});

test('extra argument/list fields, sparse lists and accessors cannot smuggle result-derived inputs', () => {
  assert.throws(() => deriveDeclarations({ templateBytes: bytes, header, expectedState: {} }), /fields/);
  assert.throws(() => deriveTemplates({ templateBytes: bytes, header }), /fields/);
  assert.throws(() => validateDeclarations({ declarations: selected(), templateBytes: bytes, header, expectedResult: {} }), /fields/);
  const extra = [...bytes]; extra.result = {}; assert.throws(() => readTemplates(extra), /extra fields/);
  const sparse = new Array(2); sparse[0] = bytes[0]; assert.throws(() => readTemplates(sparse), /dense/);
  const getter = [...bytes]; Object.defineProperty(getter, '0', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.throws(() => readTemplates(getter), /accessors/);
  let accessed = false;
  assert.throws(() => deriveDeclarations({ get templateBytes() { accessed = true; return bytes; }, header }), /accessors/);
  assert.equal(accessed, false);
});

test('immutable source/provenance file changes and symlink substitutions are refused', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'delegated-declarations-'));
  try {
    for (const row of [...PROVENANCE_FILES, ...TEMPLATE_FILES]) {
      const target = join(temporary, row.path); mkdirSync(dirname(target), { recursive: true }); cpSync(join(root, row.path), target);
    }
    assert.deepEqual(originalTemplateBytes(temporary), bytes);
    for (const row of [...PROVENANCE_FILES, ...TEMPLATE_FILES]) {
      const target = join(temporary, row.path), original = readFileSync(target), changed = Buffer.from(original);
      changed[changed.length - 1] ^= 1; writeFileSync(target, changed);
      assert.throws(() => originalTemplateBytes(temporary), /Immutable input bytes differ/);
      writeFileSync(target, original);
    }
    const row = TEMPLATE_FILES[0], target = join(temporary, row.path);
    rmSync(target); symlinkSync(join(root, row.path), target);
    assert.throws(() => originalTemplateBytes(temporary), /file type or size/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('selected header integrity does not claim selection freshness, canonicality, historical repair or target execution', () => {
  const result = selected();
  for (const key of ['targetExecutionPerformedHere', 'currentStateProvidedHere', 'headerFreshnessVerifiedHere',
    'canonicalityVerifiedHere', 'consensusVerified', 'originalTransactionReplay', 'historicalResultsUsedAsExecutionState',
    'historicalPacketRepaired', 'representativeAccuracyClaimed', 'explicitLocalQueriesCompared']) assert.equal(result.scope[key], false);
  assert.equal(result.scope.priorObservationsInformedInputSelection, true);
  assert.equal(result.scope.fixedOriginalChannels, 10);
  // Another valid saved header is accepted only when explicitly supplied. No
  // latest selector, fallback, freshness clock or expected state is consulted.
  const changed = deriveDeclarations({ templateBytes: bytes, header: sources[1].parentHeader });
  assert(changed.cases.every(c => c.header.hash === sources[1].parentHeader.hash));
  assert.throws(() => validateDeclarations({ declarations: changed, templateBytes: bytes, header }), /Declarations differ/);
});
