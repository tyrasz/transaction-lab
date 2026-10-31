"""Stock EELS sequence adapter; no product outputs are accepted.

python -I -B eels-worker.py INPUT TOOLCHAIN_MANIFEST INPUT_SHA [--prepare-only]
Preparation validates inputs, signatures, roots and source identity, returning
before construction of any execution environment or call to apply_body.
Actual dispatch is held pending separate source-freeze/runner review.
"""
import hashlib
import importlib
import json
import re
import sys
from pathlib import Path

TOOLCHAIN_SHA = "3c69ebf10c2650c6f5ad29bcc7bf738766f72fd9b7ff01424f3cc2227b3aca19"
SYSTEMS = [
    "0x00000961ef480eb55e80d19ad83579a64c007002",
    "0x0000bbddc7ce488642fb579f8b00f3a590007251",
    "0x0000bff46984e3725691fa540a8c7589300d8282",
    "0x000064d678505ad48f8ccb093bc65613800e8282",
]
CASES = [
    ("osaka_approve_deposit_withdraw", "Osaka", ["approve", "deposit", "withdraw"]),
    ("amsterdam_approve_deposit_withdraw", "Amsterdam", ["approve", "deposit", "withdraw"]),
    ("osaka_approve_deposit_revert_stop", "Osaka", ["approve", "depositThenRevert", "withdraw"]),
    ("amsterdam_approve_deposit_revert_stop", "Amsterdam", ["approve", "depositThenRevert", "withdraw"]),
]
PROGRESS = None
CURRENT = None


def need(condition, message):
    if not condition:
        raise ValueError(message)


def unique(pairs):
    out = {}
    for key, value in pairs:
        need(key not in out, "Duplicate JSON key")
        out[key] = value
    return out


def json_file(path, limit):
    need(path.is_file() and path.stat().st_size <= limit, "File size bound")
    encoded = path.read_bytes()
    def reject(value):
        raise ValueError("Non-finite JSON value: " + value)
    return encoded, json.loads(encoded, object_pairs_hook=unique, parse_constant=reject)


def hx(value):
    return "0x" + bytes(value).hex()


def raw(value, size=None):
    need(type(value) is str and re.fullmatch(r"0x(?:[0-9a-f]{2})*", value), "Noncanonical bytes")
    result = bytes.fromhex(value[2:])
    need(size is None or len(result) == size, "Wrong byte width")
    return result


def quantity(value):
    need(type(value) is str and re.fullmatch(r"0x(?:0|[1-9a-f][0-9a-f]*)", value), "Noncanonical quantity")
    return int(value, 16)


def decimal(value):
    need(type(value) is str and re.fullmatch(r"0|[1-9][0-9]*", value), "Noncanonical decimal")
    return int(value)


def check_allocation(allocation):
    need(type(allocation) is dict and len(allocation) <= 64, "Allocation bound")
    count = 0
    for address, row in allocation.items():
        raw(address, 20)
        need(type(row) is dict and set(row) == {"nonce", "balance", "code", "storage"}, "Account fields")
        need(quantity(row["nonce"]) < 2**64 and quantity(row["balance"]) < 2**256, "Account scalar bound")
        need(len(raw(row["code"])) <= 65536 and type(row["storage"]) is dict, "Code/storage bound")
        count += len(row["storage"])
        for key, value in row["storage"].items():
            raw(key, 32)
            raw(value, 32)
            need(int(value, 16) != 0, "Allocation must omit zero storage")
    need(count <= 1024, "Storage slot bound")


def main():
    global PROGRESS, CURRENT
    need(len(sys.argv) in (4, 5) and (len(sys.argv) == 4 or sys.argv[4] == "--prepare-only"), "Arguments")
    need(sys.flags.isolated and sys.dont_write_bytecode, "Use python -I -B")
    encoded, d = json_file(Path(sys.argv[1]).resolve(), 128 * 1024)
    need(re.fullmatch(r"[0-9a-f]{64}", sys.argv[3]) is not None, "Expected input hash")
    need(hashlib.sha256(encoded).hexdigest() == sys.argv[3], "Input SHA256 mismatch")
    tool_raw, tool = json_file(Path(sys.argv[2]).resolve(), 2 * 1024 * 1024)
    need(hashlib.sha256(tool_raw).hexdigest() == TOOLCHAIN_SHA, "Toolchain manifest mismatch")
    need(Path(sys.executable).resolve() == Path(tool["python"]).resolve(), "Wrong Python runtime")
    expected_fields = {"index", "id", "fork", "chainId", "scope", "sender", "addresses", "slots", "amounts",
        "originalAllocation", "originalStateRoot", "allocation", "initialStateRoot", "header", "headerHash",
        "environment", "steps", "productQueries", "amendment"}
    need(type(d) is dict and set(d) == expected_fields, "Declaration fields")
    need(type(d["index"]) is int and 0 <= d["index"] < 4, "Case index")
    case_id, fork_name, methods = CASES[d["index"]]
    need((d["id"], d["fork"]) == (case_id, fork_name), "Fixed case identity")
    amsterdam = fork_name == "Amsterdam"
    need(type(d["chainId"]) is int and d["chainId"] == (11155111 if amsterdam else 1), "Chain id")
    need(type(d["steps"]) is list and len(d["steps"]) == 3, "Three fixed positions")
    need(d["amounts"] == {"approve": "100", "deposit": "100", "withdraw": "40"}, "Fixed amounts")
    need(d["scope"]["referenceStateFeeds"] == "preceding_eels_full_allocation_only"
         and d["scope"]["stopOn"] == "first_original_non_success"
         and d["scope"]["sameHeader"] is True, "Sequence scope")
    raw(d["sender"], 20)
    need(d["sender"] == "0x1a642f0e3c3af545e7acbd38b07251b3990914f1", "Fixed synthetic sender")
    need(d["productQueries"] == [{"kind": "native_balance", "account": d["sender"]}], "Excluded product query")
    check_allocation(d["originalAllocation"])
    check_allocation(d["allocation"])
    expected = dict(d["originalAllocation"])
    for address in SYSTEMS:
        need(address not in expected, "Scaffold replaces original account")
        expected[address] = {"nonce": "0x1", "balance": "0x0", "code": "0x00", "storage": {}}
    need(d["allocation"] == expected and d["amendment"] == {
        "kind": "identical_inert_system_STOP_accounts", "addresses": SYSTEMS,
        "originalAccountRowsChanged": False, "actualDeployedChainState": False}, "Scaffold binding")

    source = Path(tool["toolchain"]) / "source"
    pins = {row["path"]: row for row in tool["source"]}
    sys.path.insert(0, str(source / "src"))
    from ethereum_rlp import rlp
    from ethereum_types.bytes import Bytes32
    from ethereum_types.numeric import U64, U256, Uint
    from ethereum import state_mpt
    from ethereum.crypto.hash import keccak256
    from ethereum.merkle_patricia_trie import root, trie_get
    from ethereum.state import Address
    from ethereum.trace import TransactionEnd, set_evm_trace
    from ethereum_spec_tools.loaders.fixture_loader import Load

    def stock_module(name):
        module = importlib.import_module(name)
        path = Path(module.__file__).resolve()
        relative = path.relative_to(source.resolve()).as_posix()
        pin = pins[relative]
        content = path.read_bytes()
        need(len(content) == pin["bytes"] and hashlib.sha256(content).hexdigest() == pin["sha256"], "Stock module identity")
        return module

    prefix = "ethereum.forks." + fork_name.lower() + "."
    fork, tracker, transactions, blocks, vm = [stock_module(prefix + name)
        for name in ("fork", "state_tracker", "transactions", "blocks", "vm")]
    # These are direct interpretation sources. The later frozen driver must
    # verify the entire external source/dependency inventory, not only these.
    for name in (prefix + "vm.interpreter", "ethereum.trace", "ethereum.state_mpt",
                 "ethereum_spec_tools.loaders.fixture_loader"):
        stock_module(name)
    loader = Load(fork_name.lower())
    need(loader.fork.state_provider.State is state_mpt.State, "Full MPT provider")
    initial = loader.json_to_state(d["allocation"])
    need(hx(state_mpt.state_root(initial)) == d["initialStateRoot"] == d["header"]["stateRoot"], "Initial MPT root")
    need(hx(state_mpt.state_root(loader.json_to_state(d["originalAllocation"]))) == d["originalStateRoot"], "Original MPT root")
    need(hx(keccak256(rlp.encode(loader.json_to_header(d["header"])))) == d["headerHash"] == d["header"]["hash"], "Full header RLP hash")
    header, env = d["header"], d["environment"]
    joins = {"currentCoinbase": "miner", "currentGasLimit": "gasLimit", "currentNumber": "number",
        "currentTimestamp": "timestamp", "currentRandom": "mixHash", "currentDifficulty": "difficulty",
        "currentBaseFee": "baseFeePerGas", "currentExcessBlobGas": "excessBlobGas",
        "parentBeaconBlockRoot": "parentBeaconBlockRoot"}
    if amsterdam:
        joins["slotNumber"] = "slotNumber"
    need(set(env) == set(joins) | {"withdrawals"} and env["withdrawals"] == []
         and all(env[a] == header[b] for a, b in joins.items()), "Environment/header binding")
    need(quantity(header["difficulty"]) == 0 and quantity(header["baseFeePerGas"]) == 7, "Fixed fee/merge context")
    sender = Address(raw(d["sender"], 20))
    sender_initial = initial.get_account_optional(sender)
    need(sender_initial is not None and sender_initial.nonce == 1
         and initial.get_code(sender_initial.code_hash) == b"", "Fixed sender prestate")
    decoded = []
    for position, step in enumerate(d["steps"]):
        need(type(step) is dict and set(step) == {"position", "method", "request", "transaction", "signedBytes",
            "transactionHash", "transactionBody", "inputGas"}, "Step input fields")
        need(type(step["position"]) is int and step["position"] == position
             and step["method"] == methods[position], "Position/method binding")
        signed = raw(step["signedBytes"])
        tx = transactions.decode_transaction(signed)
        need(type(tx) is transactions.FeeMarketTransaction and transactions.encode_transaction(tx) == signed, "Type2 roundtrip")
        need(transactions.recover_sender(tx) == sender, "Recovered sender")
        need(hx(keccak256(signed)) == step["transactionHash"] and hx(rlp.encode([signed])) == step["transactionBody"], "Transaction hash/body")
        r, envelope = step["request"], step["transaction"]
        need(set(r) == {"from", "to", "data", "value", "gas", "executionProfile", "fees"}, "Request fields")
        # Independently derive the declared method's exact calldata. A valid
        # signature/input hash must not turn a relabelled scenario into a pass.
        token, vault = "0x" + "71" * 20, "0x" + "72" * 20
        method = methods[position]
        signature = "approve(address,uint256)" if method == "approve" else method + "(uint256)"
        amount = 40 if method == "withdraw" else 100
        arguments = (bytes.fromhex(vault[2:]).rjust(32, b"\x00") if method == "approve" else b"") + amount.to_bytes(32, "big")
        expected_data = hx(keccak256(signature.encode())[:4] + arguments)
        need(r["to"] == (token if method == "approve" else vault)
             and r["data"] == expected_data, "Fixed method/address/argument bytes")
        fields = {"chain_id": "chainId", "nonce": "nonce", "gas": "gasLimit", "value": "value",
            "max_fee_per_gas": "maxFeePerGas", "max_priority_fee_per_gas": "maxPriorityFeePerGas",
            "y_parity": "yParity", "r": "r", "s": "s"}
        need(set(envelope) == set(fields.values()) | {"type", "to", "data", "accessList", "v"}, "Envelope fields")
        need(all(int(getattr(tx, name)) == quantity(envelope[key]) for name, key in fields.items()), "Envelope scalar join")
        need(envelope["v"] == envelope["yParity"], "Type2 v/yParity alias")
        need(envelope["type"] == "0x2" and tx.chain_id == d["chainId"] and tx.nonce == position + 1, "Chain/nonce/type")
        need(tx.gas == decimal(r["gas"]) == 5_000_000 and tx.value == decimal(r["value"]) == 0, "Gas/value")
        need(tx.max_fee_per_gas == 13 and tx.max_priority_fee_per_gas == 3
             and r["fees"] == {"maxFeePerGas": "13", "maxPriorityFeePerGas": "3"}
             and r["executionProfile"] == "unsigned_eip1559_block_end", "Fee profile")
        need(r["from"] == d["sender"] and hx(tx.to) == r["to"] == envelope["to"]
             and hx(tx.data) == r["data"] == envelope["data"], "Call fields")
        need(tx.access_list == () and envelope["accessList"] == [], "Access list")
        intrinsic = transactions.validate_transaction(tx, sender) if amsterdam else transactions.validate_transaction(tx)
        regular = intrinsic.execution if amsterdam else intrinsic.regular
        need(step["inputGas"] == {"intrinsic": str(regular), "calldataFloor": str(intrinsic.calldata_floor)}, "Intrinsic gas")
        decoded.append((signed, tx))

    report = {"id": d["id"], "fork": d["fork"], "inputSha256": sys.argv[3], "toolchainSha256": TOOLCHAIN_SHA,
        "sourceModule": str(Path(fork.__file__).resolve()),
        "initialStateRoot": d["initialStateRoot"], "originalStateRoot": d["originalStateRoot"],
        "headerHash": d["headerHash"], "environment": env, "scope": d["scope"],
        "signedInputHashes": [s["transactionHash"] for s in d["steps"]],
        "headerValidation": "full_header_RLP_hash_and_environment_only_not_consensus_or_full_block_validation"}
    if len(sys.argv) == 5:
        report["status"] = "prepared_no_execution"
        return report

    # This branch is not used by preparation. Each invocation below receives
    # only reference-owned state. A product result is never an input argument.
    allocation, prior_root = d["allocation"], d["initialStateRoot"]
    rows = [{"position": position, "transactionHash": step["transactionHash"],
        "status": "not_attempted", "reason": "previous_reference_transaction_non_success_or_unavailable",
        "observation": None} for position, step in enumerate(d["steps"])]
    report.update(status="running", steps=rows, finalStateRoot=prior_root)
    PROGRESS = report
    stopped = False
    for position, (signed, tx) in enumerate(decoded):
        row = rows[position]
        if stopped:
            continue
        CURRENT = row
        state = loader.json_to_state(allocation)
        need(hx(state_mpt.state_root(state)) == prior_root, "Reference carry root")
        current_sender = state.get_account_optional(sender)
        need(current_sender is not None and current_sender.nonce == tx.nonce, "Current reference nonce")
        need(current_sender.balance >= tx.gas * tx.max_fee_per_gas + tx.value, "Current reference maximum funds")
        tracked = tracker.BlockState(pre_state=state)
        arguments = {"chain_id": U64(d["chainId"]), "state": tracked,
            "block_gas_limit": Uint(quantity(header["gasLimit"])),
            "block_hashes": [Bytes32(raw(header["parentHash"], 32))],
            "coinbase": Address(raw(header["miner"], 20)), "number": Uint(quantity(header["number"])),
            "base_fee_per_gas": Uint(quantity(header["baseFeePerGas"])), "time": U256(quantity(header["timestamp"])),
            "prev_randao": Bytes32(raw(header["mixHash"], 32)), "excess_blob_gas": U64(quantity(header["excessBlobGas"])),
            "parent_beacon_block_root": Bytes32(raw(header["parentBeaconBlockRoot"], 32))}
        if amsterdam:
            bal = stock_module(prefix + "block_access_lists")
            arguments.update(block_access_list_builder=bal.BlockAccessListBuilder(), slot_number=U64(quantity(header["slotNumber"])))
        block_env = vm.BlockEnvironment(**arguments)
        terminal, trace_events = [], 0
        tx_hash = keccak256(signed)

        def trace(evm, event):
            nonlocal trace_events
            trace_events += 1
            need(trace_events <= 200000, "Trace event bound")
            if not isinstance(event, TransactionEnd):
                return
            context = evm if amsterdam else evm.message
            if context.tx_env.tx_hash != tx_hash:
                return
            need(not terminal and context.depth == 0 and len(event.output) <= 65536, "Root TransactionEnd identity/bound")
            terminal.append({"returnData": hx(event.output), "gasUsed": str(event.gas_used),
                "error": None if event.error is None else {"type": type(event.error).__name__, "message": str(event.error)[:2048]}})

        previous_trace = set_evm_trace(trace)
        try:
            output = fork.apply_body(block_env, (signed,), ())
        finally:
            set_evm_trace(previous_trace)
        diff = tracker.extract_block_diff(tracked)
        post_root = hx(state.compute_state_root(diff))
        state_mpt.apply_changes_to_state(state, diff)
        need(hx(state_mpt.state_root(state)) == post_root, "Applied diff root")
        allocation = {}
        need(len(state._main_trie._data) <= 64, "Poststate account bound")
        for address, account in sorted(state._main_trie._data.items()):
            if account is None:
                continue
            storage = state._storage_tries.get(address)
            allocation[hx(address)] = {"nonce": hex(account.nonce), "balance": hex(account.balance),
                "code": hx(state.get_code(account.code_hash)), "storage": {} if storage is None else {
                    hx(key): "0x" + int(value).to_bytes(32, "big").hex()
                    for key, value in sorted(storage._data.items()) if value != 0}}
        check_allocation(allocation)
        need(hx(state_mpt.state_root(loader.json_to_state(allocation))) == post_root, "Serialized poststate root")
        for address in SYSTEMS:
            need(allocation.get(address) == d["allocation"][address], "System scaffold changed")
        receipt_raw = trie_get(output.receipts_trie, rlp.encode(Uint(0)))
        need(type(receipt_raw) is bytes and receipt_raw[:1] == b"\x02"
             and output.receipt_keys == (rlp.encode(Uint(0)),), "Single type2 receipt")
        receipt = rlp.decode_to(blocks.Receipt, receipt_raw[1:])
        charged_gas = output.cumulative_gas_used if amsterdam else output.block_gas_used
        need(receipt.cumulative_gas_used == charged_gas and receipt.logs == output.block_logs, "Receipt/block join")
        need(output.requests == [], "Unexpected system request")
        if terminal:
            need(receipt.succeeded == (terminal[0]["error"] is None), "Receipt/root outcome join")
        logs = [{"address": hx(log.address), "topics": [hx(topic) for topic in log.topics], "data": hx(log.data)} for log in receipt.logs]
        need(len(logs) <= 1024, "Log bound")
        status = "success" if receipt.succeeded else (
            "reverted" if terminal and terminal[0]["error"]["type"] == "Revert" else "failed" if terminal else None)
        row.update(status="completed", reason=None, observation={
            "executionStatus": status, "startingStateRoot": prior_root, "stateRoot": post_root, "allocation": allocation,
            "chargedGas": str(charged_gas), "logs": logs, "logsHash": hx(keccak256(rlp.encode(receipt.logs))),
            "receiptBytes": hx(receipt_raw), "receiptsRoot": hx(root(output.receipts_trie)),
            "transactionsRoot": hx(root(output.transactions_trie)), "transactionEnd": terminal[0] if terminal else None,
            "returnData": terminal[0]["returnData"] if terminal else None,
            "returnDataAvailability": "official_TransactionEnd" if terminal else "unavailable_no_TransactionEnd_event",
            "transactionEndGasMeaning": "grant_minus_remaining_before_refund_and_floor_not_receipt_gas",
            "regularGasUsed": str(output.block_gas_used) if amsterdam else None,
            "stateGasUsed": str(output.block_state_gas_used) if amsterdam else None,
            "singleTransactionBlockGasUsed": str(max(output.block_gas_used, output.block_state_gas_used) if amsterdam else output.block_gas_used),
            "storageClears": sorted(hx(address) for address in diff.storage_clears), "traceEvents": trace_events})
        prior_root, stopped = post_root, not receipt.succeeded
        report["finalStateRoot"] = prior_root
        CURRENT = None
    report.update(status="completed", steps=rows, finalStateRoot=prior_root)
    return report


if __name__ == "__main__":
    exit_code = 0
    try:
        report = main()
    except Exception as error:
        if PROGRESS is None:
            raise
        if CURRENT is not None:
            CURRENT.update(status="unavailable", reason="reference_adapter_or_execution_exception", observation=None)
        report = PROGRESS
        report.update(status="unavailable", error={"type": type(error).__name__, "message": str(error)[:2048]})
        print(type(error).__name__ + ": " + str(error)[:2048], file=sys.stderr)
        exit_code = 1
    result = json.dumps(report, sort_keys=True, separators=(",", ":"))
    need(len(result.encode()) <= 2 * 1024 * 1024, "Output bound")
    print(result)
    sys.exit(exit_code)
