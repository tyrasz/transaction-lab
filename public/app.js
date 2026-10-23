const $ = (id) => document.getElementById(id);
const state = { config: null, example: null, result: null, busy: false, benchmarkLoaded: false };
const requestFieldIds = ['chain', 'from', 'to', 'data', 'value', 'block'];

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
function formatTime(value) { if (!value) return null; const date = new Date(typeof value === 'string' && !/^\d+$/.test(value) ? value : Number(value) * 1000); return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().replace('T', ' ').replace('.000Z', ' UTC'); }

async function request(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 65000);
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
  $('simulate-button').disabled = busy;
  $('replay-button').disabled = busy;
  $('example').disabled = busy;
  for (const id of requestFieldIds) $(id).disabled = busy;
  document.querySelector('.results-panel').setAttribute('aria-busy', String(busy));
  $('run-status').classList.toggle('loading', busy);
  $('run-status').textContent = busy ? mode === 'historical_trace' ? 'Retrieving the original execution trace and decoding its events…' : 'Pinning the block, executing the call, and decoding token events…' : '';
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
  $('run-status').textContent = inputsChanged ? 'Inputs changed. Run a new simulation or inspect the selected historical transaction again.' : '';
  $('request-error').hidden = true;
}

function requestFingerprint() {
  return JSON.stringify({ fields: requestFieldIds.map(id => $(id).value), exampleId: state.example?.id, transactionHash: state.example?.transactionHash });
}

function selectExample({ initial = false } = {}) {
  state.example = state.config?.examples?.find((example) => example.id === $('example').value) || null;
  const example = state.example;
  if (example) {
    const transaction = example.request || {};
    for (const field of ['chain', 'from', 'to', 'data', 'value']) $(field).value = transaction[field === 'chain' ? 'chainId' : field] ?? (field === 'data' ? '0x' : field === 'value' ? '0' : '');
    $('block').value = 'latest';
  }
  $('example-description').textContent = example?.description || (example ? 'Original public transaction inputs. Simulating uses the requested state block.' : 'Enter public transaction inputs to inspect an unsigned call.');
  $('replay-button').hidden = !example?.transactionHash;
  $('historical-help').hidden = !example?.transactionHash;
  $('historical-help').textContent = example?.transactionHash ? `Historical inspection uses the original transaction ${example.transactionHash.slice(0, 12)}… and its original block, independent of the fields above.` : '';
  clearResult({ inputsChanged: !initial });
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
    : pair.afterKind === 'zero' ? 'Zero allowance unchanged · no-op' : 'Allowance unchanged';
  if (pair.changed !== true) return 'Allowance change not established';
  if (pair.afterKind === 'zero') return 'Allowance reduced to zero';
  if (pair.beforeKind === 'zero') return pair.afterKind === 'uint256_max' ? 'New maximum allowance' : 'New bounded allowance';
  if (pair.afterKind === 'uint256_max') return 'Allowance increased to maximum';
  if (pair.beforeKind === 'uint256_max') return 'Maximum allowance replaced with a bounded amount';
  const direction = rawDirection(pair.deltaRaw);
  return direction === 'positive' ? 'Allowance increased' : direction === 'negative' ? 'Allowance reduced' : 'Allowance changed';
}

function renderAllowances(changes, permissions) {
  const relevant = permissions?.observations?.length || permissions?.findings?.length;
  $('allowances-section').hidden = !changes || (changes.status === 'not_applicable' && !relevant);
  $('allowance-pairs').replaceChildren();
  $('allowance-warnings').replaceChildren();
  if (!changes) return;
  const measured = changes.status === 'measured';
  $('allowances-section').classList.toggle('measured', measured);
  $('allowances-badge').textContent = measured ? 'Before / after' : titleCase(changes.status);
  $('allowances-description').textContent = measured
    ? 'Allowance values read before and after the entire simulated transaction. Measurements apply only to the token, owner, and spender pairs below. Spender trustworthiness is not assessed.'
    : changes.status === 'not_applicable'
      ? 'Allowance measurement does not apply to this execution. Requests and emitted events do not establish final allowance state.'
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

function renderBalanceChanges(changes) {
  $('balances-section').hidden = !changes;
  for (const id of ['balance-assets', 'balance-debts', 'balance-custody']) $(id).replaceChildren();
  $('balance-debts-group').hidden = true;
  $('balance-custody-group').hidden = true;
  $('balance-warnings').replaceChildren();
  if (!changes) return;
  const measured = changes.status === 'measured';
  $('balances-section').classList.toggle('measured', measured);
  $('balances-badge').textContent = measured ? 'Before / after' : titleCase(changes.status);
  $('balances-description').textContent = measured
    ? 'Token balances read before and after the simulated call, independently of its transfer events.'
    : changes.status === 'not_applicable'
      ? 'Balance measurement does not apply to this execution mode. Event evidence remains available below.'
      : 'Before-and-after balances could not be measured. No zero balance change is inferred from missing data.';
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
    ? 'Approval requests and emitted events are shown separately. Final simulated allowances are measured only for the exact pairs identified above. Spender reputation and general transaction security remain not assessed.'
    : 'Approval requests and emitted events are shown separately. Final allowances are not measured for these observations. Spender reputation and general transaction security remain not assessed.';
  for (const finding of findings) {
    const card = node('div', 'permission-finding');
    const label = finding.code === 'MAX_UINT256_APPROVAL_EVENT' ? 'Maximum allowance reported in an event'
      : finding.code === 'MAX_UINT256_APPROVAL_REQUEST' ? 'Maximum allowance requested'
      : finding.code === 'APPROVAL_EVENT_MISMATCH' ? 'Request and event do not match'
      : 'Approval evidence to review';
    const measured = measuredAllowance(allowanceChanges, finding);
    let message = finding.message || 'Review the recorded permission evidence.';
    if (measured && finding.code === 'MAX_UINT256_APPROVAL_REQUEST') message = `The call requested the maximum uint256 allowance for spender ${finding.spender}, but no matching Approval event was observed. The final simulated allowance for this token, owner, and spender was measured separately. Spender trustworthiness is not assessed.`;
    card.append(node('strong', '', label), node('p', '', message));
    if (measured) card.append(node('p', 'measured-permission-note', `${allowanceChangeLabel(measured)}. Measured after: ${exactAmount(measured.after, measured.afterRaw, measured.asset?.symbol)}.`));
    $('permission-findings').append(card);
  }
  for (const observation of observations) {
    const card = node('div', 'permission-observation');
    const requested = observation.kind === 'approval_request';
    const emitted = observation.kind === 'approval_event';
    const verified = observation.tokenVerified === true && (requested || emitted);
    const heading = node('div', 'permission-heading');
    const title = requested ? 'Requested approval' : emitted ? 'Emitted Approval event' : 'Unverified permission signature';
    heading.append(node('h4', '', title), node('span', 'basis-badge', verified ? observation.asset?.symbol || 'Configured token' : 'Unverified contract'));
    card.append(heading);
    const details = node('dl', 'permission-details');
    addDefinition(details, 'Token / contract', observation.asset?.address || observation.contract);
    if (verified) {
      const measured = measuredAllowance(allowanceChanges, observation);
      const kind = observation.allowanceKind === 'uint256_max' ? 'Maximum uint256 (commonly called unlimited)'
        : observation.allowanceKind === 'revoke' ? 'Revoke · zero allowance' : 'Bounded amount';
      addDefinition(details, 'Allowance type', kind);
      addDefinition(details, 'Owner', observation.owner);
      addDefinition(details, 'Spender', observation.spender);
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
          : observation.returnStatus ? readableKey(observation.returnStatus) : null;
        addDefinition(details, 'Call return', returned);
      } else addDefinition(details, 'Request correlation', observation.matchedRequestIds?.length
        ? 'Matches observed approve calldata' : 'No matching approve request identified');
      addDefinition(details, 'Final allowance', measured
        ? `${exactAmount(measured.after, measured.afterRaw, measured.asset?.symbol)} · measured after the whole simulated transaction`
        : 'Not measured for this token, owner, and spender pair');
    } else {
      addDefinition(details, 'Selector / signature', observation.selector || observation.signature);
      card.append(node('p', 'permission-unverified', 'ERC20 ownership, spender, and allowance semantics are not inferred from an unverified contract.'));
    }
    addDefinition(details, 'Evidence', observation.basis ? readableKey(observation.basis) : null);
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

function renderResult(result) {
  state.result = result;
  $('copy-json').disabled = false;
  $('download-json').disabled = false;
  $('empty-state').hidden = true;
  $('result-content').hidden = false;
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
  renderAssetList('out-assets', result.outAssets, 'transferOut');
  renderAssetList('in-assets', result.inAssets, 'transferIn');
  renderAllowances(result.allowanceChanges, result.permissions);
  renderPermissions(result.permissions, result.allowanceChanges);
  renderBalanceChanges(result.balanceChanges);
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
  addDefinition(details, 'Transaction', source.transactionHash);
  addDefinition(details, 'Run ID', result.id);
  $('timing').textContent = result.timing?.totalMs !== undefined ? `${(result.timing.totalMs / 1000).toFixed(2)}s total` : '';
  $('raw-json').textContent = JSON.stringify(result, null, 2);
}

async function run(mode) {
  if (state.busy) return;
  if (mode === 'historical_trace' && !state.example?.transactionHash) return;
  if (mode !== 'historical_trace' && !$('simulation-form').reportValidity()) return;
  clearResult();
  setBusy(true, mode);
  try {
    const fingerprint = requestFingerprint();
    const body = mode === 'historical_trace' ? { chainId: Number(state.example.request.chainId), transactionHash: state.example.transactionHash } : { chainId: Number($('chain').value), from: $('from').value.trim(), to: $('to').value.trim(), data: $('data').value.trim(), value: $('value').value.trim(), block: $('block').value.trim() };
    const result = await request(mode === 'historical_trace' ? '/api/replay' : '/api/simulate', body);
    if (fingerprint !== requestFingerprint()) {
      setBusy(false);
      clearResult({ inputsChanged: true });
      return;
    }
    renderResult(result);
    setBusy(false);
    $('run-status').textContent = result.execution?.status === 'success' ? historicalRunMessage(mode) : 'The provider returned an execution failure. Review the error and trace below.';
  } catch (error) {
    setBusy(false);
    $('request-error').hidden = false;
    $('request-error').textContent = `${error.code ? `${error.code}: ` : ''}${error.message}`;
    $('run-status').textContent = 'No simulation result was produced. An API error is not an empty asset preview.';
  }
}

function historicalRunMessage(mode) { return mode === 'historical_trace' ? 'Original EVM execution retrieved. Later cross-system effects may require separate evidence.' : 'Execution completed. Review the balance, transfer, and permission evidence below.'; }

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
for (const id of requestFieldIds) {
  $(id).addEventListener('input', () => clearResult({ inputsChanged: true }));
  $(id).addEventListener('change', () => clearResult({ inputsChanged: true }));
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
    if (chains.length) $('chain').replaceChildren(...chains.map((chain) => { const option = node('option', '', `${chain.name} · ${chain.chainId}`); option.value = chain.chainId; return option; }));
    for (const example of state.config.examples || []) { const option = node('option', '', example.label || example.id); option.value = example.id; $('example').append(option); }
    if (state.config.examples?.length) $('example').value = state.config.examples[0].id;
    selectExample({ initial: true });
    if (typeof state.config.projectStatus === 'string') $('project-status').textContent = state.config.projectStatus;
  } catch (error) {
    $('example-description').textContent = 'Examples unavailable. Custom transactions can still be entered.';
    $('request-error').hidden = false;
    $('request-error').textContent = `Could not load workspace configuration: ${error.message}`;
  }
}

clearResult();
initialize();
