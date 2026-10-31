// Input-only derivation: no target results, transport or filesystem access.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { replayHeaderSelection } from './selection.mjs';
import { validateLocalSequence } from '../../src/local-sequence.js';
import { validateStandardSequence } from '../../src/standard-simulation.js';
import { FUNDED_PROFILE, deriveFundedTemplates } from './funded-profile.mjs';

const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const HISTORICAL_TEMPLATES = freeze({
  planSha256: '727d4a3fe8dfa7901323cf9f7b4d09518c232c448eabddfb7f7b81c113ce5cad',
  manifestSha256: '1a414e70a04610bb8e7b784f97ce2edb2773ef07e40205c7a8edb8d533ea85ea',
  files: [
    { path: 'research/lending-local-sequence-v037/capture/inputs/001.json', sha256: 'c50936237fed1d59740521b1928f2a4bef74e496ec308f5f65d02281164e3f5c' },
    { path: 'research/lending-local-sequence-v037/capture/inputs/002.json', sha256: '3b09b2898f5b5c7b1d9f758b793f5e6f3246ca0f241cc20b71cc89637171737c' },
  ],
});
export const CURRENT_DENOMINATOR = Object.freeze({ sequences: 2, originalPositions: 6, originalChannels: 30, queryPositions: 39, queryChannels: 117 });
export const TEMPLATE_PROFILES = Object.freeze(['original_fixed', FUNDED_PROFILE]);
export function validateTemplateProfile(profile) {
  assert(TEMPLATE_PROFILES.includes(profile), 'Unknown fixed template profile.');
  return profile;
}
const copy = value => JSON.parse(JSON.stringify(value));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function readPinnedTemplates(templateBytes) {
  assert(Array.isArray(templateBytes) && templateBytes.length === 2, 'Exactly two immutable templates are required.');
  return templateBytes.map((bytes, index) => {
    assert(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'Template must be exact byte data.');
    assert(bytes.byteLength <= 2 * 1024 * 1024, 'Template exceeds the input byte limit.');
    assert.equal(digest(bytes), HISTORICAL_TEMPLATES.files[index].sha256, 'Immutable template bytes differ.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  });
}
export function deriveTemplateProfile({ templateBytes, profile = 'original_fixed' }) {
  validateTemplateProfile(profile);
  const baseTemplates = readPinnedTemplates(templateBytes);
  const amended = profile === FUNDED_PROFILE ? deriveFundedTemplates(baseTemplates) : { profile, amendment: null, cases: copy(baseTemplates) };
  assert.equal(amended.profile, profile); assert.equal(amended.cases.length, 2);
  const templates = amended.cases;
  for (const input of templates) {
    validateLocalSequence(copy(input.localInput));
    validateStandardSequence(copy(input.providerInput));
  }
  const bytes = profile === 'original_fixed' ? templateBytes.map(b => Buffer.from(b))
    : templates.map(t => Buffer.from(JSON.stringify(t, null, 2) + '\n'));
  assert(bytes.every(b => b.length <= 2 * 1024 * 1024));
  return { profile, baseTemplates, templates, bytes, amendment: copy(amended.amendment) };
}
export function deriveCurrentDeclarations({ templateBytes, selection, profile = 'original_fixed' }) {
  const prepared = deriveTemplateProfile({ templateBytes, profile }), { templates, baseTemplates } = prepared, selected = replayHeaderSelection(selection);
  assert.equal(selected.status, 'selected', 'A completed, replay-validated selection is required.');
  const cases = templates.map(template => {
    const input = copy(template);
    input.header = copy(selected.header);
    input.localInput.block = selected.header.hash;
    input.providerInput.block = selected.header.hash;
    // These validators normalize only temporary copies: declaration bytes retain
    // the exact original call/query values and explicitly chosen new header.
    validateLocalSequence(copy(input.localInput));
    validateStandardSequence(copy(input.providerInput));
    return input;
  });
  return {
    schemaVersion: '1.0', kind: 'current_state_lending_sequence_declarations', profile, amendment: prepared.amendment, denominator: { ...CURRENT_DENOMINATOR },
    selection: { sourceBinding: copy(selected.sourceBinding), blockHash: selected.header.hash,
      headerVerification: copy(selected.headerVerification), latestReceived: copy(selected.latestReceived), finished: copy(selected.finished) },
    historicalTemplates: { ...copy(HISTORICAL_TEMPLATES), headers: baseTemplates.map(t => copy(t.header)), retainedNotesAreHistorical: true },
    preparedTemplates: prepared.bytes.map((bytes, index) => ({ path: `templates/${String(index + 1).padStart(3, '0')}.json`, sha256: digest(bytes), bytes: bytes.length, id: templates[index].id })),
    cases,
    scope: { unchangedSelectedCalls: true, oneSharedSelectedHeader: true, freshAtSelectionOnly: true,
      targetExecutionPerformedHere: false, externallyVerifiedSourceAndWireJoinsRequired: true,
      historicalResultsUsedAsExecutionState: false, priorObservationsInformedInputSelection: profile === FUNDED_PROFILE, representativeAccuracyClaimed: false },
  };
}
export function validateCurrentDeclarations({ declarations, templateBytes, selection, profile = 'original_fixed' }) {
  const expected = deriveCurrentDeclarations({ templateBytes, selection, profile });
  assert.deepEqual(declarations, expected, 'Only the shared header and both block selectors may differ from immutable templates.');
  return expected;
}
