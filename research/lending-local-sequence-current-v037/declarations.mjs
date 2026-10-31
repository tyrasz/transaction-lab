// Input-only derivation: no target results, transport or filesystem access.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { replayHeaderSelection } from './selection.mjs';
import { validateLocalSequence } from '../../src/local-sequence.js';
import { validateStandardSequence } from '../../src/standard-simulation.js';

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
export function deriveCurrentDeclarations({ templateBytes, selection }) {
  const templates = readPinnedTemplates(templateBytes), selected = replayHeaderSelection(selection);
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
    schemaVersion: '1.0', kind: 'current_state_lending_sequence_declarations', denominator: { ...CURRENT_DENOMINATOR },
    selection: { sourceBinding: copy(selected.sourceBinding), blockHash: selected.header.hash,
      headerVerification: copy(selected.headerVerification), latestReceived: copy(selected.latestReceived), finished: copy(selected.finished) },
    historicalTemplates: { ...copy(HISTORICAL_TEMPLATES), headers: templates.map(t => copy(t.header)), retainedNotesAreHistorical: true },
    cases,
    scope: { unchangedSelectedCalls: true, oneSharedSelectedHeader: true, freshAtSelectionOnly: true,
      targetExecutionPerformedHere: false, externallyVerifiedSourceAndWireJoinsRequired: true,
      historicalResultsUsedAsInputs: false, representativeAccuracyClaimed: false },
  };
}
export function validateCurrentDeclarations({ declarations, templateBytes, selection }) {
  const expected = deriveCurrentDeclarations({ templateBytes, selection });
  assert.deepEqual(declarations, expected, 'Only the shared header and both block selectors may differ from immutable templates.');
  return expected;
}
