"""Prepare or execute one declaration with a stock pinned EELS fork.

Usage: python -I -B eels-worker.py INPUT TOOLCHAIN EXPECTED_INPUT_SHA256
       [--prepare-only]

The caller freezes the adapter, inputs, and external toolchain and bounds this
subprocess. Preparation validates signed input and prestate only. Its return
precedes every EVM invocation, including block system transactions.
"""

import hashlib
import importlib
import json
import re
import sys
from pathlib import Path


FORKS = {
    "Shanghai": "shanghai",
    "Cancun": "cancun",
    "Prague": "prague",
    "Osaka": "osaka",
    "Amsterdam": "amsterdam",
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


def reject_constant(value):
    raise ValueError("Non-finite JSON constant: " + value)


def hx(value):
    return "0x" + bytes(value).hex()


def raw(value, size=None):
    need(
        isinstance(value, str)
        and re.fullmatch(r"0x(?:[0-9a-f]{2})*", value),
        "Noncanonical bytes",
    )
    result = bytes.fromhex(value[2:])
    need(size is None or len(result) == size, "Wrong byte length")
    return result


def quantity(value):
    need(
        isinstance(value, str)
        and re.fullmatch(r"0x(?:0|[1-9a-f][0-9a-f]*)", value),
        "Noncanonical hex quantity",
    )
    return int(value, 16)


def decimal(value):
    need(
        isinstance(value, str) and re.fullmatch(r"0|[1-9][0-9]*", value),
        "Noncanonical decimal quantity",
    )
    return int(value)


def check_allocation(allocation):
    need(type(allocation) is dict and len(allocation) <= 64, "Allocation bound")
    slot_count = 0
    for address, account in allocation.items():
        raw(address, 20)
        need(type(account) is dict, "Malformed allocation account")
        need(
            set(account) == {"nonce", "balance", "code", "storage"},
            "Unexpected allocation account fields",
        )
        need(quantity(account["nonce"]) < 2**64, "Account nonce bound")
        need(quantity(account["balance"]) < 2**256, "Account balance bound")
        need(len(raw(account["code"])) <= 65536, "Account code bound")
        storage = account["storage"]
        need(type(storage) is dict, "Malformed storage")
        slot_count += len(storage)
        for key, value in storage.items():
            raw(key, 32)
            raw(value, 32)
    need(slot_count <= 1024, "Allocation storage bound")


def main():
    need(
        len(sys.argv) in (4, 5)
        and (len(sys.argv) == 4 or sys.argv[4] == "--prepare-only"),
        "Expected INPUT TOOLCHAIN EXPECTED_INPUT_SHA256 [--prepare-only]",
    )
    need(sys.flags.isolated and sys.dont_write_bytecode, "Use python -I -B")
    input_path = Path(sys.argv[1]).resolve()
    toolchain = Path(sys.argv[2]).resolve()
    expected_sha = sys.argv[3]
    need(re.fullmatch(r"[0-9a-f]{64}", expected_sha), "Invalid expected SHA256")
    need(
        input_path.is_file() and input_path.stat().st_size <= 128 * 1024,
        "Input file missing or exceeds bound",
    )
    encoded = input_path.read_bytes()
    input_sha = hashlib.sha256(encoded).hexdigest()
    need(input_sha == expected_sha, "Declaration SHA256 mismatch")
    d = json.loads(
        encoded, object_pairs_hook=unique, parse_constant=reject_constant
    )
    need(type(d) is dict, "Declaration must be an object")
    required = {
        "id", "fork", "chainId", "rootCreate", "originalAllocation",
        "allocation", "originalStateRoot", "initialStateRoot", "header",
        "environment", "amendment", "signedBytes", "transactionHash",
        "transactionBody", "request", "transaction", "inputGas", "target",
        "initialTargetStorageRoot", "sentinel",
    }
    need(required <= set(d), "Missing declaration fields")
    need(
        isinstance(d["id"], str)
        and re.fullmatch(r"[a-z][a-z0-9_]{0,127}", d["id"]),
        "Invalid declaration id",
    )
    need(type(d["fork"]) is str and d["fork"] in FORKS, "Unsupported fork")
    fork_name = FORKS[d["fork"]]
    amsterdam = fork_name == "amsterdam"
    need(
        type(d["chainId"]) is int
        and d["chainId"] == (11155111 if amsterdam else 1),
        "Unexpected chain id for fork",
    )
    need(type(d["rootCreate"]) is bool, "Malformed rootCreate")
    for field in (
        "header", "environment", "amendment", "request", "transaction",
        "inputGas", "sentinel",
    ):
        need(type(d[field]) is dict, "Malformed " + field)
    for field in (
        "originalStateRoot", "initialStateRoot", "transactionHash",
        "initialTargetStorageRoot",
    ):
        raw(d[field], 32)
    raw(d["target"], 20)
    check_allocation(d["originalAllocation"])
    check_allocation(d["allocation"])
    slots = d["sentinel"]["slots"]
    need(type(slots) is list and len(slots) <= 1024, "Malformed sentinel slots")
    need(
        all(
            (type(slot) is int and 0 <= slot < 2**256)
            or (
                type(slot) is str
                and re.fullmatch(r"0|[1-9][0-9]*", slot)
                and int(slot) < 2**256
            )
            for slot in slots
        ),
        "Invalid sentinel slot",
    )
    need(len({int(slot) for slot in slots}) == len(slots), "Duplicate sentinel")

    source = (toolchain / "source" / "src").resolve()
    need(source.is_dir(), "Missing pinned source/src")
    sys.path.insert(0, str(source))

    # Official imports only. No source/runtime patches or transaction rewriting.
    from ethereum_rlp import rlp
    from ethereum_types.bytes import Bytes32
    from ethereum_types.numeric import U64, U256, Uint
    from ethereum import state_mpt
    from ethereum.crypto.hash import keccak256
    from ethereum.merkle_patricia_trie import EMPTY_TRIE_ROOT, root, trie_get
    from ethereum.state import Address
    from ethereum.trace import TransactionEnd, set_evm_trace
    from ethereum_spec_tools.loaders.fixture_loader import Load

    modules = {}
    for name in ("fork", "state_tracker", "transactions", "blocks", "vm"):
        module = importlib.import_module(f"ethereum.forks.{fork_name}.{name}")
        suffix = "vm/__init__.py" if name == "vm" else name + ".py"
        need(
            Path(module.__file__).resolve()
            == source / "ethereum" / "forks" / fork_name / suffix,
            "Wrong EELS module path: " + name,
        )
        modules[name] = module
    fork = modules["fork"]
    state_tracker = modules["state_tracker"]
    transactions = modules["transactions"]
    Receipt = modules["blocks"].Receipt
    BlockEnvironment = modules["vm"].BlockEnvironment
    loader = Load(fork_name)
    need(loader.fork.state_provider.State is state_mpt.State, "Expected MPT")
    original = loader.json_to_state(d["originalAllocation"])
    state = loader.json_to_state(d["allocation"])
    original_root = hx(state_mpt.state_root(original))
    initial_root = hx(state_mpt.state_root(state))
    need(original_root == d["originalStateRoot"], "Original root mismatch")
    need(
        initial_root == d["initialStateRoot"] == d["header"]["stateRoot"],
        "Amended allocation root mismatch",
    )
    expected = dict(d["originalAllocation"])
    for address in SYSTEMS:
        need(address not in expected, "System scaffold replaces an account")
        expected[address] = {
            "nonce": "0x1", "balance": "0x0", "code": "0x00", "storage": {}
        }
    need(
        d["allocation"] == expected
        and d["amendment"]["addresses"] == list(SYSTEMS),
        "Scaffold differs",
    )

    signed = raw(d["signedBytes"])
    tx = transactions.decode_transaction(signed)
    need(
        type(tx) is transactions.FeeMarketTransaction
        and transactions.encode_transaction(tx) == signed,
        "Signed type-2 roundtrip mismatch",
    )
    tx_hash = keccak256(signed)
    need(
        hx(tx_hash) == d["transactionHash"]
        and hx(rlp.encode([signed])) == d["transactionBody"],
        "Signed transaction hash/body mismatch",
    )
    request, envelope = d["request"], d["transaction"]
    header, env = d["header"], d["environment"]
    sender = transactions.recover_sender(tx)
    need(hx(sender) == request["from"], "Recovered sender mismatch")
    fields = {
        "chain_id": "chainId", "nonce": "nonce", "gas": "gasLimit",
        "value": "value", "max_fee_per_gas": "maxFeePerGas",
        "max_priority_fee_per_gas": "maxPriorityFeePerGas",
        "y_parity": "yParity", "r": "r", "s": "s",
    }
    need(
        all(
            int(getattr(tx, name)) == quantity(envelope[key])
            for name, key in fields.items()
        ),
        "Signed envelope differs",
    )
    need(
        int(tx.chain_id) == d["chainId"]
        and int(tx.gas) == decimal(request["gas"]) <= 5_000_000,
        "Wrong chain/gas",
    )
    need(
        int(tx.value) == decimal(request["value"])
        and hx(tx.data) == request["data"] == envelope["data"],
        "Signed call data/value differs",
    )
    need(
        int(tx.max_fee_per_gas) == decimal(request["fees"]["maxFeePerGas"])
        and int(tx.max_priority_fee_per_gas)
        == decimal(request["fees"]["maxPriorityFeePerGas"]),
        "Signed fees differ",
    )
    need(tx.access_list == () and envelope["accessList"] == [], "Access list")
    destination = None if len(tx.to) == 0 else hx(tx.to)
    need(
        destination == request["to"] == envelope.get("to")
        and (destination is None) == d["rootCreate"],
        "Signed destination differs",
    )
    if amsterdam:
        intrinsic = transactions.validate_transaction(tx, sender)
        intrinsic_gas, calldata_floor = intrinsic.execution, intrinsic.calldata_floor
    elif fork_name in ("prague", "osaka"):
        intrinsic = transactions.validate_transaction(tx)
        intrinsic_gas, calldata_floor = intrinsic.regular, intrinsic.calldata_floor
    else:
        intrinsic_gas = transactions.validate_transaction(tx)
        calldata_floor = None
    floor_report = None if calldata_floor is None else str(calldata_floor)
    need(
        str(intrinsic_gas) == d["inputGas"]["intrinsic"]
        and floor_report == d["inputGas"]["calldataFloor"],
        "Intrinsic input mismatch",
    )
    joins = {
        "currentCoinbase": "miner", "currentGasLimit": "gasLimit",
        "currentNumber": "number", "currentTimestamp": "timestamp",
        "currentRandom": "mixHash", "currentDifficulty": "difficulty",
        "currentBaseFee": "baseFeePerGas",
    }
    if fork_name != "shanghai":
        joins.update({
            "currentExcessBlobGas": "excessBlobGas",
            "parentBeaconBlockRoot": "parentBeaconBlockRoot",
        })
    if amsterdam:
        joins["slotNumber"] = "slotNumber"
    need(
        all(env[key] == header[value] for key, value in joins.items())
        and env["withdrawals"] == [],
        "Environment/header mismatch",
    )
    target = Address(raw(d["target"], 20))
    target_storage = state._storage_tries.get(target)
    initial_target_root = hx(
        EMPTY_TRIE_ROOT if target_storage is None else root(target_storage)
    )
    need(
        initial_target_root == d["initialTargetStorageRoot"],
        "Target initial storage root differs",
    )

    # Validate execution-environment inputs without constructing an execution
    # environment. Preparation returns before BlockState/BlockEnvironment.
    header_values = {
        key: quantity(header[key])
        for key in ("gasLimit", "number", "baseFeePerGas", "timestamp")
    }
    need(all(v < 2**256 for v in header_values.values()), "Header quantity bound")
    raw(header["parentHash"], 32)
    raw(header["mixHash"], 32)
    raw(header["miner"], 20)
    if fork_name != "shanghai":
        header_values["excessBlobGas"] = quantity(header["excessBlobGas"])
        need(header_values["excessBlobGas"] < 2**64, "Excess blob gas bound")
        raw(header["parentBeaconBlockRoot"], 32)
    if amsterdam:
        header_values["slotNumber"] = quantity(header["slotNumber"])
        need(header_values["slotNumber"] < 2**64, "Slot number bound")
    sender_account = state.get_account_optional(sender)
    need(sender_account is not None, "Sender absent from prestate")
    need(sender_account.nonce == tx.nonce, "Sender nonce differs")
    need(state.get_code(sender_account.code_hash) == b"", "Sender has code")
    need(int(tx.gas) <= header_values["gasLimit"], "Transaction exceeds block gas")
    need(int(tx.max_fee_per_gas) >= header_values["baseFeePerGas"], "Max fee below base")
    need(
        int(sender_account.balance)
        >= int(tx.gas) * int(tx.max_fee_per_gas) + int(tx.value),
        "Sender cannot fund maximum fees and value",
    )
    report = {
        "id": d["id"], "fork": d["fork"], "inputSha256": input_sha,
        "sourceModule": str(Path(fork.__file__).resolve()),
        "signedBytes": d["signedBytes"], "transactionHash": d["transactionHash"],
        "sender": hx(sender), "envelope": envelope, "environment": env,
        "originalStateRoot": original_root, "initialStateRoot": initial_root,
        "initialTargetStorageRoot": initial_target_root,
        "intrinsicGas": str(intrinsic_gas), "calldataFloor": floor_report,
        "headerValidation": "declared_environment_only_not_full_block_validation",
        "scope": "one_signed_transaction_in_stock_" + d["fork"]
        + "_apply_body_with_declared_system_scaffold_and_empty_withdrawals",
        "blockHashContext": "declared_parent_hash_only_no_earlier_hashes_supplied",
    }
    if len(sys.argv) == 5:
        report["status"] = "prepared_no_execution"
        return report

    tracked = state_tracker.BlockState(pre_state=state)
    env_args = {
        "chain_id": U64(d["chainId"]), "state": tracked,
        "block_gas_limit": Uint(header_values["gasLimit"]),
        "block_hashes": [Bytes32(raw(header["parentHash"], 32))],
        "coinbase": Address(raw(header["miner"], 20)),
        "number": Uint(header_values["number"]),
        "base_fee_per_gas": Uint(header_values["baseFeePerGas"]),
        "time": U256(header_values["timestamp"]),
        "prev_randao": Bytes32(raw(header["mixHash"], 32)),
    }
    if fork_name != "shanghai":
        env_args.update({
            "excess_blob_gas": U64(header_values["excessBlobGas"]),
            "parent_beacon_block_root": Bytes32(raw(header["parentBeaconBlockRoot"], 32)),
        })
    if amsterdam:
        bal_module = importlib.import_module(
            "ethereum.forks.amsterdam.block_access_lists"
        )
        need(
            Path(bal_module.__file__).resolve()
            == source / "ethereum/forks/amsterdam/block_access_lists.py",
            "Wrong BAL module path",
        )
        env_args.update({
            "block_access_list_builder": bal_module.BlockAccessListBuilder(),
            "slot_number": U64(header_values["slotNumber"]),
        })
    block_env = BlockEnvironment(**env_args)
    terminal = []

    def trace(evm, event):
        if not isinstance(event, TransactionEnd):
            return
        context = evm if amsterdam else evm.message
        if context.tx_env.tx_hash != tx_hash:
            return
        need(
            len(terminal) == 0 and context.depth == 0
            and len(event.output) <= 65536,
            "Unexpected transaction-end trace",
        )
        terminal.append({
            "returnData": hx(event.output), "gasUsed": str(event.gas_used),
            "error": None if event.error is None else {
                "type": type(event.error).__name__,
                "message": str(event.error)[:2048],
            },
        })

    prior_trace = set_evm_trace(trace)
    try:
        output = fork.apply_body(block_env, (signed,), ())
    finally:
        set_evm_trace(prior_trace)
    diff = state_tracker.extract_block_diff(tracked)
    post_root = hx(state.compute_state_root(diff))
    state_mpt.apply_changes_to_state(state, diff)
    need(hx(state_mpt.state_root(state)) == post_root, "Applied diff root differs")
    need(
        len(state._main_trie._data) <= 64
        and sum(len(t._data) for t in state._storage_tries.values()) <= 1024,
        "Poststate exceeds adapter bound",
    )
    allocation = {}
    for address, account in sorted(state._main_trie._data.items()):
        if account is None:
            continue
        code = state.get_code(account.code_hash)
        need(len(code) <= 65536, "Poststate code exceeds bound")
        storage = state._storage_tries.get(address)
        allocation[hx(address)] = {
            "nonce": hex(account.nonce), "balance": hex(account.balance),
            "code": hx(code),
            "storage": {} if storage is None else {
                hx(key): "0x" + int(value).to_bytes(32, "big").hex()
                for key, value in sorted(storage._data.items()) if value != 0
            },
        }
    need(
        hx(state_mpt.state_root(loader.json_to_state(allocation))) == post_root,
        "Serialized allocation root differs",
    )
    receipt_raw = trie_get(output.receipts_trie, rlp.encode(Uint(0)))
    need(
        type(receipt_raw) is bytes and receipt_raw[:1] == b"\x02"
        and output.receipt_keys == (rlp.encode(Uint(0)),),
        "Expected single type-2 receipt",
    )
    receipt = rlp.decode_to(Receipt, receipt_raw[1:])
    charged_gas = output.cumulative_gas_used if amsterdam else output.block_gas_used
    need(
        receipt.cumulative_gas_used == charged_gas
        and receipt.logs == output.block_logs,
        "Receipt/block totals differ",
    )
    if terminal:
        need(
            receipt.succeeded == (terminal[0]["error"] is None),
            "Root trace/receipt status differs",
        )
    logs = [
        {
            "address": hx(log.address), "topics": [hx(t) for t in log.topics],
            "data": hx(log.data),
        }
        for log in receipt.logs
    ]
    block_gas = (
        max(output.block_gas_used, output.block_state_gas_used)
        if amsterdam else output.block_gas_used
    )
    report.update(
        status="completed", allocation=allocation, stateRoot=post_root,
        receiptBytes=hx(receipt_raw),
        receipt={
            "status": "success" if receipt.succeeded else "failed",
            "chargedGas": str(receipt.cumulative_gas_used), "logs": logs,
        },
        logsHash=hx(keccak256(rlp.encode(receipt.logs))),
        receiptsRoot=hx(root(output.receipts_trie)),
        transactionsRoot=hx(root(output.transactions_trie)),
        blockExecutionGasUsed=str(output.block_gas_used) if amsterdam else None,
        blockStateGasUsed=str(output.block_state_gas_used) if amsterdam else None,
        blockGasUsed=str(block_gas),
        transactionEnd=terminal[0] if terminal else None,
        returnDataAvailability=(
            "official_TransactionEnd" if terminal
            else "unavailable_no_TransactionEnd_event"
        ),
        transactionEndGasMeaning="grant_minus_remaining_before_refund_and_floor",
        target={
            "address": d["target"], "account": allocation.get(d["target"]),
            "storage": {
                str(slot): str(state.get_storage(
                    target, Bytes32(int(slot).to_bytes(32, "big"))
                ))
                for slot in slots
            },
        },
        storageClears=sorted(hx(address) for address in diff.storage_clears),
        requests=(
            [hx(request) for request in output.requests]
            if fork_name in ("prague", "osaka", "amsterdam") else []
        ),
    )
    return report


if __name__ == "__main__":
    # Setup/execution/projection exceptions are failures with retained stderr,
    # never fabricated completed results. The runner owns capture and bounds.
    result = json.dumps(main(), sort_keys=True, separators=(",", ":"))
    need(len(result.encode()) <= 2 * 1024 * 1024, "Output exceeds adapter bound")
    print(result)
