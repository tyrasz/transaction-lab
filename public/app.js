const $ = (id) => document.getElementById(id);
const state = { config: null, example: null, result: null, busy: false, benchmarkLoaded: false, sequenceDrafts: [], sequenceControls: [], nextCallKey: 1 };
const requestFieldIds = ['chain', 'ethereum-engine', 'ethereum-call-mode', 'from', 'to', 'data', 'value', 'block', 'standard-manual-queries', 'standard-queries', 'transaction-context'];
const ethereumMode = () => $('chain').value === '1';
const localMode = () => ethereumMode() && $('ethereum-engine').value === 'local';
const localAvailable = () => state.config?.localEvm?.available === true;
const sequenceMode = () => ethereumMode() && !localMode() && $('ethereum-call-mode').value === 'sequence';
const standardAvailable = () => state.config?.standardEvm?.available === true;
const sequenceAvailable = () => !localMode() && standardAvailable() && state.config?.standardEvm?.sequenceCapabilities?.available === true;
const manualQueries = () => ethereumMode() && !sequenceMode() && (localMode() || $('standard-manual-queries').checked);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function readableKey(key) { return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase()); }
function display(value) { return value === null || value === undefined ? 'Not available' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
function titleCase(value) { return String(value || 'unknown').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()); }
function numberLabel(value) { try { return BigInt(value).toLocaleString('en-US'); } catch { return display(value); } }
function formatTime(value) { if (value === null || value === undefined || value === '') return null; const date = new Date(typeof value === 'string' && !/^(?:\d+|0x[0-9a-f]+)$/i.test(value) ? value : Number(value) * 1000); return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().replace('T', ' ').replace('.000Z', ' UTC'); }

async function request(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), url === '/api/evm/simulate-sequence' ? 300000 : ['/api/evm/simulate', '/api/evm/local-preview'].includes(url) ? 180000 : 65000);
  try {
    const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error?.message || `Request failed with HTTP ${response.status}.`);
      error.code = result.error?.code;
      error.response = result;
      throw error;
    }
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The preview request took too long to respond. Try again in a moment.');
    throw error;
  } finally { clearTimeout(timer); }
}

function setBusy(busy, mode) {
  state.busy = busy;
  $('simulate-button').disabled = busy || (ethereumMode() && !(localMode() ? localAvailable() : standardAvailable())) || (sequenceMode() && !sequenceAvailable());
  $('replay-button').disabled = busy;
  $('example').disabled = busy;
  for (const id of requestFieldIds) $(id).disabled = busy;
  updateQueryMode();
  document.querySelector('.results-panel').setAttribute('aria-busy', String(busy));
  $('run-status').classList.toggle('loading', busy);
  $('run-status').textContent = busy ? sequenceMode() ? 'Evaluating the calls in order and checking the state after each step. This can take several minutes…' : mode === 'historical_trace' ? 'Retrieving the original execution trace and checking available historical balance evidence…' : ethereumMode() ? manualQueries() ? 'Running the unsigned call, checking the manual query list and measuring selected ETH accounts. This can take a few minutes…' : 'Running the unsigned call and measuring selected ETH accounts, token balances and allowances. This can take a few minutes…' : 'Pinning the block, executing the call, and decoding token events…' : '';
  if (busy && localMode()) $('run-status').textContent = 'Running the local engine with verified state inputs and your requested queries. This can take a few minutes…';
}

function clearResult({ inputsChanged = false } = {}) {
  state.result = null;
  $('result-content').hidden = true;
  $('empty-state').hidden = false;
  $('raw-json').textContent = '';
  $('raw-details').open = false;
  $('copy-json').disabled = true;
  $('download-json').disabled = true;
  $('copy-json').textContent = 'Copy JSON';
  $('result-label').textContent = inputsChanged ? 'Inputs changed' : 'Awaiting a transaction';
  $('run-status').textContent = inputsChanged ? 'Inputs changed. Run again to see a preview for these inputs.' : '';
  $('request-error').hidden = true;
}

function requestFingerprint() {
  return JSON.stringify({ fields: requestFieldIds.map(id => $(id).type === 'checkbox' ? $(id).checked : $(id).value), calls: sequenceMode() ? state.sequenceControls.map(row => ({ key: row.key, to: row.to.value, data: row.data.value, value: row.value.value, manual: row.manual.checked, queries: row.queries.value, context: row.context.value })) : null, exampleId: state.example?.id, transactionHash: state.example?.transactionHash });
}

function currentExamples() {
  return sequenceMode() ? state.config?.standardEvm?.sequenceExamples || [] : ethereumMode() ? state.config?.standardEvm?.examples || []
    : (state.config?.examples || []).filter(example => String(example.request?.chainId) === $('chain').value);
}

function populateExampleOptions() {
  const examples = currentExamples(), custom = node('option', '', 'Custom transaction');
  custom.value = '';
  $('example').replaceChildren(custom, ...examples.map(example => {
    const option = node('option', '', example.title || example.label || example.id); option.value = example.id; return option;
  }));
  $('example').value = examples[0]?.id || '';
}

function newSequenceDraft(call = {}) {
  return { key: state.nextCallKey++, to: call.to || '', data: call.data || '0x', value: call.value ?? '0', manual: false, queriesText: JSON.stringify(call.queries || [], null, 2), contextText: transactionContextText(call) };
}

function renderSequenceEditor() {
  state.sequenceControls = [];
  $('sequence-calls').replaceChildren(...state.sequenceDrafts.map((draft, index) => {
    const card = node('fieldset', 'sequence-call'), legend = node('legend', '', `Step ${index + 1}`);
    card.append(legend);
    const controls = { key: draft.key, card };
    function field(key, label, multiline = false) {
      const wrapper = node('div', 'field'), id = `sequence-${draft.key}-${key}`, caption = node('label', '', label);
      caption.htmlFor = id;
      const input = node(multiline ? 'textarea' : 'input', 'mono');
      input.id = id; input.value = draft[key] ?? ''; input.required = true; input.spellcheck = false;
      if (multiline) input.rows = 3; else input.type = 'text';
      if (key === 'value') { input.inputMode = 'numeric'; input.pattern = '0|[1-9][0-9]*'; }
      input.addEventListener('input', () => { draft[key] = input.value; input.setCustomValidity(''); clearResult({ inputsChanged: true }); });
      controls[key] = input; wrapper.append(caption, input); return wrapper;
    }
    card.append(field('to', 'Contract / recipient'), field('data', 'Calldata', true), field('value', 'Value · wei'));
    const advanced = node('details', 'query-settings'), summary = node('summary', '', 'Advanced: token & position checks');
    const choice = node('label', 'manual-query-choice'), manual = node('input');
    manual.type = 'checkbox'; manual.checked = draft.manual; manual.id = `sequence-${draft.key}-manual`;
    choice.htmlFor = manual.id; choice.append(manual, document.createTextNode('Use a manual query list'));
    const manualFields = node('div'), queryLabel = node('label', '', 'Query list · JSON'), queries = node('textarea', 'mono');
    queries.id = `sequence-${draft.key}-queries`; queries.rows = 5; queries.spellcheck = false; queries.value = draft.queriesText;
    queryLabel.htmlFor = queries.id; manual.setAttribute('aria-controls', `sequence-${draft.key}-manual-fields`); manualFields.id = `sequence-${draft.key}-manual-fields`;
    manualFields.append(node('p', 'field-help', 'One to eight token or position queries combined. ETH account checks stay automatic.'), queryLabel, queries, positionQueryHelp());
    advanced.append(summary, choice, manualFields); card.append(advanced);
    Object.assign(controls, { manual, manualFields, queries, advanced });
    manual.addEventListener('change', () => { draft.manual = manual.checked; queries.setCustomValidity(''); updateSequenceControls(); clearResult({ inputsChanged: true }); });
    queries.addEventListener('input', () => { draft.queriesText = queries.value; queries.setCustomValidity(''); clearResult({ inputsChanged: true }); });
    const contextSettings = node('details', 'query-settings transaction-context-settings'), contextLabel = node('label', '', 'Optional context · JSON'), context = node('textarea', 'mono');
    context.id = `sequence-${draft.key}-context`; context.rows = 4; context.spellcheck = false; context.value = draft.contextText;
    contextLabel.htmlFor = context.id; contextSettings.append(node('summary', '', 'Advanced: transaction context'), transactionContextHelp(), contextLabel, context);
    context.addEventListener('input', () => { draft.contextText = context.value; context.setCustomValidity(''); clearResult({ inputsChanged: true }); });
    Object.assign(controls, { context, contextSettings }); card.append(contextSettings);
    const actions = node('div', 'sequence-call-actions');
    for (const [action, label] of [['up', 'Move up'], ['down', 'Move down'], ['remove', 'Remove']]) {
      const button = node('button', 'text-button', label); button.type = 'button'; button.setAttribute('aria-label', `${label} step ${index + 1}`);
      controls[action] = button;
      button.addEventListener('click', () => {
        if (state.busy) return;
        if (action === 'remove') { if (state.sequenceDrafts.length <= 2) return; state.sequenceDrafts.splice(index, 1); }
        else {
          const next = index + (action === 'up' ? -1 : 1); if (next < 0 || next >= state.sequenceDrafts.length) return;
          [state.sequenceDrafts[index], state.sequenceDrafts[next]] = [state.sequenceDrafts[next], state.sequenceDrafts[index]];
        }
        renderSequenceEditor(); clearResult({ inputsChanged: true });
        (state.sequenceControls.find(row => row.key === draft.key) || state.sequenceControls[Math.min(index, state.sequenceControls.length - 1)])?.to.focus();
      });
      actions.append(button);
    }
    card.append(actions); state.sequenceControls.push(controls); return card;
  }));
  updateSequenceControls();
}

function updateSequenceControls() {
  const active = sequenceMode(), locked = state.busy || !active;
  for (const [index, row] of state.sequenceControls.entries()) {
    for (const key of ['to', 'data', 'value', 'manual', 'context']) row[key].disabled = locked;
    for (const key of ['to', 'data', 'value']) row[key].required = active;
    row.queries.disabled = locked || !row.manual.checked; row.queries.required = active && row.manual.checked;
    row.manualFields.hidden = !row.manual.checked;
    if (!row.manual.checked) row.queries.setCustomValidity('');
    row.up.disabled = locked || index === 0; row.down.disabled = locked || index === state.sequenceControls.length - 1;
    row.remove.disabled = locked || state.sequenceControls.length <= 2;
  }
  $('add-sequence-call').disabled = locked || state.sequenceControls.length >= 4;
  $('sequence-call-count').textContent = `${state.sequenceControls.length} of 4 calls · minimum 2. Each step has its own checks; position queries require an explicit manual entry.`;
}

function selectExample({ initial = false } = {}) {
  clearTransactionContexts();
  state.example = currentExamples().find((example) => example.id === $('example').value) || null;
  const example = state.example;
  if (example) {
    const transaction = (ethereumMode() ? example.input : example.request) || {};
    for (const field of sequenceMode() ? ['from'] : ['from', 'to', 'data', 'value']) $(field).value = transaction[field] ?? (field === 'data' ? '0x' : field === 'value' ? '0' : '');
    $('block').value = ethereumMode() ? transaction.block || 'latest' : 'latest';
    if (sequenceMode()) { state.sequenceDrafts = (transaction.calls || []).map(newSequenceDraft); renderSequenceEditor(); }
    else if (ethereumMode()) {
      $('standard-queries').value = JSON.stringify(transaction.queries || [], null, 2);
      $('transaction-context').value = transactionContextText(transaction);
    }
  }
  $('example-description').textContent = example?.description || (example ? 'Original public transaction inputs. Simulating uses the requested state block.' : 'Enter public transaction inputs to inspect an unsigned call.');
  $('replay-button').hidden = ethereumMode() || !example?.transactionHash;
  $('historical-help').hidden = ethereumMode() ? !example : !example?.transactionHash;
  $('historical-help').textContent = ethereumMode() && example
    ? sequenceMode() ? 'This example uses the selected block-end state, then applies each successful simulated call before evaluating the next. It is not a historical transaction-position replay.' : 'This example starts at the end of the block before the original deposit. It runs the same calldata against that state; it does not replay the original transaction at its exact position.'
    : example?.transactionHash ? `Historical inspection uses the original transaction ${example.transactionHash.slice(0, 12)}… and its original block, independent of the fields above.` : '';
  $('standard-queries').setCustomValidity('');
  $('value').setCustomValidity('');
  updateQueryMode();
  clearResult({ inputsChanged: !initial });
}

function updateQueryMode() {
  const standard = ethereumMode(), local = localMode(), sequence = sequenceMode(), manual = manualQueries();
  $('ethereum-engine-field').hidden = !standard;
  $('ethereum-engine').disabled = state.busy || !standard;
  $('local-engine-option').disabled = !localAvailable();
  $('local-engine-help').textContent = local ? 'Experimental local execution. Single call, manual queries only; no automatic asset or ETH summaries.' : localAvailable() ? 'Provider preview is the default. The independent local engine is available for explicit query checks.' : state.config?.localEvm?.reason || 'Independent local previews are unavailable in this workspace.';
  if (standard) {
    const available = local ? localAvailable() : standardAvailable();
    $('network-help').textContent = available ? local ? 'Experimental independent Ethereum preview. No connected wallet or signature needed.' : 'Experimental provider Ethereum preview. No connected wallet or signature needed.'
      : (local ? state.config?.localEvm?.reason : state.config?.standardEvm?.reason) || `The selected ${local ? 'local' : 'provider'} engine is unavailable in this workspace.`;
    $('network-help').classList.toggle('unavailable-note', !available);
    $('empty-description').textContent = local ? 'Enter a call and one to eight explicit queries. The local preview reports execution separately from measured raw query values.' : 'Choose an example or enter your own inputs. The preview shows which ETH balances, token balances and allowances could be measured for the selected accounts.';
  }
  $('ethereum-call-mode-field').hidden = !standard;
  $('ethereum-call-mode').disabled = state.busy || !standard || local;
  $('sequence-mode-option').disabled = !sequenceAvailable();
  $('sequence-availability').hidden = !standard || local || sequenceAvailable();
  $('sequence-availability').textContent = 'Ordered-call simulations are unavailable in this workspace.';
  $('single-call-target-fields').hidden = sequence; $('single-value-field').hidden = sequence;
  $('common-state-row').classList.toggle('sequence-state-row', sequence);
  $('value-help').hidden = sequence; $('sequence-editor').hidden = !sequence;
  $('simulate-label').textContent = local ? 'Run local preview' : sequence ? 'Simulate sequence' : 'Simulate';
  for (const id of ['to', 'data', 'value']) { $(id).disabled = state.busy || sequence; $(id).required = !sequence; if (sequence) $(id).setCustomValidity(''); }
  $('standard-query-settings').hidden = !standard || sequence;
  $('transaction-context-settings').hidden = !standard || sequence;
  $('transaction-context').disabled = state.busy || !standard || sequence;
  if (!standard || sequence) $('transaction-context').setCustomValidity('');
  $('standard-manual-fields').hidden = !manual;
  $('standard-queries').required = manual;
  $('standard-queries').disabled = state.busy || !manual;
  $('standard-manual-queries').disabled = state.busy || !standard || sequence || local;
  if (local) { $('standard-manual-queries').checked = true; $('standard-query-settings').open = true; }
  $('query-mode-help').textContent = local ? 'A manual list of one to eight token or position queries is required. There is no automatic token selection or ETH balance summary.' : 'Automatic token checks use observed events and calls. Choose a manual list for specific token or position checks instead. ETH account selection remains automatic.';
  $('standard-checks-help').hidden = !standard;
  $('standard-checks-help').textContent = sequence ? 'Each step checks up to eight observed ETH accounts and eight queries. Automatic queries cover tokens only; position checks require a manual entry. Before and after refer to that step, not the entire sequence.' : manual
    ? 'Your manual list controls token and position checks, up to eight combined. Up to eight observed ETH accounts are still selected automatically; network fees are excluded.'
    : 'Automatically check up to eight observed ETH accounts and eight token balance or allowance queries. Other changes may be missed; network fees are excluded.';
  if (!manual) $('standard-queries').setCustomValidity('');
  if (local) $('standard-checks-help').textContent = 'Checks only the listed accounts and contracts, in raw units. Network fees, contract identity and complete economic effects are not established.';
  updateSequenceControls();
}

function selectNetwork({ initial = false } = {}) {
  const standard = ethereumMode();
  $('ethereum-engine').value = 'provider';
  $('ethereum-call-mode').value = 'single';
  state.sequenceDrafts = [newSequenceDraft(), newSequenceDraft()]; renderSequenceEditor();
  populateExampleOptions();
  for (const id of ['from', 'to']) $(id).value = '';
  $('data').value = '0x';
  $('value').value = '0';
  $('block').value = 'latest';
  $('standard-queries').value = '[]';
  $('standard-manual-queries').checked = false;
  $('standard-query-settings').hidden = !standard;
  $('standard-query-settings').open = false;
  $('value').readOnly = false;
  $('value').pattern = standard ? '0|[1-9][0-9]*' : '[0-9]+';
  $('value-help').classList.toggle('sr-only', !standard);
  $('value-help').textContent = standard ? 'ETH sent with the call, in whole wei. 1 ETH = 1000000000000000000 wei. Use 0 for none; network fees are excluded.' : 'Native token amount as an integer number of wei.';
  $('block-help').textContent = standard
    ? 'Use latest, a hexadecimal block number, or a block hash. Execution starts at the end of that block with a fixed gas limit and no transaction fee settlement.'
    : 'Use latest or a hexadecimal block number. The result records the state used.';
  $('network-heading').textContent = standard ? 'ETHEREUM · CHAIN 1 · EXPERIMENTAL' : 'HYPEREVM · CHAIN 999';
  $('page-description').textContent = standard ? 'Preview an unsigned call and check the selected accounts’ balances and allowances.' : 'Simulate an unsigned call or inspect a historical execution. See the evidence behind each result.';
  $('empty-description').textContent = standard ? 'Choose an example or enter your own inputs. The preview shows which ETH balances, token balances and allowances could be measured for the selected accounts.' : 'Choose an example or enter a transaction. The preview separates execution, token events, and coverage limits.';
  $('network-help').hidden = !standard;
  $('network-help').textContent = standardAvailable() ? 'Experimental Ethereum previews. No connected wallet or signature needed.' : state.config?.standardEvm?.reason || 'Ethereum previews are unavailable in this workspace.';
  $('network-help').classList.toggle('unavailable-note', standard && !standardAvailable());
  selectExample({ initial });
  setBusy(false);
}

function positionQueryHelp() {
  const details = node('details', 'position-query-help');
  details.append(node('summary', '', 'Query formats'));
  details.append(node('p', 'field-help', 'Use one of these formats for each entry. Replace the placeholders with full addresses; marketId is a 32-byte hex value. The network comes from the form.'));
  details.append(node('pre', '', [
    '{"to":"<token address>","data":"<balanceOf or allowance calldata>"}',
    '{"kind":"aave_v3_user_account_data","contract":"<pool address>","user":"<account address>"}',
    '{"kind":"morpho_blue_position","contract":"<Morpho address>","user":"<account address>","marketId":"<0x + 64 hex digits>"}',
  ].join('\n\n')));
  details.append(node('p', 'field-help', 'Position results are raw contract values. A matching query format does not verify the contract’s identity.'));
  return details;
}

function readStandardQueries(text = $('standard-queries').value) {
  let queries;
  try { queries = JSON.parse(text); }
  catch { throw new Error('Enter a valid JSON query list in Advanced: token & position checks.'); }
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > 8) throw new Error('Add between one and eight token or position queries combined.');
  for (const query of queries) {
    const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
    if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('Each query must be a JSON object in one of the listed formats.');
    const keys = Object.keys(query).sort().join();
    if (query.kind === 'aave_v3_user_account_data' || query.kind === 'morpho_blue_position') {
      const morpho = query.kind === 'morpho_blue_position';
      if (keys !== (morpho ? 'contract,kind,marketId,user' : 'contract,kind,user') || !address(query.contract) || !address(query.user)
        || (morpho && (typeof query.marketId !== 'string' || !/^0x[0-9a-f]{64}$/i.test(query.marketId)))) {
        throw new Error('Position queries need only kind, contract and user, plus a full 32-byte marketId for Morpho. Extra fields are not accepted.');
      }
    } else if (keys !== 'data,to' || !address(query.to)
      || typeof query.data !== 'string' || !/^0x(?:70a082310{24}[0-9a-f]{40}|dd62ed3e0{24}[0-9a-f]{40}0{24}[0-9a-f]{40})$/i.test(query.data)) {
      throw new Error('Use a listed position kind, or a token query containing only to and complete balanceOf or allowance calldata in data.');
    }
  }
  return queries;
}

function transactionContextText(call) {
  const context = Object.fromEntries(['accessList', 'blobVersionedHashes'].filter(key => Object.hasOwn(call, key)).map(key => [key, call[key]]));
  return Object.keys(context).length ? JSON.stringify(context, null, 2) : '';
}

function transactionContextHelp() {
  const help = node('div', 'transaction-context-help');
  help.append(node('p', 'field-help', 'Leave blank for ordinary calls. Add accessList, blobVersionedHashes, or both. Order and duplicates are preserved; this applies only to this call, not its balance or position checks.'));
  help.append(node('pre', '', '{"accessList":[{"address":"<0x + 40 hex digits>","storageKeys":["<0x + 64 hex digits>"]}],"blobVersionedHashes":["<0x01 + 62 hex digits>"]}'));
  help.append(node('p', 'field-help', 'Unsigned blob simulation uses zero blob fee. Blob data and sidecar validity are not checked.'));
  return help;
}

// Early form feedback only; the backend independently enforces its own schema,
// fork and resource limits. JSON list order and duplicate entries stay intact.
function readTransactionContext(text) {
  if (!text.trim()) return {};
  let context;
  try { context = JSON.parse(text); } catch { throw new Error('Enter a valid JSON object in Advanced: transaction context, or leave it blank.'); }
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const hex = (value, digits) => typeof value === 'string' && new RegExp(`^0x[0-9a-f]{${digits}}$`, 'i').test(value);
  if (!record(context) || Object.keys(context).some(key => !['accessList', 'blobVersionedHashes'].includes(key))) throw new Error('Context accepts only accessList and blobVersionedHashes. Fee, signature and sidecar fields are not accepted.');
  if (Object.hasOwn(context, 'accessList')) {
    if (!Array.isArray(context.accessList) || context.accessList.length > 128) throw new Error('Use an accessList array with at most 128 entries.');
    let keys = 0;
    for (const entry of context.accessList) {
      if (!record(entry) || Object.keys(entry).sort().join() !== 'address,storageKeys' || !hex(entry.address, 40) || !Array.isArray(entry.storageKeys)
        || entry.storageKeys.some(key => !hex(key, 64))) throw new Error('Each access-list entry needs only a full address and a storageKeys array of full 32-byte hex keys.');
      keys += entry.storageKeys.length;
      if (keys > 1024) throw new Error('Use at most 1024 storage keys across the access list, counting duplicates.');
    }
  }
  if (Object.hasOwn(context, 'blobVersionedHashes') && (!Array.isArray(context.blobVersionedHashes) || context.blobVersionedHashes.length < 1 || context.blobVersionedHashes.length > 32
    || context.blobVersionedHashes.some(hash => !hex(hash, 64) || hash.slice(2, 4) !== '01'))) throw new Error('Use one to 32 full 32-byte blob versioned hashes, each beginning 0x01.');
  return context;
}

function clearTransactionContexts() {
  $('transaction-context').value = ''; $('transaction-context').setCustomValidity(''); $('transaction-context-settings').open = false;
  for (const draft of state.sequenceDrafts) draft.contextText = '';
  for (const row of state.sequenceControls) { row.context.value = ''; row.context.setCustomValidity(''); row.contextSettings.open = false; }
}

function validateWeiField(field) {
  const value = field.value;
  field.setCustomValidity(/^(?:0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < (1n << 256n)
    ? '' : 'Enter a whole, nonnegative decimal wei amount within uint256, without leading zeros, signs or decimal points.');
}

function readSequenceCalls() {
  if (state.sequenceControls.length < 2 || state.sequenceControls.length > 4) {
    $('request-error').hidden = false; $('request-error').textContent = 'Add between two and four calls.'; return null;
  }
  const calls = [];
  for (const row of state.sequenceControls) {
    validateWeiField(row.value);
    const call = { to: row.to.value.trim(), data: row.data.value.trim(), value: row.value.value };
    row.context.setCustomValidity('');
    try { Object.assign(call, readTransactionContext(row.context.value)); }
    catch (error) { row.contextSettings.open = true; row.context.setCustomValidity(error.message); row.context.reportValidity(); return null; }
    row.queries.setCustomValidity('');
    if (row.manual.checked) {
      try { call.queries = readStandardQueries(row.queries.value); }
      catch (error) { row.advanced.open = true; row.queries.setCustomValidity(error.message); row.queries.reportValidity(); return null; }
    }
    calls.push(call);
  }
  return calls;
}

function addDefinition(list, label, value) {
  if (value === undefined || value === null || value === '') return;
  list.append(node('dt', '', label), node('dd', '', display(value)));
}

function rawDirection(raw) {
  if (typeof raw !== 'string' || !/^-?[0-9]+$/.test(raw)) return 'unknown';
  try { const value = BigInt(raw); return value > 0n ? 'positive' : value < 0n ? 'negative' : 'neutral'; }
  catch { return 'unknown'; }
}

function exactAmount(value, raw, symbol = '') {
  if (value !== null && value !== undefined) return `${value}${symbol ? ` ${symbol}` : ''}`;
  return raw === null || raw === undefined ? 'Not available' : `${raw} raw units`;
}

function signedAmount(value, raw) {
  const label = exactAmount(value, raw);
  return rawDirection(raw) === 'positive' && !label.startsWith('+') ? `+${label}` : label;
}

function allowanceKindLabel(kind) {
  return kind === 'uint256_max' ? 'Maximum uint256 (commonly called unlimited)'
    : kind === 'zero' || kind === 'revoke' ? 'Zero allowance' : kind === 'bounded' ? 'Bounded amount' : 'Not available';
}

function measuredAllowance(changes, evidence) {
  if (changes?.status !== 'measured') return null;
  const token = evidence.asset?.address || evidence.token;
  const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && /^0x[0-9a-f]{40}$/i.test(a) && a.toLowerCase() === b.toLowerCase();
  return (changes.allowances || []).find(pair => sameAddress(pair.asset?.address, token) && sameAddress(pair.owner, evidence.owner) && sameAddress(pair.spender, evidence.spender)) || null;
}

function allowanceChangeLabel(pair) {
  if (pair.changed === false) return pair.afterKind === 'uint256_max' ? 'Maximum allowance unchanged'
    : pair.afterKind === 'zero' ? 'Final allowance unchanged at zero' : 'Allowance unchanged';
  if (pair.changed !== true) return 'Allowance change not established';
  if (pair.afterKind === 'zero') return 'Allowance reduced to zero';
  if (pair.beforeKind === 'zero') return pair.afterKind === 'uint256_max' ? 'New maximum allowance' : 'New bounded allowance';
  if (pair.afterKind === 'uint256_max') return 'Allowance increased to maximum';
  if (pair.beforeKind === 'uint256_max') return 'Maximum allowance replaced with a bounded amount';
  const direction = rawDirection(pair.deltaRaw);
  return direction === 'positive' ? 'Allowance increased' : direction === 'negative' ? 'Allowance reduced' : 'Allowance changed';
}

function renderAllowances(changes, permissions, historical = false) {
  const relevant = permissions?.observations?.length || permissions?.findings?.length;
  $('allowances-section').hidden = !changes || (changes.status === 'not_applicable' && !relevant);
  $('allowance-pairs').replaceChildren();
  $('allowance-warnings').replaceChildren();
  if (!changes) return;
  const measured = changes.status === 'measured';
  const historicalMeasured = measured && changes.basis === 'historical_transaction_position_allowance';
  $('allowances-section').classList.toggle('measured', measured);
  $('allowances-badge').textContent = historicalMeasured ? 'Original transaction position' : measured ? 'Before / after' : titleCase(changes.status);
  $('allowances-description').textContent = measured
    ? historicalMeasured ? 'Allowances read immediately before and after the original transaction, at its position in the original block. Measurements apply only to the token, owner, and spender pairs below. Spender trustworthiness is not assessed.' : 'Allowance values read before and after the entire simulated transaction. Measurements apply only to the token, owner, and spender pairs below. Spender trustworthiness is not assessed.'
    : changes.status === 'not_applicable'
      ? historical ? 'Historical allowance state is not measured. Approval requests and emitted events do not establish the final allowance; measured historical balances are separate evidence.' : 'Allowance measurement does not apply to this execution. Requests and emitted events do not establish final allowance state.'
      : 'Final allowances could not be measured. Missing measurements do not mean zero permission or a successful revocation.';
  for (const pair of measured && Array.isArray(changes.allowances) ? changes.allowances : []) {
    const card = node('div', 'permission-observation');
    const heading = node('div', 'permission-heading');
    heading.append(node('h4', '', allowanceChangeLabel(pair)), node('span', 'basis-badge', pair.asset?.symbol || 'Configured token'));
    card.append(heading);
    const details = node('dl', 'permission-details');
    addDefinition(details, 'Token', pair.asset?.address);
    addDefinition(details, 'Owner', pair.owner);
    addDefinition(details, 'Spender', pair.spender);
    addDefinition(details, 'Before', exactAmount(pair.before, pair.beforeRaw, pair.asset?.symbol));
    addDefinition(details, 'Before type', allowanceKindLabel(pair.beforeKind));
    addDefinition(details, 'After', exactAmount(pair.after, pair.afterRaw, pair.asset?.symbol));
    addDefinition(details, 'After type', allowanceKindLabel(pair.afterKind));
    addDefinition(details, 'Change', signedAmount(pair.delta, pair.deltaRaw));
    addDefinition(details, 'Before / after raw', `${display(pair.beforeRaw)} → ${display(pair.afterRaw)}`);
    addDefinition(details, 'Event comparison', pair.consistency?.eventComparison ? readableKey(pair.consistency.eventComparison) : null);
    addDefinition(details, 'Request comparison', pair.consistency?.requestComparison ? readableKey(pair.consistency.requestComparison) : null);
    if (historicalMeasured) {
      addDefinition(details, 'Original block', changes.executionIdentity?.blockNumber);
      addDefinition(details, 'Transaction / post-state index', `${display(changes.executionIdentity?.transactionIndex)} → ${display(changes.executionIdentity?.postTransactionIndex)}`);
    }
    card.append(details);
    if (pair.consistency?.explanation) card.append(node('p', 'measurement-note', pair.consistency.explanation));
    $('allowance-pairs').append(card);
  }
  if (measured && !$('allowance-pairs').children.length) $('allowance-pairs').append(node('p', 'section-help', 'No measured token, owner, and spender pairs were returned.'));
  const warnings = Array.isArray(changes.warnings) ? changes.warnings : [];
  $('allowance-limits').hidden = !warnings.length;
  $('allowance-warnings').replaceChildren(...warnings.map(warning => node('li', '', display(warning))));
}

function renderAssetList(id, assets, direction) {
  const container = $(id);
  container.replaceChildren();
  if (!Array.isArray(assets) || !assets.length) {
    container.append(node('div', 'asset-empty', `No ${direction === 'transferOut' ? 'outgoing' : 'incoming'} token events observed.`));
    return;
  }
  for (const entry of assets) {
    const asset = entry.asset || {};
    const transfers = Array.isArray(entry[direction]) ? entry[direction] : [];
    const card = node('div', 'asset-card');
    const nameRow = node('div', 'asset-name-row');
    const tokenName = node('div');
    tokenName.append(node('span', 'asset-symbol', asset.symbol || 'Unknown token'), node('span', 'asset-name', asset.name || 'Metadata unavailable'));
    nameRow.append(node('span', 'token-icon', (asset.symbol || '?').slice(0, 1)), tokenName);
    card.append(nameRow);
    if (!transfers.length) card.append(node('div', 'asset-unit', 'Amount unavailable'));
    for (const transfer of transfers) {
      const amount = transfer.value !== null && transfer.value !== undefined ? String(transfer.value) : `${transfer.rawValue || 'Unknown'} raw units`;
      card.append(node('div', 'asset-amount', amount), node('span', 'asset-unit', `${asset.symbol || 'Unknown token'} · ${transfer.basis === 'transfer_event' ? 'event-derived' : transfer.basis || 'basis unspecified'}`));
    }
    if (asset.address) card.append(node('div', 'asset-address', asset.address));
    container.append(card);
  }
}

function renderInterest(accruals, protocol) {
  const entries = Array.isArray(accruals) ? accruals : accruals ? [accruals] : [];
  $('interest-section').hidden = !entries.length;
  const deposit = protocol?.operation === 'supply';
  $('interest-heading').textContent = deposit ? 'Deposit & interest accounting' : 'Receipt-token interest accounting';
  $('interest-description').textContent = deposit
    ? 'Receipt-token mint events include recognized interest and can reflect scaled-token rounding. The deposit and event-implied amounts are shown separately.'
    : 'Receipt-token Mint events report recognized interest. The operation amount and implied position change are shown separately above.';
  const container = $('interest-details');
  container.replaceChildren();
  $('deposit-details').replaceChildren();
  if (protocol?.requestedDepositPrincipalRaw !== undefined) {
    const item = node('div', 'interest-item');
    const definitions = node('dl');
    addDefinition(definitions, 'Requested deposit', protocol.requestedDepositPrincipal);
    addDefinition(definitions, 'USDC transfer event', protocol.transferredDepositPrincipal);
    addDefinition(definitions, 'Mint-implied principal', protocol.mintEventImpliedPrincipal);
    addDefinition(definitions, 'Implied minus requested', protocol.roundingDifference === null ? null : `${protocol.roundingDifference} USDC (${protocol.roundingDifferenceRaw} raw units)`);
    addDefinition(definitions, 'Reconciliation', protocol.principalReconciliation?.status ? readableKey(protocol.principalReconciliation.status) : null);
    item.append(definitions);
    $('deposit-details').append(item);
  }
  for (const accrual of entries) {
    const item = node('div', 'interest-item');
    const definitions = node('dl');
    addDefinition(definitions, 'Mint-implied principal', accrual.mintEventImpliedPrincipal ?? accrual.principal);
    addDefinition(definitions, 'Accrued interest', accrual.balanceIncrease);
    addDefinition(definitions, 'Receipt-token Mint event amount', accrual.value);
    addDefinition(definitions, 'Beneficiary', accrual.onBehalfOf);
    addDefinition(definitions, 'Evidence', accrual.basis ? readableKey(accrual.basis) : null);
    if (!definitions.children.length) for (const [key, value] of Object.entries(accrual)) addDefinition(definitions, readableKey(key), value);
    item.append(definitions);
    container.append(item);
  }
}

function renderBalanceChanges(changes, source = {}, affectedBalances) {
  $('balances-section').hidden = !changes;
  $('balance-verification').hidden = true;
  $('balance-verification-details').replaceChildren();
  for (const id of ['balance-assets', 'balance-debts', 'balance-custody']) $(id).replaceChildren();
  $('balance-debts-group').hidden = true;
  $('balance-custody-group').hidden = true;
  $('balance-warnings').replaceChildren();
  if (!changes) return;
  const measured = changes.status === 'measured';
  const historical = source.mode === 'historical_trace';
  const originalPosition = changes.basis === 'historical_transaction_position_balanceOf';
  $('balances-section').classList.toggle('measured', measured);
  $('balances-heading').textContent = historical ? 'Historical balance measurements' : 'Measured balance changes';
  $('balances-badge').textContent = measured ? originalPosition ? 'Original transaction position' : 'Before / after' : titleCase(changes.status);
  $('balances-description').textContent = measured
    ? originalPosition
      ? 'Balances read immediately before and after the original transaction, at its position and timestamp in the original block. Original transfer logs are decoded separately below.'
      : historical
        ? 'Measured balances were returned, but this response does not identify an original-transaction-position measurement. Review the measurement basis and execution evidence.'
        : 'Token balances read before and after the simulated call, independently of its transfer events.'
    : changes.status === 'not_applicable'
      ? historical ? 'Historical balance measurement is not available for this execution. Original event evidence remains available below.' : 'Balance measurement does not apply to this execution mode. Event evidence remains available below.'
      : historical ? 'Balances at the original transaction position could not be measured. Missing measurements do not imply zero balance change.' : 'Before-and-after balances could not be measured. No zero balance change is inferred from missing data.';
  if (affectedBalances?.status === 'measured' && affectedBalances.assets?.length) {
    $('balances-heading').textContent = 'Protocol balance measurements';
    $('balances-description').textContent = measured
      ? $('balances-description').textContent + ' Additional measured balances appear under Observed accounts.'
      : 'The protocol-specific adapter has no measured result. Separately verified before-and-after balances appear under Observed accounts below.';
  }
  if (measured) {
    const identity = changes.executionIdentity || {};
    const context = $('balance-verification-details');
    if (originalPosition) {
      addDefinition(context, 'Original block', identity.blockNumber === null || identity.blockNumber === undefined ? 'Not provided' : numberLabel(identity.blockNumber));
      addDefinition(context, 'Transaction index (zero-based)', identity.transactionIndex === null || identity.transactionIndex === undefined ? 'Not provided' : numberLabel(identity.transactionIndex));
      addDefinition(context, 'Post-transaction state index', identity.postTransactionIndex === null || identity.postTransactionIndex === undefined ? 'Not provided' : numberLabel(identity.postTransactionIndex));
      addDefinition(context, 'Original block time', formatTime(identity.timestamp) || 'Not provided');
      addDefinition(context, 'State binding', identity.stateBinding === 'block_hash_and_transaction_index' ? 'Block hash and transaction index' : identity.stateBinding || 'Not provided');
      addDefinition(context, 'Block hash', identity.stateBlockHash || 'Not provided');
    } else if (historical) addDefinition(context, 'Measurement basis', changes.basis || 'Not provided');
    else if (identity.headerContext === 'synthetic_unpriced_basefee_zero') {
      addDefinition(context, 'State', 'Pinned block, with isolated before-and-after token queries');
      addDefinition(context, 'Call environment', 'Unsigned call with a zero base fee; other block fields checked');
      addDefinition(context, 'Network fees', 'Not estimated');
    }
    $('balance-verification').hidden = !context.children.length;
  }
  if (measured) {
    const assets = Array.isArray(changes.assets) ? changes.assets : [];
    if (!assets.length) $('balance-assets').append(node('p', 'section-help', 'The balance probe returned no measured assets.'));
    for (const entry of assets) {
      const asset = entry.asset || {};
      const liability = asset.role === 'liability';
      const custody = entry.accountRoles?.includes('reserve_custody');
      const card = node('div', `balance-card${liability ? ' liability-card' : ''}${custody ? ' custody-card' : ''}`);
      const title = node('div', 'asset-name-row');
      title.append(node('span', 'token-icon', (asset.symbol || '?').slice(0, 1)), node('span', 'asset-symbol', asset.symbol || 'Unknown token'));
      card.append(title);
      const direction = rawDirection(entry.deltaRaw);
      card.append(node('div', `balance-delta ${liability ? 'debt-' : custody ? 'custody-' : ''}${direction}`, signedAmount(entry.delta, entry.deltaRaw)));
      const role = liability ? direction === 'positive' ? 'Debt increase' : direction === 'negative' ? 'Debt reduction' : direction === 'neutral' ? 'Debt unchanged' : 'Debt change unavailable'
        : asset.role === 'receipt_token' ? 'Supplied position' : custody ? 'Reserve-held assets' : 'Token balance';
      card.append(node('div', 'balance-role', role));
      const details = node('dl', 'balance-before-after');
      addDefinition(details, 'Before', entry.before ?? (entry.beforeRaw !== undefined ? `${entry.beforeRaw} raw units` : null));
      addDefinition(details, 'After', entry.after ?? (entry.afterRaw !== undefined ? `${entry.afterRaw} raw units` : null));
      card.append(details);
      if (entry.accountRoles?.length) card.append(node('div', 'balance-account-role', entry.accountRoles.map(readableKey).join(' · ')));
      if (entry.account) card.append(node('div', 'asset-address', `Account ${entry.account}`));
      if (asset.address) card.append(node('div', 'asset-address', `Token ${asset.address}`));
      const target = custody ? 'balance-custody' : liability ? 'balance-debts' : 'balance-assets';
      $(target).append(card);
      if (target !== 'balance-assets') $(`${target}-group`).hidden = false;
    }
  }
  const warnings = Array.isArray(changes.warnings) ? changes.warnings : [];
  $('balance-warnings').hidden = !warnings.length;
  $('balance-warnings').replaceChildren(...warnings.map((warning) => node('li', '', display(warning))));
}

function renderPositions(changes, result) {
  const entries = Array.isArray(changes) ? changes : [];
  $('positions-section').hidden = !entries.length;
  $('position-changes').replaceChildren();
  const knownAssets = [...(result.balanceChanges?.assets || []), ...(result.inAssets || []), ...(result.outAssets || [])].map(entry => entry.asset).filter(Boolean);
  for (const entry of entries) {
    const asset = knownAssets.find(item => typeof item.address === 'string' && item.address.toLowerCase() === String(entry.token).toLowerCase());
    const liability = entry.role === 'liability';
    const direction = rawDirection(entry.deltaRaw);
    const role = liability ? 'Debt' : entry.role === 'receipt_token' ? 'Supplied position' : 'Position';
    const movement = direction === 'positive' ? 'increase' : direction === 'negative' ? 'decrease' : direction === 'neutral' ? 'unchanged' : 'change unavailable';
    const card = node('div', `permission-observation${liability ? ' liability-card' : ''}`);
    const heading = node('div', 'permission-heading');
    heading.append(node('h4', '', `${role} ${movement} · event-implied`), node('span', 'basis-badge', asset?.symbol || titleCase(entry.role)));
    card.append(heading);
    const details = node('dl', 'permission-details');
    addDefinition(details, 'Implied change', `${signedAmount(entry.delta, entry.deltaRaw)}${entry.delta !== null && entry.delta !== undefined && asset?.symbol ? ` ${asset.symbol}` : ''}`);
    addDefinition(details, 'Change raw units', entry.deltaRaw);
    addDefinition(details, 'Position role', liability ? 'Liability · non-transferable debt' : titleCase(entry.role));
    addDefinition(details, 'Account', entry.account);
    addDefinition(details, 'Token', entry.token);
    addDefinition(details, 'Event', entry.event);
    addDefinition(details, 'Event raw amount', entry.valueRaw);
    addDefinition(details, 'Accrued interest', entry.accruedInterestRaw === null || entry.accruedInterestRaw === undefined ? null : `${entry.accruedInterestRaw} raw units`);
    addDefinition(details, 'Evidence', entry.basis ? readableKey(entry.basis) : null);
    card.append(details);
    $('position-changes').append(card);
  }
}

function renderAccountEffects(effects, historical = false, affectedBalances) {
  const accounts = Array.isArray(effects?.accounts) ? effects.accounts : [];
  $('account-effects-section').hidden = !effects;
  $('account-effects-list').replaceChildren();
  $('account-effects-summary').replaceChildren();
  $('account-effects-warnings').replaceChildren();
  if (!effects) return;
  $('account-effects-badge').textContent = effects.status === 'observed' ? 'Limited account coverage' : titleCase(effects.status);
  $('account-effects-description').textContent = effects.status === 'observed'
    ? `Accounts identified in the ${historical ? 'original execution' : 'simulated call'} and available measurements. Some accounts have only event evidence; measured balance changes are labeled separately. This is not a complete inventory of affected accounts.`
    : effects.status === 'not_applicable'
      ? 'Account effects are not available for this execution. No zero balance change is inferred.'
      : 'The observed-account view could not be produced. Missing observations do not establish unchanged balances.';
  const summary = effects.summary || {};
  const counts = [
    ['Observed accounts', summary.accountCount],
    ['Other than submitter', summary.nonSubmitterAccountCount],
    ['Measured balance pairs', summary.measuredBalancePairs],
    ['Unmeasured balance pairs', summary.unmeasuredBalancePairs],
  ];
  for (const [label, value] of effects.status === 'observed' ? counts : []) {
    if (value === null || value === undefined) continue;
    const count = node('div', 'account-count');
    count.append(node('strong', '', value), node('span', '', label));
    $('account-effects-summary').append(count);
  }
  for (const account of accounts) {
    const card = node('details', 'account-effect');
    card.open = accounts.length <= 2;
    const heading = node('summary', 'account-effect-heading');
    const identity = node('span', 'account-effect-identity');
    identity.append(node('span', 'account-address', account.address), node('span', `account-submitter${account.isSubmitter ? ' is-submitter' : ''}`, account.isSubmitter ? 'Transaction submitter' : 'Other observed account'));
    const tokens = Array.isArray(account.tokens) ? account.tokens : [];
    const measuredCount = tokens.filter(token => token.balance?.status === 'measured').length;
    heading.append(identity, node('span', 'account-effect-count', `${tokens.length} token${tokens.length === 1 ? '' : 's'} · ${measuredCount} measured`));
    card.append(heading);
    const body = node('div', 'account-effect-body');
    if (account.roles?.length) body.append(node('p', 'account-role-list', account.roles.map(readableKey).join(' · ')));
    if (!tokens.length) body.append(node('p', 'section-help', 'No token observations or measurements are attached to this account.'));
    for (const token of tokens) {
      const asset = token.asset || {};
      const liability = token.role === 'liability';
      const decimalsKnown = token.tokenVerified === true && Number.isInteger(asset.decimals) && asset.decimals >= 0 && asset.decimals <= 255;
      const value = (formatted, raw, signed = false) => signed ? signedAmount(decimalsKnown ? formatted : null, raw) : exactAmount(decimalsKnown ? formatted : null, raw);
      const row = node('div', `account-token${liability ? ' account-token-liability' : ''}`);
      const title = node('div', 'account-token-heading');
      title.append(node('strong', '', asset.symbol || 'Unknown token'), node('span', 'basis-badge', token.tokenVerified === true ? liability ? 'Liability' : titleCase(token.role) : 'Unverified token'));
      row.append(title, node('div', 'account-token-address', asset.address));
      if (liability) row.append(node('p', 'account-liability-note', 'Debt balance · an increase is additional debt, not spendable assets.'));
      const evidence = node('div', 'account-evidence-grid');
      const events = node('div', 'account-evidence');
      events.append(node('h4', '', 'Transfer-event net'));
      if (token.events?.status === 'observed') {
        events.append(node('strong', 'account-evidence-value', value(token.events.net, token.events.netRaw, true)));
        const details = node('dl', 'account-evidence-details');
        addDefinition(details, 'Incoming events', value(token.events.incoming, token.events.incomingRaw));
        addDefinition(details, 'Outgoing events', value(token.events.outgoing, token.events.outgoingRaw));
        addDefinition(details, 'Exact net raw', token.events.netRaw);
        events.append(details, node('p', 'account-evidence-note', 'Event-derived; this is not a measured balance change.'));
      } else events.append(node('p', 'account-evidence-missing', 'No transfer event observed'), node('p', 'account-evidence-note', 'This does not establish zero balance change.'));
      const balance = node('div', 'account-evidence');
      balance.append(node('h4', '', liability ? 'Measured debt change' : 'Measured balance change'));
      if (token.balance?.status === 'measured') {
        balance.append(node('strong', 'account-evidence-value', value(token.balance.delta, token.balance.deltaRaw, true)));
        const details = node('dl', 'account-evidence-details');
        addDefinition(details, 'Before', value(token.balance.before, token.balance.beforeRaw));
        addDefinition(details, 'After', value(token.balance.after, token.balance.afterRaw));
        addDefinition(details, 'Exact change raw', token.balance.deltaRaw);
        balance.append(details, node('p', 'account-evidence-note', token.balance.basis === 'historical_transaction_position_balanceOf'
          ? 'Measured at the original transaction position.' : `Measurement basis: ${token.balance.basis ? readableKey(token.balance.basis) : 'Not provided'}.`));
      } else balance.append(node('p', 'account-evidence-missing', 'Not measured'), node('p', 'account-evidence-note', 'No before-and-after balance result for this account and token.'));
      evidence.append(events, balance);
      row.append(evidence);
      const references = Array.isArray(token.permissionReferences) ? token.permissionReferences : [];
      const allowanceCount = Array.isArray(token.allowanceIndexes) ? token.allowanceIndexes.length : 0;
      if (references.length || allowanceCount) {
        const referenceDetails = node('details', 'account-references');
        referenceDetails.append(node('summary', '', `${references.length} permission reference${references.length === 1 ? '' : 's'} · ${allowanceCount} measured allowance pair${allowanceCount === 1 ? '' : 's'}`));
        const list = node('ul');
        for (const reference of references) list.append(node('li', '', `${titleCase(reference.role)} in observation ${display(reference.observationId)}`));
        if (allowanceCount) list.append(node('li', '', 'See the measured allowances section for the corresponding token, owner, and spender values.'));
        referenceDetails.append(list);
        row.append(referenceDetails);
      }
      body.append(row);
    }
    card.append(body);
    $('account-effects-list').append(card);
  }
  if (effects.status === 'observed' && !accounts.length) $('account-effects-list').append(node('p', 'section-help', 'No accounts were identified in the available evidence.'));
  const warnings = [...new Set([...(effects.coverage?.reasons || []), ...(effects.warnings || []), ...(affectedBalances?.warnings || [])])];
  $('account-effects-limits').hidden = !warnings.length;
  $('account-effects-warnings').replaceChildren(...warnings.map(warning => node('li', '', display(warning))));
}

function renderPermissions(permissions, allowanceChanges) {
  const observations = Array.isArray(permissions?.observations) ? permissions.observations : [];
  const findings = Array.isArray(permissions?.findings) ? permissions.findings : [];
  $('permissions-section').hidden = !observations.length && !findings.length;
  $('permission-findings').replaceChildren();
  $('permission-observations').replaceChildren();
  $('permission-warnings').replaceChildren();
  if (!observations.length && !findings.length) return;
  const hasMeasuredPairs = allowanceChanges?.status === 'measured' && allowanceChanges.allowances?.length;
  $('permissions-description').textContent = hasMeasuredPairs
    ? 'Approval and permit requests, emitted Approval events, and transferFrom calls are distinct observations. Final allowances are measured only for the exact pairs identified above. Spender reputation, authorization intent, and general transaction security remain not assessed.'
    : 'Approval and permit requests, emitted Approval events, and transferFrom calls are distinct observations. Final allowances are not measured for these observations. Spender reputation, authorization intent, and general transaction security remain not assessed.';
  for (const finding of findings) {
    const card = node('div', 'permission-finding');
    const label = finding.code === 'MAX_UINT256_APPROVAL_EVENT' ? 'Maximum allowance reported in an event'
      : ['MAX_UINT256_APPROVAL_REQUEST','MAX_UINT256_PERMIT_REQUEST'].includes(finding.code) ? 'Maximum allowance requested'
      : finding.code === 'PERMIT_UNBOUNDED_DEADLINE' ? 'Permit has no bounded redemption deadline'
      : finding.code === 'APPROVAL_EVENT_MISMATCH' ? 'Request and event do not match'
      : 'Approval evidence to review';
    const measured = measuredAllowance(allowanceChanges, finding);
    let message = finding.message || 'Review the recorded permission evidence.';
    if (measured && ['MAX_UINT256_APPROVAL_REQUEST','MAX_UINT256_PERMIT_REQUEST'].includes(finding.code)) message = `The call requested the maximum uint256 allowance for spender ${finding.spender}, but no matching Approval event was observed. The final allowance after the whole transaction for this token, owner, and spender was measured separately. Spender trustworthiness is not assessed.`;
    card.append(node('strong', '', label), node('p', '', message));
    if (measured) card.append(node('p', 'measured-permission-note', `${allowanceChangeLabel(measured)}. Measured after: ${exactAmount(measured.after, measured.afterRaw, measured.asset?.symbol)}.`));
    $('permission-findings').append(card);
  }
  for (const observation of observations) {
    const card = node('div', 'permission-observation');
    const permit = observation.kind === 'permit_request';
    const requested = observation.kind === 'approval_request' || permit;
    const emitted = observation.kind === 'approval_event';
    const transfer = observation.kind === 'transfer_from_call';
    const verified = observation.tokenVerified === true && (requested || emitted || transfer);
    const heading = node('div', 'permission-heading');
    const title = transfer ? 'transferFrom call · requested transfer' : permit ? 'Permit authorization request' : requested ? 'Requested approval' : emitted ? 'Emitted Approval event' : 'Unverified token call or event';
    heading.append(node('h4', '', title), node('span', 'basis-badge', verified ? observation.asset?.symbol || 'Configured token' : 'Unverified contract'));
    card.append(heading);
    const details = node('dl', 'permission-details');
    addDefinition(details, 'Token / contract', observation.asset?.address || observation.contract);
    if (verified && transfer) {
      const measured = measuredAllowance(allowanceChanges, observation);
      addDefinition(details, 'Owner', observation.owner);
      addDefinition(details, 'Spender · token caller', observation.spender);
      addDefinition(details, 'Recipient', observation.recipient);
      addDefinition(details, 'Transaction submitter', observation.submitter);
      addDefinition(details, 'Requested transfer', exactAmount(observation.amount, observation.amountRaw, observation.asset?.symbol));
      addDefinition(details, 'Exact requested raw', observation.amountRaw);
      addDefinition(details, 'Call return', observation.returnStatus === 'returned_true' ? 'Returned true · consult separate transfer and balance evidence'
        : observation.returnStatus === 'returned_false' ? 'Returned false · token movement is not established'
        : observation.returnStatus ? readableKey(observation.returnStatus) : 'Not available');
      addDefinition(details, 'Authorization verification', 'Not independently verified');
      addDefinition(details, 'Intent verification', 'Not assessed');
      addDefinition(details, 'Final allowance', measured
        ? `${exactAmount(measured.after, measured.afterRaw, measured.asset?.symbol)} · measured separately for this owner and spender`
        : 'Not measured for this token, owner, and spender pair');
      card.append(node('p', 'permission-unverified', 'This is a requested transfer amount, not an approval amount. A successful call does not independently establish authorization or intent; an unchanged allowance does not mean no spending occurred.'));
    } else if (verified) {
      const measured = measuredAllowance(allowanceChanges, observation);
      const kind = observation.allowanceKind === 'uint256_max' ? 'Maximum uint256 (commonly called unlimited)'
        : observation.allowanceKind === 'revoke' ? 'Revoke · zero allowance' : 'Bounded amount';
      addDefinition(details, 'Allowance type', kind);
      addDefinition(details, 'Owner', observation.owner);
      addDefinition(details, 'Spender', observation.spender);
      if (permit) {
        addDefinition(details, 'Transaction submitter', observation.submitter);
        addDefinition(details, 'Immediate permit caller', observation.permitCaller);
        addDefinition(details, 'Submitted by owner', observation.relayed === true ? 'No · relayed transaction' : observation.relayed === false ? 'Yes' : null);
        addDefinition(details, 'Signature redemption deadline', observation.deadlineRelation === 'unbounded' ? 'Maximum uint256 · no bounded deadline' : observation.deadlineRaw ? `${observation.deadlineRaw} Unix seconds` : null);
        addDefinition(details, 'Deadline at execution', observation.deadlineRelation ? readableKey(observation.deadlineRelation) : null);
        addDefinition(details, 'Independent signature verification', 'Not performed');
      }
      addDefinition(details, requested ? 'Requested amount' : 'Event amount', observation.amount === null || observation.amount === undefined
        ? `${observation.amountRaw} raw units`
        : `${observation.amount}${observation.asset?.symbol ? ` ${observation.asset.symbol}` : ''}`);
      addDefinition(details, 'Exact raw amount', observation.amountRaw);
      if (requested) {
        const correlation = observation.eventCorrelation === 'matched' ? 'Matching Approval event observed'
          : observation.eventCorrelation === 'mismatched' ? 'Observed Approval evidence does not match this request'
          : 'No matching Approval event observed';
        addDefinition(details, 'Event correlation', correlation);
        const returned = observation.returnStatus === 'returned_false' ? measured ? 'Returned false · use the separate final-state measurement for this pair' : 'Returned false · approval success is not established'
          : observation.returnStatus === 'returned_true' ? measured ? 'Returned true · final allowance measured separately for this pair' : 'Returned true · final allowance is not independently verified'
          : permit && observation.returnStatus === 'empty' ? 'No return value · expected for this permit function'
          : observation.returnStatus ? readableKey(observation.returnStatus) : null;
        addDefinition(details, 'Call return', returned);
      } else addDefinition(details, 'Request correlation', observation.matchedRequestIds?.length
        ? 'Matches an observed approval or permit request' : 'No matching approval or permit request identified');
      addDefinition(details, 'Final allowance', measured
        ? `${exactAmount(measured.after, measured.afterRaw, measured.asset?.symbol)} · measured after the whole ${allowanceChanges.basis === 'historical_transaction_position_allowance' ? 'original' : 'simulated'} transaction`
        : 'Not measured for this token, owner, and spender pair');
    } else {
      addDefinition(details, 'Selector / signature', observation.selector || observation.signature);
      card.append(node('p', 'permission-unverified', 'ERC20 ownership, spender, and allowance semantics are not inferred from an unverified contract.'));
    }
    addDefinition(details, 'Evidence', observation.basis ? readableKey(observation.basis) : null);
    addDefinition(details, 'Observation ID', observation.id);
    card.append(details);
    $('permission-observations').append(card);
  }
  const warnings = [...new Set([...(permissions?.coverage?.reasons || []), ...(permissions?.warnings || [])])];
  $('permission-limits').hidden = !warnings.length;
  $('permission-warnings').replaceChildren(...warnings.map((warning) => node('li', '', display(warning))));
}

function renderProtocol(protocol, result) {
  $('protocol-summary').hidden = !protocol;
  $('protocol-summary').replaceChildren();
  if (!protocol) return;
  const label = [protocol.name, protocol.operation ? readableKey(protocol.operation) : null].filter(Boolean).join(' / ');
  $('protocol-summary').append(node('strong', '', label));
  const asset = [...(result.balanceChanges?.assets || []), ...(result.outAssets || []), ...(result.inAssets || [])].find(item => typeof protocol.asset === 'string' && item.asset?.address?.toLowerCase() === protocol.asset.toLowerCase())?.asset;
  const symbol = protocol.symbol || asset?.symbol || (protocol.name === 'HyperCore' ? 'USDC' : '');
  const lending = ['withdraw', 'borrow', 'repay'].includes(protocol.operation);
  if (lending || protocol.amountMode || protocol.actualAmountRaw !== undefined) {
    const details = node('dl', 'protocol-details');
    const allAmount = protocol.operation === 'repay' ? 'All outstanding debt' : protocol.operation === 'withdraw' ? 'Entire supplied balance' : 'Protocol maximum amount';
    addDefinition(details, 'Requested amount', protocol.amountMode === 'all' ? `${allAmount} · uint256 maximum sentinel` : exactAmount(protocol.amount, protocol.amountRaw, symbol));
    addDefinition(details, 'Amount mode', protocol.amountMode ? titleCase(protocol.amountMode) : null);
    addDefinition(details, 'Executed amount', protocol.actualAmount === null || protocol.actualAmount === undefined
      ? protocol.actualAmountRaw === null || protocol.actualAmountRaw === undefined ? 'Not established' : exactAmount(null, protocol.actualAmountRaw)
      : exactAmount(protocol.actualAmount, protocol.actualAmountRaw, symbol));
    addDefinition(details, 'Requested raw', protocol.amountRaw);
    addDefinition(details, 'Executed raw', protocol.actualAmountRaw);
    addDefinition(details, 'Recipient', protocol.recipient);
    addDefinition(details, 'Position owner', protocol.positionAccount || protocol.onBehalfOf);
    addDefinition(details, 'Reconciliation', protocol.reconciliation?.status ? titleCase(protocol.reconciliation.status) : null);
    $('protocol-summary').append(details);
    if (protocol.actualAmountRaw !== null && protocol.actualAmountRaw !== undefined && protocol.amountRaw !== null && protocol.amountRaw !== undefined) {
      let differs = false;
      try { differs = BigInt(protocol.actualAmountRaw) !== BigInt(protocol.amountRaw); } catch { /* Keep raw evidence visible without inferring a comparison. */ }
      if (differs) $('protocol-summary').append(node('p', 'protocol-amount-note', protocol.amountMode === 'all'
        ? 'The maximum integer is a protocol instruction. The executed amount is shown separately.'
        : 'The executed amount differs from the requested amount. Use the executed amount when reviewing the transfer and position evidence.'));
    }
  } else {
    const principal = protocol.amount ?? protocol.principal ?? protocol.depositAmount;
    if (principal !== undefined && principal !== null) $('protocol-summary').append(document.createTextNode(` · ${display(principal)}${symbol ? ` ${symbol}` : ''}${protocol.operation === 'supply' ? ' principal' : ''}`));
  }
  if (protocol.direction) $('protocol-summary').append(node('span', 'protocol-direction', readableKey(protocol.direction)));
}

function beginResult(result, standard = false) {
  state.result = result;
  $('copy-json').disabled = false;
  $('download-json').disabled = false;
  $('empty-state').hidden = true;
  $('result-content').hidden = false;
  $('hyper-result').hidden = standard;
  $('standard-result').hidden = !standard;
  $('local-result').hidden = true;
  $('sequence-result').hidden = !result.sequence;
  $('execution-label').textContent = 'Execution';
  state.renderStep = null;
  $('coverage-label').textContent = standard ? 'Requested checks' : 'Coverage';
  $('raw-json').textContent = JSON.stringify(result, null, 2);
}

function standardMeasured(query) {
  return query.status === 'measured' && typeof query.beforeRaw === 'string' && /^\d+$/.test(query.beforeRaw)
    && typeof query.afterRaw === 'string' && /^\d+$/.test(query.afterRaw)
    && typeof query.deltaRaw === 'string' && /^-?\d+$/.test(query.deltaRaw);
}

function standardWarning(warning) {
  const language = {
    'Explicit queried accounts only; other assets and economic effects may be omitted.': 'Only the listed accounts and token queries are checked. Other changes may be omitted.',
    'Synthetic BASEFEE-zero execution with no outer transaction signature or fee-settlement validation. Contract permit checks still execute.': 'Execution uses a zero base fee and does not validate transaction fees or the outer signature. Permit checks inside the call still run.',
    'Historical block-end state is not the original transaction position.': 'A past block starts the call from that block’s end state, which differs from the original transaction’s position.',
    'Token labels and decimals are historical reference metadata, not verified again for the requested state.': 'Token names and units come from historical reference data and are not checked again for this simulation.',
    'Provider codeHash consistency is not independent state or source-code attestation.': 'The provider supplies the execution evidence. Contract code and state have not been independently authenticated.',
    'No security verdict or comparative detection score is produced.': 'These results do not establish that a transaction or spender is safe.',
  };
  return language[warning] || display(warning);
}

function renderStandardAmounts(query, heading, account, native = false) {
  const measured = standardMeasured(query);
  const table = node('table', 'measurement-table');
  const caption = node('caption', 'sr-only', `${heading} for ${account || 'the requested account'}`);
  const head = node('thead'), headRow = node('tr'), body = node('tbody'), row = node('tr');
  for (const label of state.renderStep ? [`Before step ${state.renderStep}`, `After step ${state.renderStep}`, `Step ${state.renderStep} change`] : ['Before', 'After', 'Change']) { const th = node('th', '', label); th.scope = 'col'; headRow.append(th); }
  head.append(headRow);
  for (const field of ['before', 'after', 'delta']) {
    const cell = node('td');
    if (measured) {
      const raw = query[`${field}Raw`];
      const formatted = native || query.metadata ? query[field] : undefined;
      const amount = native && (formatted === null || formatted === undefined)
        ? `${field === 'delta' && rawDirection(raw) === 'positive' ? '+' : ''}${raw} wei`
        : `${field === 'delta' ? signedAmount(formatted, raw) : exactAmount(formatted, raw)}${native ? ' ETH' : ''}`;
      cell.append(node('strong', '', amount));
      if (formatted !== undefined && formatted !== null) cell.append(node('span', 'raw-amount', `${raw} ${native ? 'wei' : 'raw units'}`));
    } else cell.append(node('span', 'missing-amount', 'Not available'));
    row.append(cell);
  }
  body.append(row);
  table.append(caption, head, body);
  return table;
}

function renderStandardQuery(query, sender) {
  const allowance = query.kind === 'allowance';
  const measured = standardMeasured(query);
  const metadata = query.metadata;
  const heading = `${metadata?.symbol || 'Token'} ${allowance ? 'allowance' : 'balance'}`;
  const article = node('article', `standard-query-card${measured ? '' : ' query-unavailable'}`);
  const header = node('div', 'permission-heading');
  header.append(node('h4', '', heading), node('span', `query-status ${measured ? 'measured' : 'unavailable'}`, measured ? 'Measured' : query.status === 'not_applicable' ? 'Not applied' : 'Unavailable'));
  article.append(header);
  const owner = allowance ? query.owner : query.account;
  const senderMatches = typeof owner === 'string' && typeof sender === 'string' && owner.toLowerCase() === sender.toLowerCase();
  const details = node('dl', 'permission-details');
  addDefinition(details, allowance ? 'Owner' : 'Account', owner);
  if (senderMatches) addDefinition(details, 'Account role', 'Transaction sender');
  if (allowance) addDefinition(details, 'Spender', query.spender);
  addDefinition(details, 'Token contract', query.token);
  if (metadata?.name) addDefinition(details, 'Reference name', metadata.name);
  article.append(details, renderStandardAmounts(query, heading, owner));
  if (!measured) article.append(node('p', 'query-note', query.reason || 'This value was not measured. It must not be interpreted as zero.'));
  if (measured && allowance) {
    const maximum = ((1n << 256n) - 1n).toString();
    const text = query.beforeRaw === query.afterRaw
      ? query.afterRaw === '0' ? 'Final allowance unchanged at zero.' : query.afterRaw === maximum ? 'Maximum allowance unchanged.' : 'Final allowance unchanged.'
      : query.afterRaw === '0' ? 'Final allowance reduced to zero.' : query.afterRaw === maximum ? 'Final allowance is the maximum uint256 value.' : 'Final allowance changed to the amount shown above.';
    article.append(node('p', 'query-note', text));
  }
  if (metadata) article.append(node('p', 'query-reference', `Name and units use reference metadata${metadata.referenceBlockNumber ? ` from block ${numberLabel(metadata.referenceBlockNumber)}` : ''}. They are not reverified for this simulation.`));
  else article.append(node('p', 'query-reference', 'Token name and decimals are not established. Values are shown in raw units.'));
  return article;
}

function standardPositionMeasured(position) {
  const fields = position.kind === 'aave_v3_user_account_data'
    ? [['totalCollateralBase', 256], ['totalDebtBase', 256], ['availableBorrowsBase', 256], ['currentLiquidationThreshold', 256], ['ltv', 256], ['healthFactor', 256]]
    : position.kind === 'morpho_blue_position' ? [['supplyShares', 256], ['borrowShares', 128], ['collateral', 128]] : [];
  if (position.status !== 'measured' || !fields.length || !Array.isArray(position.rows) || position.rows.length !== fields.length) return false;
  return fields.every(([name, bits], index) => {
    const row = position.rows[index], valid = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < (1n << BigInt(bits));
    return row?.name === name && row.abiType === `uint${bits}` && valid(row.beforeRaw) && valid(row.afterRaw)
      && typeof row.deltaRaw === 'string' && /^(?:0|-?[1-9][0-9]{0,77})$/.test(row.deltaRaw)
      && BigInt(row.deltaRaw) === BigInt(row.afterRaw) - BigInt(row.beforeRaw);
  });
}

function standardPositionViews(result) {
  return (Array.isArray(result.preview?.positions) ? result.preview.positions : []).map(position => {
    if (result.canonicalStatus === 'verified' && result.execution?.status === 'success') return position;
    const view = { ...position, status: 'unavailable', reason: 'The execution or block context was not verified. Position values are withheld.' };
    delete view.rows; return view;
  });
}

function positionUnitLabel(unit) {
  const labels = {
    oracle_base_units: 'Oracle base units · currency and scale not verified',
    basis_points: 'Basis points', ratio: 'Ratio',
    supply_shares: 'Supply shares · not converted to assets',
    borrow_shares: 'Borrow shares · not converted to assets',
    collateral_token_raw_units: 'Collateral token raw units · token and scale not verified',
  };
  const label = labels[unit?.kind] || 'Raw units · scale not verified';
  return `${label}${typeof unit?.scale === 'string' && /^[1-9][0-9]{0,77}$/.test(unit.scale) ? ` · scale ${unit.scale}` : ''}`;
}

function renderStandardPosition(position, sender) {
  const measured = standardPositionMeasured(position);
  const title = position.kind === 'aave_v3_user_account_data' ? 'Aave account data'
    : position.kind === 'morpho_blue_position' ? 'Morpho market position' : 'Position query';
  const article = node('article', `standard-query-card standard-position-card${measured ? '' : ' query-unavailable'}`);
  const heading = node('div', 'permission-heading');
  heading.append(node('h4', '', title), node('span', `query-status ${measured ? 'measured' : 'unavailable'}`, measured ? 'Measured raw values' : position.status === 'not_applicable' ? 'Not applied' : 'Unavailable'));
  const details = node('dl', 'permission-details');
  if (Number.isSafeInteger(position.index) && position.index >= 0) addDefinition(details, 'Manual query', position.index + 1);
  addDefinition(details, 'Network', position.chainId === '1' || position.chainId === 1 ? 'Ethereum · chain 1' : position.chainId);
  addDefinition(details, 'Contract', position.contract); addDefinition(details, 'User', position.user);
  if (typeof sender === 'string' && typeof position.user === 'string' && sender.toLowerCase() === position.user.toLowerCase()) addDefinition(details, 'User role', 'Transaction sender');
  addDefinition(details, 'Market ID', position.marketId);
  article.append(heading, details, node('p', 'query-reference', 'Explicit query. Contract identity is not verified; units follow the reference interface.'));
  if (measured) {
    const table = node('table', 'measurement-table position-measurement-table'), head = node('thead'), columns = node('tr'), body = node('tbody');
    const labels = state.renderStep ? ['Field / units', `Before step ${state.renderStep}`, `After step ${state.renderStep}`, `Step ${state.renderStep} change`] : ['Field / units', 'Before', 'After', 'Change'];
    for (const label of labels) { const th = node('th', '', label); th.scope = 'col'; columns.append(th); }
    head.append(columns);
    for (const row of position.rows) {
      const tr = node('tr'), field = node('th'); field.scope = 'row';
      field.append(node('span', 'position-field-name', row.name), node('span', 'position-unit', `${row.abiType} · ${positionUnitLabel(row.unit)}`)); tr.append(field);
      for (const name of ['beforeRaw', 'afterRaw', 'deltaRaw']) { const cell = node('td'); cell.append(node('strong', '', row[name])); tr.append(cell); }
      body.append(tr);
    }
    table.append(node('caption', 'sr-only', `${title} raw before, after and change for ${position.user}`), head, body); article.append(table);
  } else article.append(node('p', 'query-note', position.status === 'measured'
    ? 'The returned position values are inconsistent or incomplete and are withheld.'
    : position.reason || 'This position was not measured. Missing values are not zero.'));
  const limits = node('details', 'permission-limits'); limits.append(node('summary', '', 'Units & measurement limits'));
  const list = node('ul');
  list.append(node('li', '', 'Values are raw integers. No totals, asset conversion, currency valuation or account-health interpretation is applied.'));
  for (const limitation of Array.isArray(position.limitations) ? position.limitations : []) list.append(node('li', '', display(limitation)));
  limits.append(list);
  if (Array.isArray(position.references)) {
    const references = node('ul');
    for (const value of position.references) {
      try {
        const url = new URL(value); if (url.protocol !== 'https:') continue;
        const item = node('li'), link = node('a', '', url.hostname + url.pathname); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link); references.append(item);
      } catch {}
    }
    if (references.children.length) limits.append(references);
  }
  article.append(limits); return article;
}

function renderStandardNativeBalance(balance, sender) {
  const measured = standardMeasured(balance);
  const article = node('article', `standard-query-card${measured ? '' : ' query-unavailable'}`);
  const header = node('div', 'permission-heading');
  header.append(node('h4', '', 'ETH balance'), node('span', `query-status ${measured ? 'measured' : 'unavailable'}`, measured ? 'Measured' : balance.status === 'not_applicable' ? 'Not applied' : 'Unavailable'));
  const details = node('dl', 'permission-details');
  addDefinition(details, 'Account', balance.account);
  if (typeof balance.account === 'string' && typeof sender === 'string' && balance.account.toLowerCase() === sender.toLowerCase()) addDefinition(details, 'Account role', 'Transaction sender');
  article.append(header, details, renderStandardAmounts(balance, 'ETH balance', balance.account, true));
  if (!measured) article.append(node('p', 'query-note', balance.reason || 'This ETH balance was not measured. Missing amounts are not zero.'));
  else if (balance.deltaRaw === '0') article.append(node('p', 'query-note', 'Balance unchanged; measured before and after. Transaction fees are excluded.'));
  return article;
}

function nativeSelectionCount(effects, rows) {
  return Number.isSafeInteger(effects?.counts?.selected) && effects.counts.selected >= 0 ? effects.counts.selected : rows.length ? rows.length : null;
}

function renderStandardNative(effects, rows, sender) {
  const status = effects?.status || 'unavailable';
  const candidates = Array.isArray(effects?.candidates) ? effects.candidates : [];
  const notSelected = candidates.filter(candidate => candidate.selected !== true);
  const measured = rows.filter(standardMeasured).length;
  const selected = nativeSelectionCount(effects, rows);
  const maximum = Number.isSafeInteger(effects?.maxAccounts) ? effects.maxAccounts : 8;
  $('standard-native-status').textContent = status === 'measured' ? 'Measured · fees excluded'
    : status === 'partial' ? 'Partial account coverage' : status === 'none' ? 'None observed'
      : status === 'not_applicable' ? 'Not applied' : 'Unavailable';
  $('standard-native-description').textContent = status === 'not_applicable'
    ? 'The call failed or reverted; its state changes were not committed. No ETH measurements were applied. Network fees are not modeled.'
    : status === 'none' ? 'No supported ETH account candidates were observed. This is not a complete inventory of asset changes, and no balance is assumed to be zero.'
      : status === 'unavailable' ? `ETH measurements could not be established. ${effects?.reason || 'The response does not establish native balance checks.'} Missing measurements are not zero balances.`
        : `Separate balance reads measure the selected accounts before and after the call. Up to ${maximum} ETH accounts can be selected; other accounts and effects may be omitted.`;
  const counts = $('standard-native-counts');
  counts.replaceChildren();
  for (const [label, value] of [
    ['Observed ETH accounts', effects?.counts?.candidates],
    ['Selected ETH accounts', selected],
    ['Measured ETH accounts', selected === null ? null : measured],
    ['Accounts not selected', effects?.counts?.omitted],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) continue;
    const count = node('div', 'account-count');
    count.append(node('strong', '', value), node('span', '', label));
    counts.append(count);
  }
  counts.hidden = counts.children.length === 0;
  $('standard-native-balances').replaceChildren(...rows.map(balance => renderStandardNativeBalance(balance, sender)));
  $('standard-native-omissions').hidden = notSelected.length === 0;
  $('standard-native-omissions').open = false;
  $('standard-native-omissions-heading').textContent = `${notSelected.length} ETH account${notSelected.length === 1 ? '' : 's'} not selected`;
  $('standard-native-candidates').replaceChildren(...notSelected.map(candidate => {
    const item = node('article', 'discovery-candidate');
    item.append(node('h4', '', 'ETH balance check not performed'));
    const details = node('dl', 'permission-details');
    addDefinition(details, 'Account', candidate.account);
    addDefinition(details, 'Reason', candidate.reason === 'account-limit' ? `The ${maximum}-account limit was reached.`
      : candidate.reason === 'rpc-budget' ? 'The provider request budget was reached.' : candidate.reason || 'The account was not selected for measurement.');
    item.append(details);
    return item;
  }));
}

function renderDiscoveryCandidate(candidate, reason) {
  const item = node('article', 'discovery-candidate');
  const allowance = candidate.kind === 'allowance';
  item.append(node('h4', '', allowance ? 'Allowance check not performed' : 'Balance check not performed'));
  const details = node('dl', 'permission-details');
  addDefinition(details, 'Token contract', candidate.token);
  addDefinition(details, allowance ? 'Owner' : 'Account', allowance ? candidate.owner : candidate.account);
  if (allowance) addDefinition(details, 'Spender', candidate.spender);
  addDefinition(details, 'Reason', candidate.selection === 'omitted_query_limit'
    ? 'Not selected because the query limit was reached.'
    : candidate.reason || reason || 'The available evidence did not establish a usable check.');
  item.append(details);
  return item;
}

function renderDiscovery(discovery, queries) {
  $('standard-discovery').hidden = !discovery;
  if (!discovery) return;
  const candidates = Array.isArray(discovery.candidates) ? discovery.candidates : [];
  const notSelected = candidates.filter(candidate => candidate.selection !== 'selected');
  const observed = discovery.counts || {};
  const described = discovery.status === 'discovered' || discovery.status === 'none';
  $('standard-discovery-status').textContent = discovery.status === 'unavailable' ? 'Unavailable'
    : discovery.status === 'not_applicable' ? 'Not applied' : 'Limited observations';
  $('standard-discovery-description').textContent = discovery.status === 'unavailable'
    ? `Automatic checks could not be established. ${discovery.reason || 'Review the execution evidence below.'} Missing checks do not establish that no assets changed.`
    : discovery.status === 'not_applicable' ? 'Automatic checks were not applied because the call did not complete successfully. This is not an empty-asset result.'
      : queries.length === 0 ? 'No supported checks were selected from this trace. This does not establish that no assets changed.'
        : 'The checks below were selected from observed token activity. Selection does not guarantee that every affected account or asset was found.';
  const counts = $('standard-discovery-counts');
  counts.replaceChildren();
  const candidateCount = Number.isSafeInteger(observed.candidates) && observed.candidates >= 0 ? observed.candidates : candidates.length;
  const selectionKnown = described || queries.length > 0 || Number.isSafeInteger(observed.selected);
  for (const [label, value] of [
    [observed.complete === false ? 'Candidates retained before stop' : 'Recorded candidates', described || candidates.length ? candidateCount : null],
    ['Selected checks', selectionKnown ? queries.length : null],
    ['Measured checks', selectionKnown ? queries.filter(standardMeasured).length : null],
    ['Candidates not selected', described || candidates.length ? notSelected.length : null],
  ]) {
    const count = node('div', 'account-count');
    count.append(node('strong', '', value === null ? '—' : value), node('span', '', label));
    counts.append(count);
  }
  $('standard-discovery-omissions').hidden = notSelected.length === 0;
  $('standard-discovery-omissions').open = false;
  $('standard-discovery-omissions-heading').textContent = `${notSelected.length} candidate${notSelected.length === 1 ? '' : 's'} not selected`;
  $('standard-discovery-candidates').replaceChildren(...notSelected.map(candidate => renderDiscoveryCandidate(candidate, discovery.reason)));
  const maximum = Number.isSafeInteger(discovery.limits?.maxQueries) ? discovery.limits.maxQueries : 8;
  $('standard-discovery-limits').textContent = observed.truncated === true
    ? 'The trace scan stopped at a limit. Counts describe only retained evidence; automatic checks were withheld.'
    : observed.complete === false ? 'The trace scan did not complete. Counts describe only retained evidence; automatic checks were withheld.'
      : observed.complete === true ? `The trace scan finished within its limits. Up to ${maximum} checks can be selected; a completed scan does not mean all asset changes were found.`
        : 'A completed trace scan was not established. No conclusion about missing asset changes can be drawn.';
  const diagnostics = Array.isArray(discovery.diagnostics) ? discovery.diagnostics : [];
  const excluded = [
    ['failedFrames', 'failed call frames'], ['staticFrames', 'read-only call frames'],
    ['nftTransferLogs', 'NFT-style transfer logs'], ['malformedKnownSignatures', 'malformed token events or calls'],
  ].filter(([key]) => Number.isSafeInteger(observed[key]) && observed[key] > 0)
    .map(([key, label]) => `${observed[key]} ${label} excluded from candidate selection.`);
  const notes = [...excluded, ...diagnostics.map(item => {
    if (typeof item === 'string') return item;
    const callPath = Array.isArray(item.callPath) ? item.callPath.length ? item.callPath.join('.') : 'root' : item.callPath;
    const location = [callPath !== undefined ? `Call ${callPath}` : '', item.logIndex !== undefined ? `log ${item.logIndex}` : ''].filter(Boolean).join(', ');
    return `${location ? `${location}: ` : ''}${item.message || item.reason || titleCase(item.code || 'Observation not used')}`;
  })];
  $('standard-discovery-diagnostics').hidden = notes.length === 0;
  $('standard-discovery-diagnostics').open = false;
  $('standard-discovery-notes').replaceChildren(...notes.map(item => node('li', '', item)));
}

function localQueryIdentity(descriptor = {}) {
  if (descriptor.kind) return descriptor;
  const data = descriptor.data || '';
  const account = data.length >= 74 ? '0x' + data.slice(34, 74) : null;
  return { kind: data.startsWith('0xdd62ed3e') ? 'allowance' : 'balanceOf', token: descriptor.to,
    ...(data.startsWith('0xdd62ed3e') ? { owner: account, spender: '0x' + data.slice(98, 138) } : { account }) };
}

function localMeasurementRows(result) {
  const queries = Array.isArray(result.apiRequest?.queries) ? result.apiRequest.queries : [];
  return queries.map((descriptor, index) => {
    const row = result.measurements?.[index], identity = localQueryIdentity(descriptor);
    const fields = identity.kind === 'balanceOf' ? [['balance', 256]] : identity.kind === 'allowance' ? [['allowance', 256]]
      : identity.kind === 'aave_v3_user_account_data' ? [['totalCollateralBase', 256], ['totalDebtBase', 256], ['availableBorrowsBase', 256], ['currentLiquidationThreshold', 256], ['ltv', 256], ['healthFactor', 256]]
        : identity.kind === 'morpho_blue_position' ? [['supplyShares', 256], ['borrowShares', 128], ['collateral', 128]] : [];
    const matching = row?.descriptor && Object.keys(descriptor).length === Object.keys(row.descriptor).length && Object.entries(descriptor).every(([key, value]) => row.descriptor[key] === value);
    const contextValid = ['complete', 'partial'].includes(result.status) && result.source?.canonicalStatus === 'verified' && ['success', 'reverted', 'failed'].includes(result.execution?.status);
    const measured = contextValid && matching && row.status === 'measured' && fields.length > 0 && Array.isArray(row.values) && row.values.length === fields.length && fields.every(([name, bits], i) => {
      const value = row.values[i], raw = n => typeof n === 'string' && /^(?:0|[1-9][0-9]{0,77})$/.test(n) && BigInt(n) < (1n << BigInt(bits));
      return value?.name === name && raw(value.beforeRaw) && raw(value.afterRaw) && typeof value.deltaRaw === 'string'
        && /^(?:0|-?[1-9][0-9]{0,77})$/.test(value.deltaRaw) && BigInt(value.deltaRaw) === BigInt(value.afterRaw) - BigInt(value.beforeRaw);
    });
    return { index, identity, measured, values: measured ? row.values : [], reason: contextValid && matching ? row.reason || 'This query was not completely measured. Missing values are not zero.' : 'The query result or verified state context is unavailable. Values are withheld.' };
  });
}

function renderLocalResult(result) {
  beginResult(result, true);
  $('standard-result').hidden = true; $('hyper-result').hidden = true; $('sequence-result').hidden = true; $('local-result').hidden = false;
  const rows = localMeasurementRows(result), measured = rows.filter(row => row.measured).length;
  $('result-label').textContent = 'Independent local preview · experimental';
  $('local-report-status').textContent = `Preview: ${titleCase(result.status)}`;
  $('execution-status').textContent = titleCase(result.execution?.status || 'unavailable');
  $('execution-status').className = result.execution?.status === 'success' ? 'success' : ['reverted', 'failed'].includes(result.execution?.status) ? 'failed' : 'partial';
  $('gas-used').textContent = 'Unsigned execution · network fees excluded';
  $('coverage-label').textContent = 'Requested checks'; $('coverage-status').textContent = `${measured} / ${rows.length} measured`;
  $('coverage-status').className = rows.length > 0 && measured === rows.length ? 'success' : 'partial';
  $('coverage-detail').textContent = 'Explicit query list only · raw units';
  $('execution-error').hidden = !result.error && !result.execution?.error;
  $('execution-error').textContent = result.error ? display(result.error.message || result.error) : display(result.execution?.error?.message || result.execution?.error || '');
  $('contract-revert').hidden = true;
  $('local-measurements').replaceChildren(...rows.map(row => {
    const card = node('article', `standard-query-card${row.measured ? '' : ' query-unavailable'}`), heading = node('div', 'permission-heading');
    heading.append(node('h4', '', `Query ${row.index + 1} · ${titleCase(row.identity.kind)}`), node('span', 'query-status', row.measured ? 'Measured raw values' : 'Unavailable'));
    const details = node('dl', 'permission-details');
    for (const key of ['token', 'contract', 'account', 'owner', 'spender', 'user', 'marketId']) if (row.identity[key]) addDefinition(details, readableKey(key), row.identity[key]);
    card.append(heading, details, node('p', 'query-reference', 'Each query refers to the named account. Contract identity and token units are not verified.'));
    if (row.measured) {
      const table = node('table', 'measurement-table position-measurement-table'), head = node('thead'), header = node('tr'), body = node('tbody');
      for (const label of ['Field / units', 'Before', 'After', 'Change']) { const cell = node('th', '', label); cell.scope = 'col'; header.append(cell); } head.append(header);
      for (const value of row.values) {
        const tr = node('tr'), name = node('th'); name.scope = 'row'; name.append(node('span', 'position-field-name', value.name), node('span', 'position-unit', positionUnitLabel(value.unit))); tr.append(name);
        for (const key of ['beforeRaw', 'afterRaw', 'deltaRaw']) { const cell = node('td'); cell.append(node('strong', '', value[key])); tr.append(cell); } body.append(tr);
      }
      table.append(head, body); card.append(table);
    } else card.append(node('p', 'query-note', row.reason));
    return card;
  }));
  if (!rows.length) $('local-measurements').append(node('p', 'query-note', 'No requested measurements were returned. This does not establish zero balances or no asset changes.'));
  $('warnings-section').hidden = false;
  $('warnings-list').replaceChildren(...[
    'Only the explicit query list is checked. There is no automatic asset discovery, ETH balance summary or total portfolio value.',
    'Before and after refer to this unsigned call from the selected block-end state, not the original historical transaction position.',
    'State proofs and code are checked against the selected header. Consensus, finality, contract identity and complete economic effects are not established.',
    'Network fees and outer transaction signatures are not validated. Execution is not a security verdict.',
  ].map(text => node('li', '', text)));
  const details = $('source-details'), selection = result.source?.blockSelection || {}; details.replaceChildren();
  for (const [label, value] of [['Engine', 'Independent local execution · experimental'], ['Profile', result.source?.profile], ['Requested state', selection.requested || result.apiRequest?.block], ['Resolved block', selection.blockNumber], ['Block hash', selection.blockHash], ['Block binding', result.source?.canonicalStatus], ['Sender', result.apiRequest?.from], ['Recipient', result.apiRequest?.to], ['Native value · wei', result.apiRequest?.value], ['Run ID', result.id]]) addDefinition(details, label, value);
  $('timing').textContent = Number.isFinite(result.timing?.totalMs) ? `${(result.timing.totalMs / 1000).toFixed(2)}s total` : '';
}

function renderStandardResult(result, sequenceContext = null) {
  if (!sequenceContext) beginResult(result, true);
  const stepNumber = sequenceContext ? sequenceContext.step.index + 1 : null;
  state.renderStep = stepNumber;
  $('standard-result').hidden = false;
  const execution = result.execution || {};
  const queries = Array.isArray(result.preview?.queries) ? result.preview.queries : [];
  const measured = queries.filter(standardMeasured).length;
  const positions = standardPositionViews(result), positionsMeasured = positions.filter(standardPositionMeasured).length;
  const nativeRows = Array.isArray(result.preview?.nativeBalances) ? result.preview.nativeBalances : [];
  const nativeMeasured = nativeRows.filter(standardMeasured).length;
  const nativeSelected = nativeSelectionCount(result.nativeEffects, nativeRows);
  const sender = result.apiRequest?.from || result.request?.transaction?.from;
  const automatic = result.preview?.scope === 'observed_queried_accounts' || Boolean(result.discovery);
  const tokenSelectionKnown = queries.length > 0 || !automatic || ['discovered', 'none'].includes(result.discovery?.status);
  $('coverage-label').textContent = stepNumber ? `Step ${stepNumber} checks` : 'Measured checks';
  $('execution-label').textContent = stepNumber ? `Step ${stepNumber} execution` : 'Execution';
  $('result-label').textContent = stepNumber ? `Ethereum sequence · step ${stepNumber}` : 'Ethereum unsigned simulation';
  $('execution-status').textContent = execution.status === 'success' ? 'Completed' : execution.status === 'reverted_or_failed' ? 'Failed / reverted' : 'Unavailable';
  $('execution-status').className = execution.status === 'success' ? 'success' : execution.status === 'reverted_or_failed' ? 'failed' : 'partial';
  $('gas-used').textContent = execution.gasUsed ? `${numberLabel(execution.gasUsed)} gas used · fees not estimated` : 'Gas usage unavailable';
  $('coverage-status').textContent = `ETH ${nativeSelected === null ? '—' : `${nativeMeasured}/${nativeSelected}`} · tokens ${tokenSelectionKnown ? `${measured}/${queries.length}` : '—'}${positions.length ? ` · positions ${positionsMeasured}/${positions.length}` : ''}`;
  $('coverage-status').className = `combined-coverage ${tokenSelectionKnown && nativeSelected !== null && nativeMeasured + measured + positionsMeasured > 0 && nativeMeasured === nativeSelected && measured === queries.length && positionsMeasured === positions.length ? 'success' : 'partial'}`;
  $('coverage-detail').textContent = 'Measured / selected · network fees excluded';
  renderStandardNative(result.nativeEffects, nativeRows, sender);
  renderDiscovery(result.discovery, queries);
  $('execution-error').hidden = !execution.error && !result.measurementFailure;
  $('execution-error').textContent = execution.error ? `Execution error: ${display(execution.error)}` : result.measurementFailure ? `Measurements unavailable: ${display(result.measurementFailure)}` : '';
  $('contract-revert').hidden = !execution.revertReason;
  $('contract-revert').textContent = execution.revertReason ? `Contract-reported reason (untrusted contract output): ${String(execution.revertReason).slice(0, 4096)}` : '';
  const selection = result.source?.blockSelection || sequenceContext?.sequence.source?.blockSelection || {};
  const stateSource = sequenceContext?.step.stateSource || result.source?.stateSource;
  const block = result.block || sequenceContext?.sequence.block;
  const context = $('standard-state-details');
  context.replaceChildren();
  $('standard-state-description').textContent = stepNumber
    ? `${stateSource?.kind === 'initial_block' ? 'This step starts from the selected block’s end state.' : stateSource?.kind === 'after_step' && Number.isInteger(stateSource.stepIndex) ? `This step starts from the simulated state after step ${stateSource.stepIndex + 1}, using the same block context.` : 'The starting state for this step was not established.'} Before and after refer only to step ${stepNumber}. This is not original transaction-position replay.`
    : 'The call starts from the state at the end of the selected block. Choosing a past block does not replay the historical transaction at its original position. Before and after refer to this unsigned simulation.';
  addDefinition(context, 'Requested state', selection.requested ?? result.apiRequest?.block);
  addDefinition(context, 'Resolved block', block?.number ? numberLabel(block.number) : selection.resolvedNumber ? numberLabel(selection.resolvedNumber) : null);
  addDefinition(context, 'Block hash', block?.hash || selection.resolvedHash);
  addDefinition(context, 'Block time', formatTime(block?.timestamp));
  addDefinition(context, 'Block binding', result.canonicalStatus === 'verified' ? 'Checked before and after the simulation' : 'Not verified; before-and-after amounts are unavailable');
  for (const kind of ['balanceOf', 'allowance']) {
    const group = kind === 'balanceOf' ? 'balances' : 'allowances';
    const rows = queries.filter(query => query.kind === kind);
    $(`standard-${group}-section`).hidden = rows.length === 0;
    $(`standard-${group}-count`).textContent = `${rows.filter(standardMeasured).length} / ${rows.length} measured`;
    $(`standard-${group}`).replaceChildren(...rows.map(query => renderStandardQuery(query, sender)));
  }
  $('standard-positions-section').hidden = positions.length === 0;
  $('standard-positions-count').textContent = `${positionsMeasured} / ${positions.length} measured`;
  $('standard-positions').replaceChildren(...positions.map(position => renderStandardPosition(position, sender)));
  $('standard-metadata-note').textContent = queries.length ? 'Amounts are exact token quantities, not prices or dollar valuations. Other accounts, tokens, debts, and permissions may not be included.' : 'No token balance or allowance measurements were returned. ETH checks are shown separately. Missing measurements are not zero balances.';
  const warnings = [...new Set((result.preview?.warnings?.length ? result.preview.warnings : [
    'Only the listed balances and allowances are checked. Other changes may be omitted.',
    'Execution uses a zero base fee without transaction fee settlement or outer signature validation.',
    'These results do not establish that a transaction or spender is safe.',
  ]).map(standardWarning))];
  $('warnings-section').hidden = false;
  $('warnings-list').replaceChildren(...warnings.map(warning => node('li', '', display(warning))));
  const details = $('source-details');
  details.replaceChildren();
  addDefinition(details, 'Network', 'Ethereum · chain 1');
  addDefinition(details, 'Mode', stepNumber ? `Unsigned ordered call · step ${stepNumber}` : 'Unsigned call at block-end state');
  addDefinition(details, 'Sender', sender);
  addDefinition(details, 'Recipient', result.apiRequest?.to || result.request?.transaction?.to);
  addDefinition(details, 'Gas limit', '5,000,000');
  const nativeValue = result.apiRequest?.value;
  addDefinition(details, 'Native value', typeof nativeValue === 'string' && /^(?:0|[1-9][0-9]*)$/.test(nativeValue) ? `${nativeValue} wei` : 'Not available');
  addDefinition(details, 'Network fees', 'Not estimated');
  addDefinition(details, 'Measurement method', result.executionIdentity ? `Separate selected ETH balance, token${positions.length ? ' and explicit position' : ''} checks before and after applying the call’s full state changes` : 'Measurement context not established');
  addDefinition(details, 'Run ID', result.id || sequenceContext?.sequence.id);
  const elapsed = result.timing?.totalMs ?? sequenceContext?.sequence.timing?.totalMs;
  $('timing').textContent = elapsed !== undefined ? `${(elapsed / 1000).toFixed(2)}s ${sequenceContext ? 'sequence total' : 'total'}` : '';
}

function sequenceStepLabel(step) {
  return step.status === 'completed' ? 'Completed' : step.status === 'reverted_or_failed' ? 'Failed / reverted'
    : step.status === 'skipped' ? 'Skipped' : step.result?.execution?.status === 'success' ? 'Executed; state unavailable' : 'Unavailable';
}

function sequenceStepView(sequence, step) {
  if (!step.result || sequence.canonicalStatus === 'verified') return step.result;
  const result = structuredClone(step.result), reason = 'The sequence’s block context was not verified. All measured amounts are withheld.';
  result.canonicalStatus = 'unverified'; result.measurementFailure = reason;
  for (const row of [...(result.preview?.queries || []), ...(result.preview?.nativeBalances || [])]) {
    row.status = 'unavailable'; row.reason = reason;
    for (const key of ['before', 'after', 'delta', 'beforeRaw', 'afterRaw', 'deltaRaw']) delete row[key];
  }
  for (const position of result.preview?.positions || []) {
    position.status = 'unavailable'; position.reason = reason; delete position.rows;
  }
  if (result.nativeEffects) { result.nativeEffects.status = 'unavailable'; result.nativeEffects.reason = reason; if (result.nativeEffects.counts) result.nativeEffects.counts.measured = 0; }
  return result;
}

function renderSequenceStep(sequence, step) {
  for (const entry of state.sequenceStepButtons || []) {
    const selected = entry.index === step.index;
    entry.button.classList.toggle('selected', selected); entry.button.setAttribute('aria-pressed', String(selected));
  }
  const result = sequenceStepView(sequence, step), stepNumber = step.index + 1;
  $('sequence-step-notice').textContent = `Viewing step ${stepNumber}. ${step.reason || (step.status === 'skipped' ? 'An earlier step stopped the sequence; this call was not evaluated.' : 'Amounts below describe this step only.')} The JSON download contains the entire sequence.`;
  if (result) { renderStandardResult(result, { sequence, step }); return; }
  $('standard-result').hidden = true;
  $('result-label').textContent = `Ethereum sequence · step ${stepNumber}`;
  $('execution-label').textContent = `Step ${stepNumber} execution`;
  $('execution-status').textContent = sequenceStepLabel(step); $('execution-status').className = 'partial';
  $('gas-used').textContent = step.status === 'skipped' ? 'Not executed' : 'Execution evidence unavailable';
  $('coverage-label').textContent = `Step ${stepNumber} checks`;
  $('coverage-status').textContent = '—'; $('coverage-status').className = 'partial';
  $('coverage-detail').textContent = 'No measurements; missing amounts are not zero';
  $('execution-error').hidden = true; $('contract-revert').hidden = true; $('warnings-section').hidden = true;
  const details = $('source-details'); details.replaceChildren();
  addDefinition(details, 'Network', 'Ethereum · chain 1'); addDefinition(details, 'Step', stepNumber);
  addDefinition(details, 'Sender', sequence.apiRequest?.from); addDefinition(details, 'Recipient', step.input?.to);
  addDefinition(details, 'Requested state', sequence.source?.blockSelection?.requested ?? sequence.apiRequest?.block);
  addDefinition(details, 'Block hash', sequence.block?.hash || sequence.source?.blockSelection?.resolvedHash);
  addDefinition(details, 'Outcome', sequenceStepLabel(step)); addDefinition(details, 'Reason', step.reason);
  addDefinition(details, 'Network fees', 'Not estimated'); addDefinition(details, 'Run ID', sequence.id);
  $('timing').textContent = '';
}

function renderSequenceResult(result) {
  beginResult(result, true);
  $('sequence-result').hidden = false;
  const sequence = result.sequence || {}, steps = Array.isArray(result.steps) ? result.steps : [];
  $('sequence-result-status').textContent = sequence.status === 'completed' ? 'Completed' : sequence.status === 'stopped' ? 'Stopped' : 'Unavailable';
  const progress = Number.isInteger(sequence.completedSteps) ? `${sequence.completedSteps} of ${steps.length} steps completed. ` : '';
  $('sequence-result-description').textContent = `${progress}${sequence.reason ? `${sequence.reason} ` : ''}Each step uses the simulated state left by the previous successful call. A later failure does not undo an earlier simulated call. This does not guarantee that separate transactions will execute together. Network fees and outer signatures are not modeled.${result.canonicalStatus === 'verified' ? '' : ' The sequence’s block context is unverified; all measured amounts are withheld.'}`;
  state.sequenceStepButtons = [];
  $('sequence-step-list').replaceChildren(...steps.map(step => {
    const item = node('li'), button = node('button', 'sequence-step-button'); button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    button.append(node('strong', '', `Step ${step.index + 1} · ${sequenceStepLabel(step)}`), node('span', 'sequence-step-address', step.input?.to || 'Recipient unavailable'));
    const view = sequenceStepView(result, step);
    if (view) {
      const queries = Array.isArray(view.preview?.queries) ? view.preview.queries : [];
      const positions = standardPositionViews(view);
      const nativeRows = Array.isArray(view.preview?.nativeBalances) ? view.preview.nativeBalances : [];
      const nativeSelected = nativeSelectionCount(view.nativeEffects, nativeRows);
      const automatic = view.preview?.scope === 'observed_queried_accounts' || Boolean(view.discovery);
      const tokenSelected = queries.length > 0 || !automatic || ['discovered', 'none'].includes(view.discovery?.status);
      button.append(node('span', 'sequence-step-counts', `ETH: ${nativeSelected === null ? 'not established' : `${nativeRows.filter(standardMeasured).length}/${nativeSelected} measured`} · token checks: ${tokenSelected ? `${queries.filter(standardMeasured).length}/${queries.length} measured` : 'not established'}${positions.length ? ` · position checks: ${positions.filter(standardPositionMeasured).length}/${positions.length} measured` : ''}`));
      for (const allowance of queries.filter(row => row.kind === 'allowance' && standardMeasured(row))) {
        const metadata = allowance.metadata;
        const amount = field => exactAmount(metadata ? allowance[field] : undefined, allowance[`${field}Raw`], metadata?.symbol);
        button.append(node('span', 'sequence-allowance-summary', `Allowance: ${amount('before')} → ${amount('after')}`));
      }
    } else button.append(node('span', 'sequence-step-counts', step.status === 'skipped' ? 'Not executed · no measurements' : 'No execution or measurement result'));
    button.addEventListener('click', () => renderSequenceStep(result, step));
    state.sequenceStepButtons.push({ index: step.index, button }); item.append(button); return item;
  }));
  const selected = steps.find(step => ['reverted_or_failed', 'unavailable'].includes(step.status)) || [...steps].reverse().find(step => step.result) || steps[0];
  if (selected) renderSequenceStep(result, selected);
  else {
    $('standard-result').hidden = true; $('execution-label').textContent = 'Sequence execution'; $('execution-status').textContent = 'Unavailable'; $('execution-status').className = 'partial';
    $('gas-used').textContent = 'No step execution established'; $('coverage-label').textContent = 'Measured checks'; $('coverage-status').textContent = '—'; $('coverage-status').className = 'partial';
    $('coverage-detail').textContent = 'No step measurements'; $('sequence-step-notice').textContent = 'No step results were returned. Missing results are not successful calls or zero balances.';
    $('execution-error').hidden = true; $('contract-revert').hidden = true; $('warnings-section').hidden = true; $('source-details').replaceChildren(); $('timing').textContent = '';
  }
}

function renderResult(result) {
  beginResult(result);
  const execution = result.execution || {};
  const coverage = result.coverage || {};
  const source = result.source || {};
  const historical = source.mode === 'historical_trace';
  $('result-label').textContent = historical ? 'Historical execution' : 'Unsigned simulation';
  $('execution-status').textContent = titleCase(execution.status);
  $('execution-status').className = execution.status || '';
  $('gas-used').textContent = execution.gasUsed ? `${numberLabel(execution.gasUsed)} gas used` : 'Gas usage unavailable';
  $('coverage-status').textContent = titleCase(coverage.status);
  $('coverage-status').className = coverage.status === 'supported' ? 'success' : 'partial';
  $('coverage-detail').textContent = coverage.status === 'supported' ? 'Recognized protocol operation' : 'See interpretation notes below';
  $('execution-error').hidden = !execution.error;
  $('execution-error').textContent = execution.error || '';
  $('contract-revert').hidden = !execution.revert?.message;
  $('contract-revert').textContent = execution.revert?.message ? `Contract-reported reason (untrusted contract output): ${String(execution.revert.message).slice(0, 4096)}` : '';
  const protocol = result.protocol;
  renderProtocol(protocol, result);
  $('movements-heading').textContent = historical ? 'Historical event-derived asset movements' : 'Event-derived asset movements';
  $('movements-badge').textContent = historical ? 'Original transfer logs' : 'Transfer events';
  $('movements-description').textContent = historical
    ? 'Amounts decoded from the original execution logs. Event totals can include recognized interest and differ from before-and-after balance measurements.'
    : 'Event totals may include recognized interest and differ from the actual change in token balances.';
  renderAssetList('out-assets', result.outAssets, 'transferOut');
  renderAssetList('in-assets', result.inAssets, 'transferIn');
  renderAllowances(result.allowanceChanges, result.permissions, historical);
  renderPermissions(result.permissions, result.allowanceChanges);
  renderBalanceChanges(result.balanceChanges, source, result.affectedBalanceChanges);
  renderAccountEffects(result.accountEffects, historical, result.affectedBalanceChanges);
  renderPositions(result.positionChanges, result);
  renderInterest(result.interestAccruals, protocol);
  const warnings = [...new Set([...(coverage.reasons || []), ...(result.warnings || [])])];
  $('warnings-section').hidden = !warnings.length;
  $('warnings-list').replaceChildren(...warnings.map((warning) => node('li', '', display(warning))));
  const details = $('source-details');
  details.replaceChildren();
  addDefinition(details, 'Mode', historical ? 'Historical execution trace' : 'Unsigned EVM call simulation');
  addDefinition(details, 'Requested state', historical ? 'Original transaction position' : source.requestedBlock || result.request?.block || 'latest');
  addDefinition(details, 'Resolved block', source.blockNumber ? numberLabel(source.blockNumber) : null);
  addDefinition(details, 'Block hash', source.blockHash);
  addDefinition(details, 'Block time', formatTime(source.timestamp));
  addDefinition(details, 'State binding', source.blockBinding);
  addDefinition(details, 'RPC provider', source.provider);
  addDefinition(details, 'Trace method', result.evidence?.traceMethod);
  if (!historical) {
    const validated = [result.balanceChanges, result.allowanceChanges, result.affectedBalanceChanges].some(value => value?.status === 'measured' && value.executionIdentity?.headerContext === 'synthetic_unpriced_basefee_zero');
    addDefinition(details, 'Call environment', validated ? 'Unsigned call with a zero base fee; other block fields checked' : 'Unsigned call; gas price omitted and execution header not validated');
    addDefinition(details, 'Network fees', 'Not estimated');
  }
  if (historical && result.balanceChanges?.status === 'measured' && result.balanceChanges.basis === 'historical_transaction_position_balanceOf') {
    addDefinition(details, 'Balance method', result.balanceChanges.executionIdentity?.method);
    addDefinition(details, 'Balance state', 'Before and after the original transaction, with original block context');
  }
  if (historical && result.allowanceChanges?.status === 'measured' && result.allowanceChanges.basis === 'historical_transaction_position_allowance') {
    addDefinition(details, 'Allowance method', result.allowanceChanges.executionIdentity?.method);
    addDefinition(details, 'Allowance state', 'Before and after the whole original transaction, with original block context');
  }
  addDefinition(details, 'Transaction', source.transactionHash);
  addDefinition(details, 'Run ID', result.id);
  $('timing').textContent = result.timing?.totalMs !== undefined ? `${(result.timing.totalMs / 1000).toFixed(2)}s total` : '';
  $('raw-json').textContent = JSON.stringify(result, null, 2);
}

async function run(mode) {
  if (state.busy) return;
  const standard = ethereumMode();
  const sequence = sequenceMode();
  if (standard && (!(localMode() ? localAvailable() : standardAvailable()) || mode === 'historical_trace')) return;
  if (sequence && !sequenceAvailable()) return;
  if (mode === 'historical_trace' && !state.example?.transactionHash) return;
  if (standard && !sequence) validateWeiField($('value'));
  const calls = sequence ? readSequenceCalls() : undefined;
  if (sequence && !calls) return;
  let queries, context;
  if (standard && !sequence) {
    $('transaction-context').setCustomValidity('');
    try { context = readTransactionContext($('transaction-context').value); }
    catch (error) { $('transaction-context-settings').open = true; $('transaction-context').setCustomValidity(error.message); $('transaction-context').reportValidity(); return; }
  }
  if (standard && manualQueries()) {
    $('standard-queries').setCustomValidity('');
    try { queries = readStandardQueries(); }
    catch (error) {
      $('standard-query-settings').open = true;
      $('standard-queries').setCustomValidity(error.message);
      $('standard-queries').reportValidity();
      return;
    }
  }
  if (mode !== 'historical_trace' && !$('simulation-form').reportValidity()) return;
  clearResult();
  setBusy(true, mode);
  try {
    const fingerprint = requestFingerprint();
    const body = sequence ? { chainId: 1, from: $('from').value.trim(), block: $('block').value.trim(), calls }
      : mode === 'historical_trace' ? { chainId: Number(state.example.request.chainId), transactionHash: state.example.transactionHash } : { chainId: Number($('chain').value), from: $('from').value.trim(), to: $('to').value.trim(), data: $('data').value.trim(), value: $('value').value.trim(), block: $('block').value.trim() };
    if (standard && queries !== undefined) body.queries = queries;
    if (context !== undefined) Object.assign(body, context);
    const result = await request(localMode() ? '/api/evm/local-preview' : sequence ? '/api/evm/simulate-sequence' : standard ? '/api/evm/simulate' : mode === 'historical_trace' ? '/api/replay' : '/api/simulate', body);
    if (fingerprint !== requestFingerprint()) {
      setBusy(false);
      clearResult({ inputsChanged: true });
      return;
    }
    if (localMode()) renderLocalResult(result);
    else if (sequence) renderSequenceResult(result);
    else if (standard) renderStandardResult(result);
    else renderResult(result);
    setBusy(false);
    $('run-status').textContent = localMode() ? 'Local preview returned. Review execution and each requested check separately; unavailable values are not zero.' : sequence
      ? result.sequence?.status === 'completed' ? 'Sequence completed. Select each step to review its balances and allowances. Network fees are excluded.'
        : 'The sequence stopped or could not be established. Review the attempted steps and explicitly skipped calls below.'
      : standard
      ? result.execution?.status === 'success' ? 'Execution completed. Review the ETH balances, token balances and allowances measured below. Network fees are excluded.'
        : result.execution?.status === 'reverted_or_failed' ? 'The call failed or reverted; its state changes were not committed. Before-and-after measurements were not applied. Network fees are not modeled.'
          : 'Execution could not be established. Unavailable amounts are not zero.'
      : result.execution?.status === 'success' ? historicalRunMessage(mode, result) : 'The provider returned an execution failure. Review the error and trace below.';
  } catch (error) {
    setBusy(false);
    $('request-error').hidden = false;
    $('request-error').textContent = `${error.code ? `${error.code}: ` : ''}${error.message}`;
    $('run-status').textContent = mode === 'historical_trace' ? 'No historical execution result was produced. An API error is not an empty asset preview.' : 'No simulation result was produced. An API error is not an empty asset preview.';
  }
}

function historicalRunMessage(mode, result) {
  if (mode !== 'historical_trace') return 'Execution completed. Review the balance, transfer, and permission evidence below.';
  return result.balanceChanges?.status === 'measured' && result.balanceChanges.basis === 'historical_transaction_position_balanceOf'
    ? 'Original EVM execution retrieved. Balances measured at the original transaction position; transfer logs are shown separately.'
    : result.allowanceChanges?.status === 'measured' && result.allowanceChanges.basis === 'historical_transaction_position_allowance'
      ? 'Original EVM execution retrieved. Allowances measured before and after the whole transaction; intermediate requests and events are shown separately.'
      : 'Original EVM execution retrieved. Review the available historical evidence and coverage limits below.';
}

function benchmarkRows(report) {
  for (const key of ['cases', 'results', 'tests', 'checks']) if (Array.isArray(report[key])) return report[key];
  return [];
}

function renderBenchmarks(report) {
  $('benchmark-summary').replaceChildren();
  $('benchmark-cases').replaceChildren();
  $('benchmark-status').replaceChildren();
  $('benchmark-raw-details').hidden = report.status === 'not_run';
  if (report.status === 'not_run') {
    $('benchmark-status').append(node('div', 'benchmark-empty', 'No benchmark report yet. Run the benchmark suite from this project to create the first report.'));
    return;
  }
  $('benchmark-json').textContent = JSON.stringify(report, null, 2);
  const summary = node('div', 'benchmark-summary');
  const rows = benchmarkRows(report);
  const summaryData = report.summary || report.totals || {};
  let displayed = 0;
  for (const [key, value] of Object.entries(summaryData)) {
    if (typeof value === 'object') continue;
    const stat = node('div', 'benchmark-stat');
    stat.append(node('strong', '', display(value)), node('span', '', readableKey(key)));
    summary.append(stat);
    displayed++;
    if (displayed === 6) break;
  }
  if (!displayed) {
    const stat = node('div', 'benchmark-stat');
    stat.append(node('strong', '', rows.length || titleCase(report.status || 'Recorded')), node('span', '', rows.length ? 'Recorded cases' : 'Report status'));
    summary.append(stat);
  }
  $('benchmark-summary').append(summary);
  if (rows.length) {
    const wrap = node('div', 'benchmark-table-wrap');
    const table = node('table', 'benchmark-table');
    const head = node('thead');
    const headRow = node('tr');
    for (const label of ['Case', 'Result', 'Evidence / detail']) headRow.append(node('th', '', label));
    head.append(headRow);
    table.append(head);
    const body = node('tbody');
    for (const row of rows) {
      const tr = node('tr');
      const status = row.status || (row.passed === true || row.pass === true ? 'passed' : row.passed === false || row.pass === false ? 'failed' : 'recorded');
      const statusCell = node('td');
      statusCell.append(node('span', `test-status ${String(status).toLowerCase()}`, titleCase(status)));
      const checkSummary = Array.isArray(row.checks) ? `${row.checks.filter((check) => check.passed).length} / ${row.checks.length} checks passed${row.checks.some((check) => !check.passed) ? `. Failed: ${row.checks.filter((check) => !check.passed).map((check) => check.name).join(', ')}` : ''}` : '';
      const detail = row.description || row.message || row.error || row.notes || row.details || row.expected || [row.kind ? readableKey(row.kind) : null, checkSummary].filter(Boolean).join(' · ');
      tr.append(node('td', '', row.name || row.label || row.id || 'Unnamed case'), statusCell, node('td', '', display(detail)));
      body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    $('benchmark-cases').append(wrap);
  }
  if (report.createdAt || report.timestamp || report.generatedAt) $('benchmark-status').append(node('p', 'section-help', `Report recorded: ${display(report.createdAt || report.timestamp || report.generatedAt)}`));
  if (Array.isArray(report.limitations) && report.limitations.length) {
    const notes = node('section', 'coverage-notes');
    notes.append(node('h3', '', 'What these benchmarks establish'));
    const list = node('ul');
    for (const limitation of report.limitations) list.append(node('li', '', limitation));
    notes.append(list);
    $('benchmark-cases').append(notes);
  }
}

async function loadBenchmarks() {
  $('refresh-benchmarks').disabled = true;
  $('benchmark-status').textContent = 'Loading the latest benchmark report…';
  try { renderBenchmarks(await request('/api/benchmarks')); state.benchmarkLoaded = true; }
  catch (error) { $('benchmark-status').textContent = error.message; }
  finally { $('refresh-benchmarks').disabled = false; }
}

function setView(view) {
  for (const name of ['simulation', 'benchmark']) {
    const active = name === view;
    $(`${name}-view`).hidden = !active;
    $(`${name}-view-button`).classList.toggle('active', active);
    if (active) $(`${name}-view-button`).setAttribute('aria-current', 'page');
    else $(`${name}-view-button`).removeAttribute('aria-current');
  }
  if (view === 'benchmark' && !state.benchmarkLoaded) loadBenchmarks();
}

$('simulation-form').addEventListener('submit', (event) => { event.preventDefault(); run('simulation'); });
$('simulation-form').addEventListener('reset', () => { clearTransactionContexts(); clearResult({ inputsChanged: true }); });
$('replay-button').addEventListener('click', () => run('historical_trace'));
$('example').addEventListener('change', selectExample);
$('chain').addEventListener('change', selectNetwork);
$('ethereum-engine').addEventListener('change', () => {
  if (state.busy) return;
  const wasSequence = $('ethereum-call-mode').value === 'sequence';
  $('ethereum-call-mode').value = 'single';
  $('standard-manual-queries').checked = localMode();
  if (wasSequence) { populateExampleOptions(); selectExample(); }
  else { updateQueryMode(); clearResult({ inputsChanged: true }); }
  setBusy(false);
});
$('ethereum-call-mode').addEventListener('change', () => {
  if (state.busy) return;
  populateExampleOptions(); selectExample(); setBusy(false);
});
$('add-sequence-call').addEventListener('click', () => {
  if (state.busy || !sequenceMode() || state.sequenceDrafts.length >= 4) return;
  state.sequenceDrafts.push(newSequenceDraft()); renderSequenceEditor(); clearResult({ inputsChanged: true });
  state.sequenceControls.at(-1)?.to.focus();
});
for (const id of requestFieldIds) {
  if (id === 'chain' || id === 'ethereum-call-mode' || id === 'ethereum-engine') continue;
  const changed = () => {
    if (id === 'standard-queries') $('standard-queries').setCustomValidity('');
    if (id === 'transaction-context') $('transaction-context').setCustomValidity('');
    if (id === 'value') $('value').setCustomValidity('');
    if (id === 'standard-manual-queries') updateQueryMode();
    if (ethereumMode() && state.example) $('historical-help').textContent = sequenceMode() ? 'The selected example is a starting point. The sequence uses the calls currently shown, in their displayed order, from one selected block-end state.' : manualQueries() ? 'The selected example is a starting point. Simulation uses the fields and manual query list currently shown, at the end of the selected block.' : 'The selected example is a starting point. Simulation uses the fields currently shown and automatically selects checks from the call, at the end of the selected block.';
    clearResult({ inputsChanged: true });
  };
  $(id).addEventListener('input', changed);
  $(id).addEventListener('change', changed);
}
$('simulation-view-button').addEventListener('click', () => setView('simulation'));
$('benchmark-view-button').addEventListener('click', () => setView('benchmark'));
$('refresh-benchmarks').addEventListener('click', loadBenchmarks);
$('copy-json').addEventListener('click', async () => {
  if (!state.result) return;
  try { await navigator.clipboard.writeText(JSON.stringify(state.result, null, 2)); $('copy-json').textContent = 'Copied'; }
  catch { $('copy-json').textContent = 'Select JSON to copy'; }
  setTimeout(() => { $('copy-json').textContent = 'Copy JSON'; }, 2000);
});
$('download-json').addEventListener('click', () => {
  if (!state.result) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(state.result, null, 2) + '\n'], { type: 'application/json' }));
  const link = node('a');
  link.href = url;
  link.download = `transaction-lab-${String(state.result.id || Date.now()).replace(/[^a-z0-9_-]/gi, '').slice(0, 80)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

async function initialize() {
  try {
    state.config = await request('/api/config');
    const chains = state.config.chains || [];
    const choices = chains.length ? [...chains] : [{ name: 'HyperEVM', chainId: 999 }];
    if ((state.config.standardEvm || state.config.localEvm) && !choices.some(chain => Number(chain.chainId) === 1)) choices.push({ name: 'Ethereum · experimental', chainId: 1 });
    $('chain').replaceChildren(...choices.map((chain) => { const option = node('option', '', `${chain.name} · ${chain.chainId}`); option.value = chain.chainId; return option; }));
    selectNetwork({ initial: true });
    if (typeof state.config.projectStatus === 'string') $('project-status').textContent = state.config.projectStatus;
  } catch (error) {
    $('example-description').textContent = 'Examples unavailable. Custom transactions can still be entered.';
    $('request-error').hidden = false;
    $('request-error').textContent = `Could not load workspace configuration: ${error.message}`;
  }
}

$('standard-query-formats').replaceChildren(positionQueryHelp());
$('transaction-context-help').replaceChildren(transactionContextHelp());
clearResult();
initialize();
