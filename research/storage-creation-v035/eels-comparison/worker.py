"""One fixed declaration -> stock pinned EELS Amsterdam apply_body.

Usage: venv/bin/python -I -B worker.py DECLARATION TOOLCHAIN [--prepare-only]
The caller freezes/checks the external toolchain and bounds this subprocess.
Preparation validates input/signature/prestate only; it never invokes the EVM.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

PINS = {
    "d92f92757ed890b8e7369a3b817684cc5a08094cda3e6d0041d721b18b24ffa9": "root_create_storage_only",
    "8f0b079e89c62bf65fa042d7ec5ab50cbcca0556d647256761e61819d058d451": "internal_create2_storage_only",
    "35645ac81910ed075faa2ef287c0b2e2ca670381537a7918839e586542c28e5d": "root_create_absent",
    "34618e714649ffb46a3791fc23d906c4b681a8db99113925caad1eaf5f46505d": "internal_create2_absent",
    "25a5877249d7e4a51e709f51be2a285c7711fd5fd68f1fbdc6cc2b9494a29aff": "root_create_empty_storage",
    "a8ff9ca210a9358a56395a8f9a933dc332f8e2c96c6edd885b45dd37781213d4": "internal_create2_empty_storage",
}
SYSTEMS = (
    "0x00000961ef480eb55e80d19ad83579a64c007002",
    "0x0000bbddc7ce488642fb579f8b00f3a590007251",
    "0x0000bff46984e3725691fa540a8c7589300d8282",
    "0x000064d678505ad48f8ccb093bc65613800e8282",
)


def need(value, message):
    if not value:
        raise ValueError(message)


def unique(pairs):
    out = {}
    for key, value in pairs:
        need(key not in out, "Duplicate JSON key")
        out[key] = value
    return out


def hx(value):
    return "0x" + bytes(value).hex()


def raw(value):
    need(isinstance(value, str) and re.fullmatch(r"0x(?:[0-9a-f]{2})*", value), "Noncanonical bytes")
    return bytes.fromhex(value[2:])


def main():
    need(len(sys.argv) in (3, 4) and (len(sys.argv) == 3 or sys.argv[3] == "--prepare-only"), "Expected DECLARATION TOOLCHAIN [--prepare-only]")
    need(sys.flags.isolated and sys.dont_write_bytecode, "Use python -I -B")
    input_path, toolchain = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    need(input_path.is_file() and input_path.stat().st_size <= 128 * 1024, "Input file exceeds bound")
    encoded = input_path.read_bytes()
    input_sha = hashlib.sha256(encoded).hexdigest()
    need(input_sha in PINS, "Declaration is not one of the six immutable inputs")
    d = json.loads(encoded, object_pairs_hook=unique)
    need(d["id"] == PINS[input_sha] and d["chainId"] == 11155111 and d["fork"] == "Amsterdam", "Unexpected declaration identity")
    source = (toolchain / "source" / "src").resolve()
    need(source.is_dir(), "Missing pinned source/src")
    sys.path.insert(0, str(source))

    # Only official imports; no runtime/source patching or transaction rewriting.
    from ethereum_rlp import rlp
    from ethereum_types.bytes import Bytes32
    from ethereum_types.numeric import U64, U256, Uint
    from ethereum.crypto.hash import keccak256
    from ethereum.state import Address
    from ethereum import state_mpt
    from ethereum.merkle_patricia_trie import EMPTY_TRIE_ROOT, root, trie_get
    from ethereum.trace import TransactionEnd, set_evm_trace
    from ethereum.forks.amsterdam import fork, state_tracker, transactions
    from ethereum.forks.amsterdam.blocks import Receipt
    from ethereum.forks.amsterdam.block_access_lists import BlockAccessListBuilder
    from ethereum.forks.amsterdam.vm import BlockEnvironment
    from ethereum_spec_tools.loaders.fixture_loader import Load

    need(Path(fork.__file__).resolve() == source / "ethereum/forks/amsterdam/fork.py", "Wrong EELS module path")
    loader = Load("amsterdam")
    need(loader.fork.state_provider.State is state_mpt.State, "Expected official MPT provider")
    original = loader.json_to_state(d["originalAllocation"])
    state = loader.json_to_state(d["allocation"])
    original_root, initial_root = hx(state_mpt.state_root(original)), hx(state_mpt.state_root(state))
    need(original_root == d["originalStateRoot"], "Original allocation root mismatch")
    need(initial_root == d["initialStateRoot"] == d["header"]["stateRoot"], "Amended allocation root mismatch")
    expected = dict(d["originalAllocation"])
    for address in SYSTEMS:
        need(address not in expected, "System scaffold replaces original account")
        expected[address] = {"nonce": "0x1", "balance": "0x0", "code": "0x00", "storage": {}}
    need(d["allocation"] == expected and d["amendment"]["addresses"] == list(SYSTEMS), "Scaffold differs")

    signed = raw(d["signedBytes"])
    tx = transactions.decode_transaction(signed)
    need(type(tx) is transactions.FeeMarketTransaction and transactions.encode_transaction(tx) == signed, "Signed type-2 roundtrip mismatch")
    need(hx(keccak256(signed)) == d["transactionHash"] and hx(rlp.encode([signed])) == d["transactionBody"], "Signed transaction hash/body mismatch")
    request, envelope, header, env = d["request"], d["transaction"], d["header"], d["environment"]
    sender = transactions.recover_sender(tx)
    need(hx(sender) == request["from"], "Recovered sender mismatch")
    fields = {"chain_id": "chainId", "nonce": "nonce", "gas": "gasLimit", "value": "value", "max_fee_per_gas": "maxFeePerGas", "max_priority_fee_per_gas": "maxPriorityFeePerGas", "y_parity": "yParity", "r": "r", "s": "s"}
    need(all(int(getattr(tx, name)) == int(envelope[key], 16) for name, key in fields.items()), "Signed envelope differs")
    need(int(tx.chain_id) == d["chainId"] and int(tx.gas) == int(request["gas"]) <= 5_000_000, "Wrong chain/gas")
    need(int(tx.value) == int(request["value"]) and hx(tx.data) == request["data"] == envelope["data"], "Signed call data/value differs")
    need(int(tx.max_fee_per_gas) == int(request["fees"]["maxFeePerGas"]) and int(tx.max_priority_fee_per_gas) == int(request["fees"]["maxPriorityFeePerGas"]), "Signed fees differ")
    need(tx.access_list == () and envelope["accessList"] == [], "Unexpected access list")
    destination = None if len(tx.to) == 0 else hx(tx.to)
    need(destination == request["to"] == envelope.get("to") and (destination is None) == d["rootCreate"], "Signed destination differs")
    intrinsic = transactions.validate_transaction(tx, sender)
    need(str(intrinsic.execution) == d["inputGas"]["intrinsic"], "Intrinsic input mismatch")
    joins = {"currentCoinbase": "miner", "currentGasLimit": "gasLimit", "currentNumber": "number", "currentTimestamp": "timestamp", "currentRandom": "mixHash", "currentDifficulty": "difficulty", "currentBaseFee": "baseFeePerGas", "slotNumber": "slotNumber", "currentExcessBlobGas": "excessBlobGas", "parentBeaconBlockRoot": "parentBeaconBlockRoot"}
    need(all(env[key] == header[value] for key, value in joins.items()) and env["withdrawals"] == [], "Environment/header mismatch")
    target = Address(raw(d["target"]))
    initial_target_root = hx(root(state._storage_tries[target])) if target in state._storage_tries else hx(EMPTY_TRIE_ROOT)
    need(initial_target_root == d["initialTargetStorageRoot"], "Target initial storage root differs")

    report = {"id": d["id"], "inputSha256": input_sha, "sourceModule": str(Path(fork.__file__).resolve()),
              "signedBytes": d["signedBytes"], "transactionHash": d["transactionHash"], "sender": hx(sender),
              "envelope": envelope, "environment": env, "originalStateRoot": original_root, "initialStateRoot": initial_root,
              "initialTargetStorageRoot": initial_target_root, "intrinsicGas": str(intrinsic.execution),
              "calldataFloor": str(intrinsic.calldata_floor), "headerValidation": "declared_environment_only_not_full_block_validation",
              "scope": "one_signed_transaction_in_stock_Amsterdam_apply_body_with_declared_system_scaffold_and_empty_withdrawals"}
    if len(sys.argv) == 4:
        report["status"] = "prepared_no_execution"
        return report

    tracked = state_tracker.BlockState(pre_state=state)
    block_env = BlockEnvironment(chain_id=U64(d["chainId"]), state=tracked,
        block_gas_limit=Uint(int(header["gasLimit"], 16)), block_hashes=[Bytes32(raw(header["parentHash"]))],
        coinbase=Address(raw(header["miner"])), number=Uint(int(header["number"], 16)),
        base_fee_per_gas=Uint(int(header["baseFeePerGas"], 16)), time=U256(int(header["timestamp"], 16)),
        prev_randao=Bytes32(raw(header["mixHash"])), excess_blob_gas=U64(int(header["excessBlobGas"], 16)),
        parent_beacon_block_root=Bytes32(raw(header["parentBeaconBlockRoot"])),
        block_access_list_builder=BlockAccessListBuilder(), slot_number=U64(int(header["slotNumber"], 16)))
    terminal = []

    def trace(evm, event):
        if isinstance(event, TransactionEnd) and evm.tx_env.tx_hash == keccak256(signed):
            need(len(terminal) == 0 and evm.depth == 0 and len(event.output) <= 65536, "Unexpected transaction-end trace")
            terminal.append({"returnData": hx(event.output), "gasUsed": str(event.gas_used),
                             "error": None if event.error is None else {"type": type(event.error).__name__, "message": str(event.error)[:2048]}})

    prior_trace = set_evm_trace(trace)
    try:
        output = fork.apply_body(block_env, (signed,), ())
    finally:
        set_evm_trace(prior_trace)
    diff = state_tracker.extract_block_diff(tracked)
    post_root = hx(state.compute_state_root(diff))
    state_mpt.apply_changes_to_state(state, diff)
    need(hx(state_mpt.state_root(state)) == post_root, "Applied diff root differs")
    allocation = {}
    need(len(state._main_trie._data) <= 64 and sum(len(t._data) for t in state._storage_tries.values()) <= 1024, "Poststate exceeds adapter bound")
    for address, account in sorted(state._main_trie._data.items()):
        if account is None:
            continue
        code = state.get_code(account.code_hash)
        need(len(code) <= 65536, "Poststate code exceeds bound")
        storage = state._storage_tries.get(address)
        allocation[hx(address)] = {"nonce": hex(account.nonce), "balance": hex(account.balance), "code": hx(code),
            "storage": {} if storage is None else {hx(key): "0x" + int(value).to_bytes(32, "big").hex() for key, value in sorted(storage._data.items()) if value != 0}}
    need(hx(state_mpt.state_root(loader.json_to_state(allocation))) == post_root, "Serialized allocation root differs")
    receipt_raw = trie_get(output.receipts_trie, rlp.encode(Uint(0)))
    need(type(receipt_raw) is bytes and receipt_raw[:1] == b"\x02" and len(output.receipt_keys) == 1, "Expected single type-2 receipt")
    receipt = rlp.decode_to(Receipt, receipt_raw[1:])
    need(receipt.cumulative_gas_used == output.cumulative_gas_used and receipt.logs == output.block_logs, "Receipt/block totals differ")
    if terminal:
        need(receipt.succeeded == (terminal[0]["error"] is None), "Root trace/receipt status differs")
    logs = [{"address": hx(log.address), "topics": [hx(topic) for topic in log.topics], "data": hx(log.data)} for log in receipt.logs]
    report.update(status="completed", allocation=allocation, stateRoot=post_root, receiptBytes=hx(receipt_raw),
        receipt={"status": "success" if receipt.succeeded else "failed", "chargedGas": str(receipt.cumulative_gas_used), "logs": logs},
        logsHash=hx(keccak256(rlp.encode(receipt.logs))), receiptsRoot=hx(root(output.receipts_trie)),
        transactionsRoot=hx(root(output.transactions_trie)), blockExecutionGasUsed=str(output.block_gas_used),
        blockStateGasUsed=str(output.block_state_gas_used), blockGasUsed=str(max(output.block_gas_used, output.block_state_gas_used)),
        transactionEnd=terminal[0] if terminal else None,
        returnDataAvailability="official_TransactionEnd" if terminal else "unavailable_no_TransactionEnd_event",
        target={"address": d["target"], "account": allocation.get(d["target"]),
                "storage": {slot: str(state.get_storage(target, Bytes32(int(slot).to_bytes(32, "big")))) for slot in d["sentinel"]["slots"]}},
        storageClears=sorted(hx(address) for address in diff.storage_clears),
        requests=[hx(request) for request in output.requests],
        blockHashContext="declared_parent_hash_only_no_earlier_hashes_supplied")
    return report


if __name__ == "__main__":
    # Setup/execution/projection exceptions leave a nonzero process + stderr,
    # never a fabricated completed target result. The outer runner retains both.
    result = json.dumps(main(), sort_keys=True, separators=(",", ":"))
    need(len(result.encode()) <= 2 * 1024 * 1024, "Output exceeds adapter bound")
    print(result)
