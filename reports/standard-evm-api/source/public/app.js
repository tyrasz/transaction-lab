const $ = (id) => document.getElementById(id);
const state = { config: null, example: null, result: null, busy: false, benchmarkLoaded: false };
const requestFieldIds = ['chain', 'from', 'to', 'data', 'value', 'block', 'standard-queries'];
const ethereumMode = () => $('chain').value === '1';
const standardAvailable = () => state.config?.standardEvm?.available === true;

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
  const timer = setTimeout(() => controller.abort(), url === '/api/evm/simulate' ? 180000 : 65000);
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
    if (error.name === 'AbortError') throw new Error('The provider took too long to respond. Try again in a moment.');
    throw error;
  } finally { clearTimeout(timer); }
}

function setBusy(busy, mode) {
  state.busy = busy;
  $('simulate-button').disabled = busy || (ethereumMode() && !standardAvailable());
  $('replay-button').disabled = busy;
  $('example').disabled = busy;
  for (const id of requestFieldIds) $(id).disabled = busy;
  document.querySelector('.results-panel').setAttribute('aria-busy', String(busy));
  $('run-status').classList.toggle('loading', busy);
  $('run-status').textContent = busy ? mode === 'historical_trace' ? 'Retrieving the original execution trace and checking available historical balance evidence…' : ethereumMode() ? 'Running the unsigned call and checking each requested balance and allowance. This can take a few minutes…' : 'Pinning the block, executing the call, and decoding token events…' : '';
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
  return JSON.stringify({ fields: requestFieldIds.map(id => $(id).value), exampleId: state.example?.id, transactionHash: state.example?.transactionHash });
}

function currentExamples() {
  return ethereumMode() ? state.config?.standardEvm?.examples || []
    : (state.config?.examples || []).filter(example => String(example.request?.chainId) === $('chain').value);
}

function selectExample({ initial = false } = {}) {
  state.example = currentExamples().find((example) => example.id === $('example').value) || null;
  const example = state.example;
  if (example) {
    const transaction = (ethereumMode() ? example.input : example.request) || {};
    for (const field of ['from', 'to', 'data', 'value']) $(field).value = transaction[field] ?? (field === 'data' ? '0x' : field === 'value' ? '0' : '');
    $('block').value = ethereumMode() ? transaction.block || 'latest' : 'latest';
    if (ethereumMode()) $('standard-queries').value = JSON.stringify(transaction.queries || [], null, 2);
  }
  $('example-description').textContent = example?.description || (example ? 'Original public transaction inputs. Simulating uses the requested state block.' : 'Enter public transaction inputs to inspect an unsigned call.');
  $('replay-button').hidden = ethereumMode() || !example?.transactionHash;
  $('historical-help').hidden = ethereumMode() ? !example : !example?.transactionHash;
  $('historical-help').textContent = ethereumMode() && example
    ? 'This example starts at the end of the block before the original deposit. It runs the same calldata against that state; it does not replay the original transaction at its exact position.'
    : example?.transactionHash ? `Historical inspection uses the original transaction ${example.transactionHash.slice(0, 12)}… and its original block, independent of the fields above.` : '';
  $('standard-queries').setCustomValidity('');
  clearResult({ inputsChanged: !initial });
}

function selectNetwork({ initial = false } = {}) {
  const standard = ethereumMode();
  const examples = currentExamples();
  const custom = node('option', '', 'Custom transaction');
  custom.value = '';
  $('example').replaceChildren(custom, ...examples.map(example => {
    const option = node('option', '', example.title || example.label || example.id);
    option.value = example.id;
    return option;
  }));
  $('example').value = examples[0]?.id || '';
  for (const id of ['from', 'to']) $(id).value = '';
  $('data').value = '0x';
  $('value').value = '0';
  $('block').value = 'latest';
  $('standard-queries').value = '[]';
  $('standard-query-settings').hidden = !standard;
  $('standard-query-settings').open = false;
  $('standard-queries').required = standard;
  $('value').readOnly = standard;
  $('value-help').textContent = standard ? 'Ethereum previews currently support zero native value only.' : 'Native token amount as an integer number of wei.';
  $('block-help').textContent = standard
    ? 'Use latest, a hexadecimal block number, or a block hash. Execution starts at the end of that block. Ethereum previews use zero native value and a fixed gas limit.'
    : 'Use latest or a hexadecimal block number. The result records the state used.';
  $('network-heading').textContent = standard ? 'ETHEREUM · CHAIN 1 · EXPERIMENTAL' : 'HYPEREVM · CHAIN 999';
  $('page-description').textContent = standard ? 'Preview an unsigned call and check the selected accounts’ balances and allowances.' : 'Simulate an unsigned call or inspect a historical execution. See the evidence behind each result.';
  $('empty-description').textContent = standard ? 'Choose a deposit example or enter your own inputs. The preview shows before-and-after values for the balances and allowances you request.' : 'Choose an example or enter a transaction. The preview separates execution, token events, and coverage limits.';
  $('network-help').hidden = !standard;
  $('network-help').textContent = standardAvailable() ? 'Experimental Ethereum previews. No connected wallet or signature needed.' : state.config?.standardEvm?.reason || 'Ethereum previews are unavailable in this workspace.';
  $('network-help').classList.toggle('unavailable-note', standard && !standardAvailable());
  selectExample({ initial });
  setBusy(false);
}

function readStandardQueries() {
  let queries;
  try { queries = JSON.parse($('standard-queries').value); }
  catch { throw new Error('Enter a valid JSON query list in Advanced: balances & allowances to check.'); }
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > 8) throw new Error('Add between one and eight balance or allowance queries.');
  for (const query of queries) {
    if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).sort().join() !== 'data,to'
      || typeof query.to !== 'string' || !/^0x[0-9a-f]{40}$/i.test(query.to)
      || typeof query.data !== 'string' || !/^0x(?:70a082310{24}[0-9a-f]{40}|dd62ed3e0{24}[0-9a-f]{40}0{24}[0-9a-f]{40})$/i.test(query.data)) {
      throw new Error('Each query must contain only a token address (to) and a complete balanceOf or allowance call (data).');
    }
  }
  return queries;
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
  article.append(details);
  const table = node('table', 'measurement-table');
  const caption = node('caption', 'sr-only', `${heading} for ${owner || 'the requested account'}`);
  const head = node('thead'), headRow = node('tr'), body = node('tbody'), row = node('tr');
  for (const label of ['Before', 'After', 'Change']) { const th = node('th', '', label); th.scope = 'col'; headRow.append(th); }
  head.append(headRow);
  for (const field of ['before', 'after', 'delta']) {
    const cell = node('td');
    if (measured) {
      const raw = query[`${field}Raw`];
      const formatted = metadata ? query[field] : undefined;
      const amount = field === 'delta' ? signedAmount(formatted, raw) : exactAmount(formatted, raw);
      cell.append(node('strong', '', amount));
      if (formatted !== undefined && formatted !== null) cell.append(node('span', 'raw-amount', `${raw} raw units`));
    } else cell.append(node('span', 'missing-amount', 'Not available'));
    row.append(cell);
  }
  body.append(row);
  table.append(caption, head, body);
  article.append(table);
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

function renderStandardResult(result) {
  beginResult(result, true);
  const execution = result.execution || {};
  const queries = Array.isArray(result.preview?.queries) ? result.preview.queries : [];
  const measured = queries.filter(standardMeasured).length;
  const sender = result.apiRequest?.from || result.request?.transaction?.from;
  $('result-label').textContent = 'Ethereum unsigned simulation';
  $('execution-status').textContent = execution.status === 'success' ? 'Completed' : execution.status === 'reverted_or_failed' ? 'Failed / reverted' : 'Unavailable';
  $('execution-status').className = execution.status === 'success' ? 'success' : execution.status === 'reverted_or_failed' ? 'failed' : 'partial';
  $('gas-used').textContent = execution.gasUsed ? `${numberLabel(execution.gasUsed)} gas used · fees not estimated` : 'Gas usage unavailable';
  $('coverage-status').textContent = `${measured} / ${queries.length} measured`;
  $('coverage-status').className = queries.length && measured === queries.length ? 'success' : 'partial';
  $('coverage-detail').textContent = 'Selected balances and allowances only';
  $('execution-error').hidden = !execution.error && !result.measurementFailure;
  $('execution-error').textContent = execution.error ? `Execution error: ${display(execution.error)}` : result.measurementFailure ? `Measurements unavailable: ${display(result.measurementFailure)}` : '';
  $('contract-revert').hidden = !execution.revertReason;
  $('contract-revert').textContent = execution.revertReason ? `Contract-reported reason (untrusted contract output): ${String(execution.revertReason).slice(0, 4096)}` : '';
  const selection = result.source?.blockSelection || {};
  const context = $('standard-state-details');
  context.replaceChildren();
  $('standard-state-description').textContent = 'The call starts from the state at the end of the selected block. Choosing a past block does not replay the historical transaction at its original position. Before and after refer to this unsigned simulation.';
  addDefinition(context, 'Requested state', selection.requested ?? result.apiRequest?.block);
  addDefinition(context, 'Resolved block', result.block?.number ? numberLabel(result.block.number) : selection.resolvedNumber ? numberLabel(selection.resolvedNumber) : null);
  addDefinition(context, 'Block hash', result.block?.hash || selection.resolvedHash);
  addDefinition(context, 'Block time', formatTime(result.block?.timestamp));
  addDefinition(context, 'Block binding', result.canonicalStatus === 'verified' ? 'Checked before and after the simulation' : 'Not verified; before-and-after amounts are unavailable');
  for (const kind of ['balanceOf', 'allowance']) {
    const group = kind === 'balanceOf' ? 'balances' : 'allowances';
    const rows = queries.filter(query => query.kind === kind);
    $(`standard-${group}-section`).hidden = rows.length === 0;
    $(`standard-${group}-count`).textContent = `${rows.filter(standardMeasured).length} / ${rows.length} measured`;
    $(`standard-${group}`).replaceChildren(...rows.map(query => renderStandardQuery(query, sender)));
  }
  $('standard-metadata-note').textContent = queries.length ? 'Amounts are exact token quantities, not prices or dollar valuations. Other accounts, tokens, debts, and permissions may not be included.' : 'No balance or allowance observations were returned. Missing observations are not zero balances.';
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
  addDefinition(details, 'Mode', 'Unsigned call at block-end state');
  addDefinition(details, 'Sender', sender);
  addDefinition(details, 'Recipient', result.apiRequest?.to || result.request?.transaction?.to);
  addDefinition(details, 'Gas limit', '5,000,000');
  addDefinition(details, 'Native value', '0 wei');
  addDefinition(details, 'Network fees', 'Not estimated');
  addDefinition(details, 'Measurement method', result.executionIdentity ? 'Separate token queries before and after applying the call’s full state changes' : 'Measurement context not established');
  addDefinition(details, 'Run ID', result.id);
  $('timing').textContent = result.timing?.totalMs !== undefined ? `${(result.timing.totalMs / 1000).toFixed(2)}s total` : '';
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
  if (standard && (!standardAvailable() || mode === 'historical_trace')) return;
  if (mode === 'historical_trace' && !state.example?.transactionHash) return;
  let queries;
  if (standard) {
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
    const body = mode === 'historical_trace' ? { chainId: Number(state.example.request.chainId), transactionHash: state.example.transactionHash } : { chainId: Number($('chain').value), from: $('from').value.trim(), to: $('to').value.trim(), data: $('data').value.trim(), value: $('value').value.trim(), block: $('block').value.trim() };
    if (standard) body.queries = queries;
    const result = await request(standard ? '/api/evm/simulate' : mode === 'historical_trace' ? '/api/replay' : '/api/simulate', body);
    if (fingerprint !== requestFingerprint()) {
      setBusy(false);
      clearResult({ inputsChanged: true });
      return;
    }
    if (standard) renderStandardResult(result);
    else renderResult(result);
    setBusy(false);
    $('run-status').textContent = standard
      ? result.execution?.status === 'success' ? 'Execution completed. Review which balances and allowances were measured below.'
        : result.execution?.status === 'reverted_or_failed' ? 'The call failed or reverted. Before-and-after measurements were not applied.'
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
$('replay-button').addEventListener('click', () => run('historical_trace'));
$('example').addEventListener('change', selectExample);
$('chain').addEventListener('change', selectNetwork);
for (const id of requestFieldIds) {
  if (id === 'chain') continue;
  const changed = () => {
    if (id === 'standard-queries') $('standard-queries').setCustomValidity('');
    if (ethereumMode() && state.example) $('historical-help').textContent = 'The selected example is a starting point. Simulation uses the fields and query list currently shown, at the end of the selected block.';
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
    if (state.config.standardEvm && !choices.some(chain => Number(chain.chainId) === 1)) choices.push({ name: 'Ethereum · experimental', chainId: 1 });
    $('chain').replaceChildren(...choices.map((chain) => { const option = node('option', '', `${chain.name} · ${chain.chainId}`); option.value = chain.chainId; return option; }));
    selectNetwork({ initial: true });
    if (typeof state.config.projectStatus === 'string') $('project-status').textContent = state.config.projectStatus;
  } catch (error) {
    $('example-description').textContent = 'Examples unavailable. Custom transactions can still be entered.';
    $('request-error').hidden = false;
    $('request-error').textContent = `Could not load workspace configuration: ${error.message}`;
  }
}

clearResult();
initialize();
