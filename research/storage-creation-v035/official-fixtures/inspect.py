"""Static JSON and bytecode declaration inspection; imports/executes no fixture or VM."""
from pathlib import Path
import collections
import hashlib
import json

BASE = Path(__file__).resolve().parent
ACQ = json.loads((BASE / 'acquisition-result.json').read_text())
assert ACQ['status'] == 'complete' and ACQ['targetExecution'] is False

def sha(data):
    return hashlib.sha256(data).hexdigest()

def disassemble(code):
    data = bytes.fromhex(code.removeprefix('0x'))
    rows, pc = [], 0
    while pc < len(data):
        opcode = data[pc]
        size = opcode - 0x5f if 0x60 <= opcode <= 0x7f else 0
        assert pc + 1 + size <= len(data)
        rows.append({'pc': pc, 'opcode': hex(opcode), 'immediate': data[pc+1:pc+1+size].hex()})
        pc += 1 + size
    return rows

rows = []
for record in ACQ['files']:
    raw = (BASE / record['path']).read_bytes()
    assert sha(raw) == record['sha256'] and len(raw) == record['bytes']
    fixtures = json.loads(raw)
    for fixture_id, fixture in fixtures.items():
        pre, tx = fixture['pre'], fixture['transaction']
        parent = tx['to']
        instructions = disassemble(pre[parent]['code'])
        push_words = [bytes.fromhex(i['immediate']) for i in instructions if i['opcode'] == '0x7f']
        assert len(push_words) == 2
        # Static extraction of the two literal MSTORE payloads declared in the filler.
        initcode = b''.join(push_words)[:38]
        init_instructions = disassemble('0x' + initcode.hex())
        for fork, posts in fixture['post'].items():
            for post_index, post in enumerate(posts):
                state = post['state']
                parent_state = state[parent]
                created = parent_state['storage']['0x01']
                stored_accounts = {a: v['storage'] for a, v in pre.items() if v.get('storage')}
                row = {
                    'fixtureFile': record['path'], 'fixtureFileSha256': record['sha256'],
                    'id': fixture_id, 'fork': fork, 'postIndex': post_index,
                    'indexes': post['indexes'], 'metadata': fixture['_info'],
                    'env': fixture['env'], 'config': fixture.get('config'),
                    'pre': pre, 'preAccountCount': len(pre),
                    'preAccountsWithNonemptyStorage': stored_accounts,
                    'transaction': {k: v for k, v in tx.items() if k != 'secretKey'},
                    'publicFixtureSigningKeyPresentInUnmodifiedRawInput': 'secretKey' in tx,
                    'parentAddress': parent, 'parentDisassembly': instructions,
                    'parentCREATECount': sum(i['opcode'] == '0xf0' for i in instructions),
                    'parentCREATE2Count': sum(i['opcode'] == '0xf5' for i in instructions),
                    'parentCALLCount': sum(i['opcode'] == '0xf1' for i in instructions),
                    'initcodeHexFromLiteralMstoreWords': '0x' + initcode.hex(),
                    'initcodeDisassembly': init_instructions,
                    'createdAddressFromOfficialExpectedParentStorage': created,
                    'createdAddressPresentInPre': created in pre,
                    'officialExpectedCreatedAccount': state[created],
                    'officialExpectedParentStorage': parent_state['storage'],
                    'officialExpectedStateRoot': post['hash'],
                    'officialExpectedLogsHash': post['logs'],
                    'officialExpectedReceipt': post['receipt'],
                    'officialExpectedPostState': state,
                    'officialTransactionBytes': post['txbytes'],
                    'directPreexistingStorageCreationCoverage': False,
                    'targetExecuted': False,
                    'expectedRootIndependentlyRecomputed': False,
                }
                assert not stored_accounts and created not in pre
                assert row['parentCREATECount'] == 1 and row['parentCREATE2Count'] == 0
                assert state[created]['code'] == '0x' and state[created]['nonce'] == '0x01'
                assert state[created]['storage'] == {'0x00': '0x0c'}
                rows.append(row)
rows.sort(key=lambda r: r['id'])
source = BASE / 'test_create_empty_contract_with_storage.py'
source_bytes = source.read_bytes()
source_record = {
    'url': json.loads((BASE / 'filler-acquisition-plan.json').read_text())['url'],
    'bytes': len(source_bytes), 'sha256': sha(source_bytes),
    'gitBlobSha1': hashlib.sha1(f'blob {len(source_bytes)}\0'.encode() + source_bytes).hexdigest(),
    'reference': 'Fixture _info.url at pinned source commit e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e',
    'importedOrExecuted': False,
}
license_record = json.loads((BASE / 'license-provenance.json').read_text())
assert sha((BASE / 'LICENSE.execution-specs.md').read_bytes()) == license_record['sha256']
assert sha((BASE / 'license-source-tree.json').read_bytes()) == license_record['sourceTreeSha256']
report = {
    'scope': 'Static inspection of all selected fixture declarations and their pinned filler source. No target execution.',
    'counts': {'files': len(ACQ['files']), 'fixtureIds': len(rows), 'postVectors': len(rows),
        'perFork': dict(collections.Counter(r['fork'] for r in rows)),
        'preAccountsWithNonemptyStorageAcrossRows': sum(len(r['preAccountsWithNonemptyStorage']) for r in rows),
        'createdAddressAlreadyInPre': sum(r['createdAddressPresentInPre'] for r in rows),
        'topLevelCreationTransactions': sum(not r['transaction'].get('to') for r in rows),
        'parentCREATECount': sum(r['parentCREATECount'] for r in rows),
        'parentCREATE2Count': sum(r['parentCREATE2Count'] for r in rows),
        'directPreexistingStorageCreationVectors': 0,
        'targetExecutions': 0},
    'conclusion': 'All 15 vectors create a new codeless account with freshly written storage; none attempts creation at an address with preexisting storage. Preserve as controls, not evidence for preexisting-storage creation collision/reset behavior.',
    'source': source_record, 'licenseEvidenceChecked': True,
    'officialExpectedRoots': {r['id']: r['officialExpectedStateRoot'] for r in rows},
    'rows': rows,
}
(BASE / 'filler-provenance.json').write_text(json.dumps(source_record, indent=2) + '\n')
(BASE / 'structural-report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report['counts'], indent=2))
print(report['conclusion'])
