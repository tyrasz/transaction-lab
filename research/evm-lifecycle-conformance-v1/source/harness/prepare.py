#!/usr/bin/env python3
"""Prepare a fixed official lifecycle proposal without executing any vector.

Reads the previously acquired publisher-digest-bound archive. Does not modify
the old acquisition/selection/results or import an EVM/VM execution module.
"""
import gzip
import hashlib
import io
import json
import pathlib
import tarfile
import time

BASE = pathlib.Path(__file__).resolve().parent
ROOT = BASE.parent.parent
ARCHIVE = pathlib.Path('/private/tmp/transaction-lab-execution-fixtures-v21.0.2.tar.gz')
ARCHIVE_SHA = 'e2fa7ea2ea516459f9ab92284b2927892f318f4e1f78ca802cb05a6c3b479ed9'
INDEX = ROOT / 'research/evm-conformance/acquisition/osaka-state-index.json'
PREFIX = 'state_tests/for_osaka/'
EIP = PREFIX + 'cancun/eip6780_selfdestruct/'
# Exact fixture parameter selectors, fixed before reading source fixture bodies.
# No execution result, expected success or replacement enters this selection.
CHOICES = [
    ('root_create_zero', EIP+'selfdestruct/self_destructing_initcode_create_tx.json', 'selfdestruct_contract_initial_balance_0-tx_value_0]'),
    ('root_create_prefunded', EIP+'selfdestruct/self_destructing_initcode_create_tx.json', 'selfdestruct_contract_initial_balance_100000-tx_value_100000]'),
    ('create_then_delete', EIP+'selfdestruct/create_selfdestruct_same_tx.json', 'selfdestruct_contract_initial_balance_0-single_call-create_opcode_CREATE]'),
    ('create2_self_burn', EIP+'selfdestruct/create_selfdestruct_same_tx.json', 'selfdestruct_contract_initial_balance_100000-single_call_self-create_opcode_CREATE2]'),
    ('clear_nonce_storage_other', EIP+'selfdestruct_finalization/selfdestruct_clears_nonce_and_storage.json', 'nonce_and_storage-funded-other]'),
    ('clear_nonce_storage_self', EIP+'selfdestruct_finalization/selfdestruct_clears_nonce_and_storage.json', 'nonce_and_storage-funded-self]'),
    ('reverted_inner', EIP+'selfdestruct_revert/selfdestruct_created_in_same_tx_with_revert.json', 'no_outer_selfdestruct-same_tx]'),
    ('reverted_inner_then_outer', EIP+'selfdestruct_revert/selfdestruct_created_in_same_tx_with_revert.json', 'outer_selfdestruct_after_inner_call-same_tx]'),
    ('callcode_context', EIP+'selfdestruct_finalization/selfdestruct_in_delegate_context.json', 'funded-other-call_opcode_CALLCODE]'),
    ('delegate_context', EIP+'selfdestruct_finalization/selfdestruct_in_delegate_context.json', 'funded-other-call_opcode_DELEGATECALL]'),
    ('create2_collision', EIP+'collision_selfdestruct/selfdestruct_after_create2_collision.json', '[fork_Osaka-state_test]'),
    ('reinvoked_nonce', EIP+'selfdestruct_finalization/reinvoked_selfdestruct_create_nonce.json', '[fork_Osaka-state_test]'),
    ('root_create_revert_zero', PREFIX+'ported_static/stRevertTest/revert_opcode_in_init/revert_opcode_in_init.json', 'tx_value_0]'),
    ('root_create_revert_value', PREFIX+'ported_static/stRevertTest/revert_opcode_in_init/revert_opcode_in_init.json', 'tx_value_1]'),
    ('log0_nonempty', PREFIX+'ported_static/stLogTests/log0_non_empty_mem/log0_non_empty_mem.json', '[fork_Osaka-state_test]'),
    ('log4_nonempty', PREFIX+'ported_static/stLogTests/log4_non_empty_mem/log4_non_empty_mem.json', '[fork_Osaka-state_test]'),
]
LIMITS = dict(expandedBytes=64*1024**3, preparationSeconds=900, sourceFileBytes=8*1024**2,
              retainedSourceBytes=64*1024**2, gas=16777216, calldataBytes=32768,
              preAccounts=128, preStorageSlots=1024, vectors=16)
ENV_KEYS = {'currentCoinbase','currentGasLimit','currentNumber','currentTimestamp','currentRandom','currentDifficulty','currentBaseFee','currentExcessBlobGas'}
TX_KEYS = {'chainId','nonce','gasPrice','gasLimit','to','value','data','accessLists','sender','secretKey','maxFeePerGas','maxPriorityFeePerGas','authorizationList'}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as out:
        out.write(json.dumps(value, indent=2)+'\n')

class Expanded(io.RawIOBase):
    def __init__(self, stream, began):
        self.stream, self.began, self.count = stream, began, 0
    def readable(self):
        return True
    def read(self, size=-1):
        if time.monotonic()-self.began > LIMITS['preparationSeconds']:
            raise RuntimeError('preparation_deadline')
        size = min(1024*1024 if size < 0 else size, LIMITS['expandedBytes']-self.count+1)
        data = self.stream.read(size)
        self.count += len(data)
        if self.count > LIMITS['expandedBytes']:
            raise RuntimeError('expanded_byte_limit')
        return data

def inspect(fixture, selected):
    issues = []
    tx, pre = fixture['transaction'], fixture['pre']
    post = fixture['post']['Osaka'][selected['postIndex']]
    ix = post['indexes']
    gas, data = int(tx['gasLimit'][ix['gas']],16), tx['data'][ix['data']]
    account_count, slots = len(pre), sum(len(a['storage']) for a in pre.values())
    if gas > LIMITS['gas']: issues.append('gas_bound')
    if (len(data)-2)//2 > LIMITS['calldataBytes']: issues.append('calldata_bound')
    if account_count > LIMITS['preAccounts']: issues.append('pre_accounts_bound')
    if slots > LIMITS['preStorageSlots']: issues.append('pre_storage_bound')
    if set(tx)-TX_KEYS: issues.append('unsupported_transaction_fields')
    if set(fixture['env']) != ENV_KEYS: issues.append('environment_fields')
    if int(fixture['env']['currentDifficulty'],16) != 0: issues.append('nonzero_difficulty')
    if int(tx['chainId'],16) != 1 or fixture['config']['chainid'] != '0x01': issues.append('chain')
    schedule=fixture['config'].get('blobSchedule',{}).get('Osaka',{})
    if {k:int(v,16) for k,v in schedule.items()} != {'target':6,'max':9,'baseFeeUpdateFraction':5007716}: issues.append('blob_schedule')
    access=tx.get('accessLists',[None]*len(tx['data']))[ix['data']]
    tx_type=4 if 'authorizationList' in tx else 2 if 'maxFeePerGas' in tx else 1 if access is not None else 0
    return dict(index=selected['index'], category=selected['category'], id=selected['id'], postIndex=selected['postIndex'],
                structuralCompatibility='within_existing_adapter_fields_and_resource_bounds' if not issues else 'unsupported_without_replacement',
                issues=issues, transactionType=tx_type, creation=not tx['to'], gas=gas, calldataBytes=(len(data)-2)//2,
                preAccounts=account_count, preStorageSlots=slots, postEntries=len(fixture['post']['Osaka']),
                officialExpectation=dict(stateRoot=post['hash'], logsHash=post['logs'], receiptStatus=post.get('receipt',{}).get('status'),
                                         receiptGas=post.get('receipt',{}).get('cumulativeGasUsed'), exception=post.get('expectException')),
                transactionSha256=digest(bytes.fromhex(post['txbytes'][2:])),
                caution='Static inspection only; signed byte reconstruction, execution, unsupported history access and observed conformance remain untested.')

def main():
    began=time.monotonic()
    raw_index=INDEX.read_bytes(); index=json.loads(raw_index)
    selected=[]
    for i,(category,path,suffix) in enumerate(CHOICES,1):
        rows=[r for r in index['rows'] if r['json_path']==path and r['id'].endswith(suffix)]
        assert len(rows)==1, (category,len(rows))
        row=rows[0]
        selected.append(dict(index=i, category=category, file='candidates/'+path, archivePath='fixtures/'+path,
                             id=row['id'], fixtureHash=row['fixture_hash'], fork='Osaka', postIndex=0))
    assert len(selected)==16 and len({(r['file'],r['id'],r['postIndex']) for r in selected})==16
    plan=dict(schemaVersion='1.0', status='proposal_not_execution_frozen', release='tests@v21.0.2',
              releaseCommit='e27f097ec7b3e6e8ee9c2c1873c183e8f7da7a6e', archiveSha256=ARCHIVE_SHA,
              releaseIndexSha256=digest(raw_index), selectionRule='Exact file/ID suffix list in prepare.py; postIndex0; retained unchanged on structural incompatibility. No execution/replacement.',
              limits=LIMITS, selected=selected, executionCount=0,
              oracleScope='Official signed Osaka full-transaction state roots/log hashes/receipt fields. Does not directly validate the unsigned sparse product executor or its fee/admission profile.')
    save(BASE/'proposal.json',plan)
    save(BASE/'PREPARATION_STARTED.json',dict(proposalSha256=digest((BASE/'proposal.json').read_bytes()),publicRequests=0,executions=0))
    status='complete'; error=None; inventory=[]; inspections=[]; stream=None
    try:
        h=hashlib.sha256()
        with ARCHIVE.open('rb') as source:
            for chunk in iter(lambda:source.read(1024*1024),b''):
                if time.monotonic()-began>LIMITS['preparationSeconds']: raise RuntimeError('preparation_deadline')
                h.update(chunk)
        assert h.hexdigest()==ARCHIVE_SHA,'archive_hash_mismatch'
        wanted={r['archivePath'] for r in selected}; retained=0
        stream=Expanded(gzip.open(ARCHIVE,'rb'),began)
        with tarfile.open(fileobj=stream,mode='r|') as archive:
            for member in archive:
                if member.name not in wanted: continue
                assert member.isfile() and member.size<=LIMITS['sourceFileBytes'],'source_type_or_size'
                assert retained+member.size<=LIMITS['retainedSourceBytes'],'retained_source_limit'
                relative=pathlib.PurePosixPath(member.name.removeprefix('fixtures/'))
                assert not relative.is_absolute() and '..' not in relative.parts
                raw=archive.extractfile(member).read(); assert len(raw)==member.size
                destination=BASE/'candidates'/relative; destination.parent.mkdir(parents=True,exist_ok=True)
                with destination.open('xb') as out: out.write(raw)
                fixtures=json.loads(raw); retained+=len(raw)
                inventory.append(dict(path='candidates/'+str(relative),archivePath=member.name,bytes=len(raw),sha256=digest(raw)))
                for row in selected:
                    if row['archivePath']!=member.name: continue
                    f=fixtures[row['id']];assert f['_info']['hash']==row['fixtureHash'] and f['_info']['fixture-format']=='state_test'
                    inspections.append(inspect(f,row))
                wanted.remove(member.name)
                if not wanted:break
        assert not wanted,'missing_selected_members'
    except Exception as exc:
        status='incomplete';error=str(exc)
    finally:
        if stream:stream.stream.close()
        save(BASE/'preparation.json',dict(status=status,error=error,archiveSha256=ARCHIVE_SHA,archiveBytes=ARCHIVE.stat().st_size,
             expandedBytesRead=stream.count if stream else 0,elapsedSeconds=time.monotonic()-began,publicRequests=0,executions=0,
             sources=sorted(inventory,key=lambda x:x['path']),selectedInspection=sorted(inspections,key=lambda x:x['index'])))
        print(json.dumps(dict(status=status,error=error,sources=len(inventory),selectedInspected=len(inspections),executions=0)))

if __name__=='__main__':main()
