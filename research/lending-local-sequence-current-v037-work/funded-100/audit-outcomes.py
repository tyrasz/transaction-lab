"""Saved bytes only; Python standard library, no client/API/VM imports or network."""
import base64
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CAP = ROOT / 'research/lending-local-sequence-current-v037/capture-funded-001'
INTENT = '764b3bc67d9f27693513294bc7721345685d9fc067f9b915c63020013917b7c9'
PLAN = '67fee713c49a295074152edf4aab9fd7150e3d6edd40b452f2f64c377e1e9985'
MANIFEST = '02802ff6b0fae693fc405ef39fbaa366f3f1af658b1aa6c3d19032671f3eda2a'
sha = lambda b: hashlib.sha256(b).hexdigest()

def pairs(items):
    out = {}
    for k, v in items:
        assert k not in out, 'Duplicate JSON key'
        out[k] = v
    return out

def parse(b):
    return json.loads(b, object_pairs_hook=pairs)

def load(name):
    return parse((CAP / name).read_bytes())

def uint(value):
    assert isinstance(value, str) and value.isdecimal() and (value == '0' or not value.startswith('0'))
    n = int(value)
    assert 0 <= n < 2**256
    return n

def abi_words(data, widths):
    assert isinstance(data, str) and data.startswith('0x') and len(data) == 2 + 64 * len(widths)
    assert all(c in '0123456789abcdef' for c in data[2:])
    values = [int(data[2 + i*64:66 + i*64], 16) for i in range(len(widths))]
    assert all(v < 2**width for v, width in zip(values, widths))
    return values

def query_schema(descriptor):
    if 'kind' not in descriptor:
        d = descriptor['data']
        assert d[:10] in ('0x70a08231', '0xdd62ed3e')
        names = ['allowance' if d[:10] == '0xdd62ed3e' else 'balance']
        for i in range(2 if names == ['allowance'] else 1):
            assert d[10+i*64:34+i*64] == '0'*24
        assert len(d) == (138 if names == ['allowance'] else 74)
        return descriptor, names, [256]
    word = descriptor['user'][2:].rjust(64, '0')
    if descriptor['kind'] == 'aave_v3_user_account_data':
        return {'to': descriptor['contract'], 'data': '0xbf92857c'+word}, ['totalCollateralBase', 'totalDebtBase', 'availableBorrowsBase', 'currentLiquidationThreshold', 'ltv', 'healthFactor'], [256]*6
    assert descriptor['kind'] == 'morpho_blue_position'
    return {'to': descriptor['contract'], 'data': '0x93c52062'+descriptor['marketId'][2:]+word}, ['supplyShares', 'borrowShares', 'collateral'], [256, 128, 128]

def projected(rows):
    out = []
    for r in rows:
        before, after = uint(r['beforeRaw']), uint(r['afterRaw'])
        assert str(after-before) == r['deltaRaw']
        out.append({k: r[k] for k in ('name', 'beforeRaw', 'afterRaw', 'deltaRaw')})
    return out

manifest_bytes = (CAP / 'manifest.json').read_bytes()
assert sha(manifest_bytes) == MANIFEST
manifest = parse(manifest_bytes)
assert manifest['intentSha256'] == INTENT and manifest['planSha256'] == PLAN
assert sha((CAP/'intent.json').read_bytes()) == INTENT and sha((CAP/'plan.json').read_bytes()) == PLAN
entries = {r['path']: r for r in manifest['files']}
assert len(entries) == len(manifest['files'])
assert set(str(p.relative_to(CAP)) for p in CAP.rglob('*') if p.is_file() or p.is_symlink()) == set(entries) | {'manifest.json'}
hashed_bytes = 0
for name, row in entries.items():
    p = CAP/name
    if row['kind'] == 'symlink':
        assert p.is_symlink() and str(p.readlink()) == row['target']
        continue
    assert row['kind'] == 'file' and not p.is_symlink() and p.stat().st_size == row['bytes']
    digest = hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda: f.read(1024*1024), b''):
            digest.update(chunk)
    assert digest.hexdigest() == row['sha256'], name
    hashed_bytes += row['bytes']
ledger = load('write-ledger.json')
assert [{k:v for k,v in row.items() if k != 'origin'} for row in ledger['files']] == [r for r in manifest['files'] if r['path'] != 'write-ledger.json']
intent, plan, result = load('intent.json'), load('plan.json'), load('results.json')
assert intent['profile'] == plan['profile'] == 'selected_100_usdc_v1'
assert result['evidenceUsable'] is True and result['fatal'] is None
comparison_path = Path(__file__).with_name('saved-comparison-first.json')
comparison_bytes = comparison_path.read_bytes()
comparison = parse(comparison_bytes)
assert comparison['intentSha256'] == INTENT and comparison['manifestSha256'] == MANIFEST and comparison['planSha256'] == PLAN
assert comparison['evidenceUsable'] is True
findings, raw_wire_count, joined_evidence_count = [], 0, 0
independent_original_channels, query_channels = [], []

def wire_index(kind, number, envelope):
    global raw_wire_count
    rows = {}
    directory = CAP/kind/number/'wire'
    for p in sorted(directory.glob('*.json')):
        w = parse(p.read_bytes()); raw = base64.b64decode(w['rawBase64'], validate=True)
        assert w['url'] == 'https://eth.drpc.org' and w['transport']['complete'] is True
        assert len(raw) == w['transport']['retainedBytes'] == w['transport']['observedBytes']
        assert sha(raw) == w['transport']['retainedSha256'] == w['transport']['observedSha256']
        assert sha(w['requestText'].encode()) == w['requestSha256'] and len(w['requestText'].encode()) == w['requestBytes']
        assert w['requestText'] not in rows
        rows[w['requestText']] = (w, raw, str(p.relative_to(CAP)))
    assert len(rows) == envelope['captureUsage']['calls'] == len(envelope['rpcEvidence'])
    for client in envelope['rpcEvidence']:
        w, raw, _ = rows[client['requestText']]
        assert client['request'] == parse(w['requestText'])
        assert client['responseText'].encode() == raw and client['transport']['responseSha256'] == sha(raw)
        assert client['transport']['complete'] is True
    raw_wire_count += len(rows)
    return rows

def join(evidence, envelope, wires):
    global joined_evidence_count
    request = evidence.get('request', {'method': evidence.get('method'), 'params': evidence.get('params')})
    matches = []
    for c in envelope['rpcEvidence']:
        if c['request']['method'] != request['method'] or c['request']['params'] != request['params']:
            continue
        w, raw, name = wires[c['requestText']]
        response = parse(raw)
        if response.get('result') == evidence['result'] and 'error' not in response:
            assert response['id'] == c['request']['id'] and response['jsonrpc'] == '2.0'
            matches.append(name)
    assert matches, 'Evidence has no exact retained wire'
    joined_evidence_count += 1
    return matches

for i, number in enumerate(['001', '002']):
    declaration = load('inputs/'+number+'.json')
    assert entries['inputs/'+number+'.json']['sha256'] == plan['inputs'][i]['sha256']
    assert declaration['id'] == comparison['rows'][i]['id']
    envelopes = {k: load(k+'/'+number+'/report.json') for k in ['local', 'provider']}
    wires = {k: wire_index(k, number, envelopes[k]) for k in envelopes}
    for kind, e in envelopes.items():
        assert e['status'] == 'returned' and e['error'] is None and e['sourceUnchanged'] is True
        assert e['report']['apiRequest'] == declaration[kind+'Input']
        assert e['drain']['rpc']['complete'] and e['drain']['capture']['complete'] and e['drain']['childClosure']
    local, provider = envelopes['local']['report'], envelopes['provider']['report']
    core = local['attempt']['sequence']
    assert core['headerVerification']['blockHash'] == declaration['header']['hash']
    for evidence in core['inputEvidence']:
        if 'result' in evidence:
            join(evidence, envelopes['local'], wires['local'])
    observed = {'id': declaration['id'], 'header': {k:declaration['header'][k] for k in ['hash','number','stateRoot']}, 'sender': declaration['from'], 'steps': []}
    previous = {}
    for position in range(3):
        cs, ps = core['steps'][position], provider['steps'][position]
        saved = comparison['rows'][i]['steps'][position]
        assert cs['index'] == ps['index'] == saved['index'] == position
        call = declaration['localInput']['calls'][position]
        assert cs['request'] == {'from': declaration['from'], **call}
        out, reference = cs['original']['output'], ps['result']
        for evidence in reference['evidence']:
            join(evidence, envelopes['provider'], wires['provider'])
        trace, gas = reference['execution']['trace'], out['gasAccounting']
        assert (trace['from'], trace['to'], trace['input'], int(trace['gas'],16), int(trace['value'],16)) == (declaration['from'], call['to'], call['data'], 5000000, 0)
        charged = uint(gas['beforeRefund']) - uint(gas['appliedRefund']) + uint(gas['floorAdjustment'])
        assert charged == uint(gas['gasUsed']) and 0 <= charged <= 5000000
        assert uint(reference['execution']['gasUsed']) == int(trace['gasUsed'],16)
        status = 'success' if out['execution']['status'] == 'success' else 'reverted_or_failed'
        assert reference['execution']['status'] == ('reverted_or_failed' if 'error' in trace else 'success')
        assert reference['execution']['returnData'] == trace.get('output', '0x')
        independent = {'executionStatus': status == reference['execution']['status'], 'returnData': out['execution']['returnData'] == trace.get('output','0x'), 'chargedGas': charged == int(trace['gasUsed'],16)}
        for channel, value in independent.items():
            assert saved['original']['channels'][channel] is value
            independent_original_channels.append(value)
        step = {'index': position, 'operation': declaration['steps'][position]['operation'], 'localStatus': out['execution']['status'], 'providerStatus': reference['execution']['status'], 'localChargedGas': str(charged), 'providerChargedGas': reference['execution']['gasUsed'], 'independentChannels': independent, 'queries': []}
        for qi, role in enumerate(declaration['queryRoles']):
            lm, pm = cs['measurements'][qi], reference['measurements'][qi]
            row = {'index': qi, 'id': role['id'], 'subject': role['subject'], 'channels': {'beforeReturnData':None,'afterReturnData':None,'rawValues':None}, 'error': None}
            try:
                assert lm['status'] == pm['status'] == 'measured'
                query, names, widths = query_schema(role['descriptor'])
                assert query == lm['query'] == pm['query'] and lm['descriptor'] == role['descriptor']
                local_words, provider_words, links = {}, {}, {}
                for side in ['before', 'after']:
                    lo = lm[side]['output']; lt = lo['trace']
                    assert lm[side]['status'] == 'measured' and lo['execution']['status'] == 'success'
                    assert (lt['from'], lt['to'], lt['input']) == (declaration['from'], query['to'], query['data'])
                    ld = lo['execution']['returnData']; local_words[side] = abi_words(ld, widths)
                    qref = [x for x in pm['queryEvidence'] if x['state'] == side]; assert len(qref) == 1
                    erows = reference['evidence']
                    te = [x for x in erows if x['id'] == qref[0]['traceEvidenceId']]; me = [x for x in erows if x['id'] == qref[0]['mutationEvidenceId']]
                    assert len(te) == len(me) == 1; te, me = te[0], me[0]
                    assert te['method'] == me['method'] == 'debug_traceCall'
                    assert te['params'][0] == {'from':declaration['from'], **query, 'value':'0x0', 'gas':'0x493e0'}
                    assert te['params'][1] == {'blockHash':declaration['header']['hash'], 'requireCanonical':True}
                    assert me['params'][:2] == te['params'][:2]
                    assert te['params'][2]['tracer'] == 'callTracer' and me['params'][2]['tracer'] == 'prestateTracer'
                    assert te['params'][2].get('stateOverrides') == me['params'][2].get('stateOverrides')
                    assert 'blockOverrides' not in te['params'][2] and 'blockOverrides' not in me['params'][2]
                    tr = te['result']; assert 'error' not in tr and (tr['from'],tr['to'],tr['input'],int(tr['gas'],16)) == (declaration['from'],query['to'],query['data'],300000)
                    pd = tr['output']; provider_words[side] = abi_words(pd, widths)
                    row['channels'][side+'ReturnData'] = ld == pd
                    links[side] = join(te, envelopes['provider'], wires['provider'])
                values = lambda words: [{'name': name, 'beforeRaw': str(words['before'][j]), 'afterRaw': str(words['after'][j]), 'deltaRaw': str(words['after'][j]-words['before'][j])} for j,name in enumerate(names)]
                lv, pv = values(local_words), values(provider_words)
                assert projected(lm['values']) == projected(local['steps'][position]['measurements'][qi]['values']) == lv
                assert projected(pm['rows'] if 'rows' in pm else [{'name':names[0], **pm}]) == pv
                row['channels']['rawValues'] = lv == pv
                assert row['channels'] == saved['queries'][qi]['channels']
                continuity = previous.get(qi)
                if continuity is not None:
                    assert local_words['before'] == continuity['local'] and provider_words['before'] == continuity['provider']
                previous[qi] = {'local':local_words['after'], 'provider':provider_words['after']}
                row.update(localValues=lv, providerValues=pv, providerTraceWires=links, continuityWithPreviousMeasuredStep=continuity is not None)
            except (AssertionError, KeyError, ValueError, TypeError) as error:
                row['channels'] = dict.fromkeys(row['channels']); row['error'] = type(error).__name__+': '+str(error)
            query_channels.extend(row['channels'].values()); step['queries'].append(row)
        observed['steps'].append(step)
    findings.append(observed)

def counts(values):
    return {'matched': sum(v is True for v in values), 'mismatched': sum(v is False for v in values), 'unavailable': sum(v is None for v in values)}

print(json.dumps({'kind':'independent_saved_funded_outcome_audit','intentSha256':INTENT,'planSha256':PLAN,'manifestSha256':MANIFEST,
 'checkerSha256':sha(Path(__file__).read_bytes()),'savedComparisonSha256':sha(comparison_bytes),
 'integrity':{'manifestEntries':len(entries),'manifestFilesRehashed':True,'hashedFileBytes':hashed_bytes,'originalWriteLedgerRowsMatchManifest':True,'rawWiresVerified':raw_wire_count,'evidenceWireJoins':joined_evidence_count},
 'counts':{'independentlyCheckedOriginalChannels':counts(independent_original_channels),'independentlyDecodedQueryChannels':counts(query_channels),'savedAdjudicatorAllChannels':comparison['counts']},
 'cases':findings,'limitations':['No VM/API imports, execution, network, source changes or capture writes.',
 'Proof cryptography, state-overlay composition, ordered-log semantics and process/source semantic gates rely on the archived adjudicator; this audit independently rehashes its saved inputs and checks selected raw joins.',
 'Original independent channels are status, return data and charged gas only; query words, arithmetic, continuity and raw provider trace joins are decoded independently.',
 'Both paths share provider infrastructure. Queries have different gas budgets/scheduling. Aave account-data zeros do not by themselves explain collateral settings; Blue position belongs to the inner vault.',
 'Selected fixed-case evidence does not replace prior failures or establish representative accuracy, complete economic coverage, current funding, HTTP or frontend behavior.'], 'targetsExecuted':0}, indent=2))
