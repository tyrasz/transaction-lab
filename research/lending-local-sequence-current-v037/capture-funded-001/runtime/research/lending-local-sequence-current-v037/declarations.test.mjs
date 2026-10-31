import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveCurrentDeclarations, validateCurrentDeclarations, deriveTemplateProfile, validateTemplateProfile, readPinnedTemplates, HISTORICAL_TEMPLATES, CURRENT_DENOMINATOR } from './declarations.mjs';
import { FUNDED_PROFILE } from './funded-profile.mjs';
import { createHeaderSelection } from './selection.mjs';

const root = new URL('../../', import.meta.url);
const bytes = HISTORICAL_TEMPLATES.files.map(row => readFileSync(new URL(row.path, root)));
const templates = readPinnedTemplates(bytes), header = templates[0].header;
function selection() {
  const start = { wallMs: Number(BigInt(header.timestamp)) * 1000 + 1000, monotonicMs: 0 };
  const state = createHeaderSelection({ sourceBinding: { intentPlanSha256: 'a'.repeat(64), sourceManifestSha256: 'b'.repeat(64), nodeSha256: 'c'.repeat(64) }, started: start });
  for (const result of ['0x1', header, header]) {
    const request = state.request(start), id = JSON.parse(request.requestText).id;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }));
    state.accept({ ...request, httpStatus: 200, responseBase64: body.toString('base64'), responseBytesObserved: body.length, complete: true, error: null }, start);
  }
  return state.finish(start);
}

test('two pinned input templates receive one shared header; every other input value remains exact', () => {
  const selected = selection(), result = deriveCurrentDeclarations({ templateBytes: bytes, selection: selected });
  assert.deepEqual(result.denominator, CURRENT_DENOMINATOR);
  assert.deepEqual(result.historicalTemplates.headers, templates.map(t => t.header));
  assert.equal(result.historicalTemplates.retainedNotesAreHistorical, true);
  assert.deepEqual(result.cases.map(c => c.localInput.queries.length), [5, 8]);
  for (let i = 0; i < 2; i++) {
    const restored = structuredClone(result.cases[i]);
    assert.deepEqual(restored.header, header);
    assert.equal(restored.localInput.block, header.hash);
    assert.equal(restored.providerInput.block, header.hash);
    restored.header = templates[i].header;
    restored.localInput.block = templates[i].localInput.block;
    restored.providerInput.block = templates[i].providerInput.block;
    assert.deepEqual(restored, templates[i]);
    assert.deepEqual(result.cases[i].amounts, templates[i].amounts);
  }
  assert.deepEqual(validateCurrentDeclarations({ declarations: result, templateBytes: bytes, selection: selected }), result);
  assert.deepEqual(templates, readPinnedTemplates(bytes), 'Derivation must not mutate historical inputs.');
});

test('template byte changes, ordering changes and additional templates are refused', () => {
  assert.throws(() => readPinnedTemplates([bytes[1], bytes[0]]), /bytes differ/);
  assert.throws(() => readPinnedTemplates([Buffer.concat([bytes[0], Buffer.from('\n')]), bytes[1]]), /bytes differ/);
  assert.throws(() => readPinnedTemplates([...bytes, bytes[0]]), /Exactly two/);
  assert.throws(() => readPinnedTemplates([bytes[0].toString(), bytes[1]]), /byte data/);
});

test('changes to any call, query, amount, context, selection or second-case header are refused', () => {
  const selected = selection(), original = deriveCurrentDeclarations({ templateBytes: bytes, selection: selected });
  for (const mutate of [
    d => { d.cases[0].localInput.calls[0].value = '1'; },
    d => { d.cases[0].providerInput.calls[0].data += '00'; },
    d => { d.cases[1].localInput.calls[1].gas = '5000001'; },
    d => { d.cases[1].localInput.calls[1].fees = { gasPrice: '0' }; },
    d => { d.cases[0].localInput.queries.reverse(); },
    d => { d.cases[0].amounts.depositRaw = '1'; },
    d => { d.cases[0].localInput.stateOverrides = {}; },
    d => { d.cases[1].header = templates[1].header; d.cases[1].localInput.block = templates[1].header.hash; d.cases[1].providerInput.block = templates[1].header.hash; },
    d => { d.cases[0].provenance.header.path = 'new-current-source'; },
    d => { d.cases.push(d.cases[0]); },
    d => { d.selection.sourceBinding.nodeSha256 = '0'.repeat(64); },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    assert.throws(() => validateCurrentDeclarations({ declarations: changed, templateBytes: bytes, selection: selected }));
  }
});

test('failed selection cannot produce target declarations or silently reuse historical headers', () => {
  const selected = selection(); selected.status = 'unavailable'; selected.header = null;
  assert.throws(() => deriveCurrentDeclarations({ templateBytes: bytes, selection: selected }));
  const start = { wallMs: 0, monotonicMs: 0 };
  const s = createHeaderSelection({ sourceBinding: { intentPlanSha256: 'a'.repeat(64), sourceManifestSha256: 'b'.repeat(64), nodeSha256: 'c'.repeat(64) }, started: start });
  const failed = s.fail('No selected header', start);
  assert.throws(() => deriveCurrentDeclarations({ templateBytes: bytes, selection: failed }), /completed/);
});

test('fixed profiles bind exact prepared bytes and cannot accept an arbitrary sender or amount profile', () => {
  const original = deriveTemplateProfile({ templateBytes: bytes });
  assert.equal(original.profile, 'original_fixed'); assert.equal(original.amendment, null);
  assert.deepEqual(original.bytes, bytes); assert.deepEqual(original.templates, templates);
  const funded = deriveTemplateProfile({ templateBytes: bytes, profile: FUNDED_PROFILE });
  assert.equal(funded.profile, FUNDED_PROFILE); assert(funded.amendment);
  assert.deepEqual(funded.baseTemplates, templates);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(funded.bytes[i], Buffer.from(JSON.stringify(funded.templates[i], null, 2) + '\n'));
    assert.notDeepEqual(funded.bytes[i], bytes[i]);
  }
  for (const profile of ['funded_1', 'latest', '', null, {}, ['original_fixed']]) {
    assert.throws(() => validateTemplateProfile(profile));
    assert.throws(() => deriveTemplateProfile({ templateBytes: bytes, profile }));
  }
});

test('funded profile is amended before selection; only header and block selectors change afterward', () => {
  const selected = selection(), prepared = deriveTemplateProfile({ templateBytes: bytes, profile: FUNDED_PROFILE });
  const result = deriveCurrentDeclarations({ templateBytes: bytes, selection: selected, profile: FUNDED_PROFILE });
  assert.equal(result.profile, FUNDED_PROFILE); assert.deepEqual(result.amendment, prepared.amendment);
  assert.equal(result.scope.priorObservationsInformedInputSelection, true);
  assert.equal(result.scope.historicalResultsUsedAsExecutionState, false);
  for (let i = 0; i < 2; i++) {
    const restored = structuredClone(result.cases[i]);
    assert.deepEqual(restored.header, selected.header);
    assert.equal(restored.localInput.block, selected.header.hash); assert.equal(restored.providerInput.block, selected.header.hash);
    restored.header = prepared.templates[i].header;
    restored.localInput.block = prepared.templates[i].localInput.block;
    restored.providerInput.block = prepared.templates[i].providerInput.block;
    assert.deepEqual(restored, prepared.templates[i]);
    assert.equal(result.preparedTemplates[i].id, prepared.templates[i].id);
    assert.equal(result.preparedTemplates[i].bytes, prepared.bytes[i].length);
  }
  assert.deepEqual(validateCurrentDeclarations({ declarations: result, templateBytes: bytes, selection: selected, profile: FUNDED_PROFILE }), result);
  assert.throws(() => validateCurrentDeclarations({ declarations: result, templateBytes: bytes, selection: selected }));
  for (const mutate of [
    d => { d.profile = 'original_fixed'; },
    d => { d.amendment = null; },
    d => { d.preparedTemplates[0].sha256 = '0'.repeat(64); },
    d => { d.cases[0].localInput.from = templates[0].localInput.from; },
    d => { d.cases[0].queryRoles = templates[0].queryRoles; },
    d => { d.cases[0].amounts.depositRaw = '1'; },
    d => { d.cases[1].providerInput.calls[0].data += '00'; },
  ]) {
    const changed = structuredClone(result); mutate(changed);
    assert.throws(() => validateCurrentDeclarations({ declarations: changed, templateBytes: bytes, selection: selected, profile: FUNDED_PROFILE }));
  }
});
