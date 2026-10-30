"""One signed original plus independent, synthetic unpriced query references.

The original adapter is an unchanged source-freeze dependency. Preparation
performs input/signature/state checks only, before every apply_body invocation.
No product output is accepted. Each query half starts from a fresh EELS-owned
initial or settled original allocation; no query changes feed another query.
"""

import copy
import hashlib
import importlib
import importlib.util
import json
import sys
from pathlib import Path


ORIGINAL_PATH = Path(__file__).resolve().parent.parent / "storage-creation-forks-v035/eels-worker.py"
spec = importlib.util.spec_from_file_location("lifecycle_original_adapter", ORIGINAL_PATH)
original = importlib.util.module_from_spec(spec)
spec.loader.exec_module(original)
need, raw, hx = original.need, original.raw, original.hx
quantity, decimal = original.quantity, original.decimal
TEST_KEY = bytes([1]) * 32  # Existing public development fixture key only.
MAX_OUTPUT = 2 * 1024 * 1024


def error_record(error):
    return None if error is None else {
        "type": type(error).__name__, "message": str(error)[:2048]
    }


def validate_templates(d):
    templates, descriptors = d.get("queryTemplates"), d.get("queries")
    need(type(templates) is list and 1 <= len(templates) <= 8, "Query count bound")
    need(type(descriptors) is list and len(descriptors) == len(templates), "Query descriptor count")
    need(d["fork"] in ("Shanghai", "Osaka", "Amsterdam"), "Lifecycle fork scope")
    need(quantity(d["environment"]["currentBaseFee"]) == 7, "Expected source base fee 7")
    raw(d["headerHash"], 32)
    need(d["headerHash"] == d["header"]["hash"], "Source header hash join")
    contracts = 0
    for index, (template, descriptor) in enumerate(zip(templates, descriptors)):
        need(type(template) is dict and type(descriptor) is dict, "Malformed query")
        need(type(template.get("index")) is int and template["index"] == index, "Query ordering")
        need(template.get("phases") == ["before", "after"], "Query phase coverage")
        if template.get("kind") == "native_balance":
            need(set(template) == {"index", "kind", "account", "phases"}, "Native template fields")
            raw(template["account"], 20)
            need(descriptor == {"kind": "native_balance", "account": template["account"]}, "Native descriptor join")
        else:
            need(template.get("kind") == "contract_call", "Unknown query kind")
            need(set(template) == {"index", "kind", "request", "phases"}, "Contract template fields")
            request = template["request"]
            need(type(request) is dict and set(request) == {"from", "to", "data", "value", "gas"}, "Query request fields")
            raw(request["from"], 20)
            raw(request["to"], 20)
            need(len(raw(request["data"])) <= 65536, "Query calldata bound")
            need(request["from"] == d["request"]["from"], "Query sender join")
            need(request["value"] == "0" and request["gas"] == "1000000", "Query value/gas profile")
            need(descriptor == {"to": request["to"], "data": request["data"]}, "Contract descriptor join")
            contracts += 1
    need(contracts <= 2, "Contract query bound")


def neutral_except_sender_nonce(before, after, sender, logs):
    if logs or sender not in before or sender not in after:
        return False
    if quantity(after[sender]["nonce"]) != quantity(before[sender]["nonce"]) + 1:
        return False
    candidate = copy.deepcopy(after)
    candidate[sender]["nonce"] = before[sender]["nonce"]
    return before == candidate


class QueryTrace:
    """Bounded official events, including successful inner ops later reverted."""

    def __init__(self, api, tx_hash):
        self.api, self.tx_hash = api, tx_hash
        self.frames, self.objects, self.active = [], {}, {}
        self.selfdestructs, self.pending = [], {}
        self.terminal, self.events = [], 0

    def __call__(self, evm, event):
        context = evm if self.api.amsterdam else evm.message
        if context.tx_env.tx_hash != self.tx_hash:
            return
        self.events += 1
        need(self.events <= 200000, "Query trace event bound")
        trace = self.api.trace
        if isinstance(event, trace.TransactionEnd):
            need(not self.terminal and int(context.depth) == 0 and len(event.output) <= 65536, "Query terminal trace bound")
            self.terminal.append({"returnData": hx(event.output), "gasUsed": str(event.gas_used), "error": error_record(event.error)})
            return
        if not isinstance(event, (trace.OpStart, trace.OpEnd, trace.OpException, trace.EvmStop)):
            return
        identity, depth = id(evm), int(context.depth)
        if identity not in self.objects:
            need(len(self.frames) < 128 and depth <= 128, "Query frame bound")
            parent = self.active.get(depth - 1) if depth else None
            need(depth == 0 or parent is not None, "Missing traced parent frame")
            frame = {"index": len(self.frames), "parent": parent, "depth": depth,
                     "address": hx(context.current_target), "codeAddress": None if context.code_address is None else hx(context.code_address),
                     "ended": False, "error": None}
            # Hold the object: Python may otherwise reuse identities after return.
            self.objects[identity] = (evm, frame)
            self.frames.append(frame)
        frame = self.objects[identity][1]
        self.active[depth] = frame["index"]
        for stale in [n for n in self.active if n > depth]:
            del self.active[stale]
        if isinstance(event, trace.OpStart):
            if event.op.name == "SELFDESTRUCT":
                need(len(self.selfdestructs) < 64, "SELFDESTRUCT trace bound")
                beneficiary = None if not evm.stack else "0x" + (int(evm.stack[-1]) % 2**160).to_bytes(20, "big").hex()
                row = {"frame": frame["index"], "depth": depth, "address": frame["address"],
                       "beneficiary": beneficiary, "pc": int(evm.pc), "completed": False,
                       "error": None, "committed": None}
                self.selfdestructs.append(row)
                self.pending[identity] = row
        elif isinstance(event, trace.OpEnd):
            if identity in self.pending:
                self.pending.pop(identity)["completed"] = True
        elif isinstance(event, trace.OpException):
            frame["ended"], frame["error"] = True, error_record(event.error)
            if identity in self.pending:
                self.pending.pop(identity)["error"] = error_record(event.error)
        elif isinstance(event, trace.EvmStop):
            frame["ended"] = True

    def finish(self, succeeded):
        for evm, frame in self.objects.values():
            # Code deposit can fail after EvmStop. Read the final object too.
            if evm.error is not None:
                frame["error"] = error_record(evm.error)
        for row in self.selfdestructs:
            frame = self.frames[row["frame"]]
            row["frameError"] = frame["error"]
            cursor, retained = frame, succeeded and row["completed"] and row["error"] is None
            while cursor is not None:
                retained = retained and cursor["ended"] and cursor["error"] is None
                cursor = None if cursor["parent"] is None else self.frames[cursor["parent"]]
            row["committed"] = bool(retained)
        return {"source": "official_EELS_trace_events", "eventCount": self.events,
                "frames": self.frames, "selfdestructs": self.selfdestructs}


class ReferenceAPI:
    def __init__(self, d, toolchain):
        self.d, self.source = d, (toolchain / "source/src").resolve()
        self.fork_name = original.FORKS[d["fork"]]
        self.amsterdam = self.fork_name == "amsterdam"
        from ethereum_rlp import rlp
        from ethereum_types.bytes import Bytes32
        from ethereum_types.numeric import U64, U256, Uint
        from ethereum import state_mpt, trace
        from ethereum.crypto.hash import keccak256
        from ethereum.merkle_patricia_trie import root, trie_get
        from ethereum.state import Address
        from ethereum_spec_tools.loaders.fixture_loader import Load
        import spec256k1
        need(Path(spec256k1.__file__).resolve().is_relative_to((toolchain / "venv").resolve()), "Signing library outside pinned venv")
        self.rlp, self.Bytes32, self.U64, self.U256, self.Uint = rlp, Bytes32, U64, U256, Uint
        self.state_mpt, self.trace, self.keccak, self.root, self.trie_get = state_mpt, trace, keccak256, root, trie_get
        self.Address, self.loader, self.signer = Address, Load(self.fork_name), spec256k1.PrivateKey(TEST_KEY)
        self.signing_module = str(Path(spec256k1.__file__).resolve())
        self.fork, self.tracker, self.transactions, self.blocks, self.vm, self.bloom = [
            self.module(name) for name in ("fork", "state_tracker", "transactions", "blocks", "vm", "bloom")
        ]

    def module(self, name):
        module = importlib.import_module(f"ethereum.forks.{self.fork_name}.{name}")
        suffix = "vm/__init__.py" if name == "vm" else name + ".py"
        need(Path(module.__file__).resolve() == self.source / "ethereum/forks" / self.fork_name / suffix, "Wrong query EELS module path")
        return module

    def state(self, allocation):
        original.check_allocation(allocation)
        state = self.loader.json_to_state(allocation)
        return state, hx(self.state_mpt.state_root(state))

    def signed_query(self, request, allocation):
        sender = request["from"]
        need(sender in allocation and allocation[sender]["code"] == "0x", "Query sender absent or has code")
        nonce = quantity(allocation[sender]["nonce"])
        need(nonce < 2**64 - 1, "Query nonce bound")
        fields = dict(chain_id=self.U64(self.d["chainId"]), nonce=self.U256(nonce),
                      max_priority_fee_per_gas=self.Uint(0), max_fee_per_gas=self.Uint(0),
                      gas=self.Uint(1000000), to=self.Address(raw(request["to"], 20)),
                      value=self.U256(0), data=raw(request["data"]), access_list=(),
                      y_parity=self.U256(0), r=self.U256(0), s=self.U256(0))
        tx = self.transactions.FeeMarketTransaction(**fields)
        signature = self.signer.sign_recoverable(self.transactions.signing_hash_1559(tx))
        need(type(signature) is bytes and len(signature) == 65 and signature[64] in (0, 1), "Recoverable query signature format")
        fields.update(r=self.U256(int.from_bytes(signature[:32], "big")),
                      s=self.U256(int.from_bytes(signature[32:64], "big")), y_parity=self.U256(signature[64]))
        tx = self.transactions.FeeMarketTransaction(**fields)
        signed = self.transactions.encode_transaction(tx)
        need(self.transactions.encode_transaction(self.transactions.decode_transaction(signed)) == signed, "Query transaction roundtrip")
        recovered = self.transactions.recover_sender(tx)
        need(hx(recovered) == sender, "Public fixture key differs from query sender")
        if self.amsterdam:
            cost = self.transactions.validate_transaction(tx, recovered)
            intrinsic, floor = cost.execution, cost.calldata_floor
        elif self.fork_name == "osaka":
            cost = self.transactions.validate_transaction(tx)
            intrinsic, floor = cost.regular, cost.calldata_floor
        else:
            intrinsic, floor = self.transactions.validate_transaction(tx), None
        envelope = {"type": "0x2", "chainId": hex(self.d["chainId"]), "nonce": hex(nonce),
                    "gasLimit": hex(1000000), "to": request["to"], "value": "0x0", "data": request["data"],
                    "maxFeePerGas": "0x0", "maxPriorityFeePerGas": "0x0", "accessList": [],
                    "yParity": hex(tx.y_parity), "r": hex(tx.r), "s": hex(tx.s)}
        return tx, signed, {"signedBytes": hx(signed), "transactionHash": hx(self.keccak(signed)),
                           "envelope": envelope, "senderNonceBefore": str(nonce),
                           "intrinsicGas": str(intrinsic), "calldataFloor": None if floor is None else str(floor)}

    def block_environment(self, tracked):
        h = self.d["header"]
        args = dict(chain_id=self.U64(self.d["chainId"]), state=tracked,
                    block_gas_limit=self.Uint(quantity(h["gasLimit"])),
                    block_hashes=[self.Bytes32(raw(h["parentHash"], 32))], coinbase=self.Address(raw(h["miner"], 20)),
                    number=self.Uint(quantity(h["number"])), base_fee_per_gas=self.Uint(0),
                    time=self.U256(quantity(h["timestamp"])), prev_randao=self.Bytes32(raw(h["mixHash"], 32)))
        if self.fork_name != "shanghai":
            args.update(excess_blob_gas=self.U64(quantity(h["excessBlobGas"])),
                        parent_beacon_block_root=self.Bytes32(raw(h["parentBeaconBlockRoot"], 32)))
        if self.amsterdam:
            args.update(block_access_list_builder=self.module("block_access_lists").BlockAccessListBuilder(),
                        slot_number=self.U64(quantity(h["slotNumber"])))
        return self.vm.BlockEnvironment(**args)

    def serialize_state(self, state):
        need(len(state._main_trie._data) <= 64 and sum(len(t._data) for t in state._storage_tries.values()) <= 1024, "Query poststate bound")
        result = {}
        for address, account in sorted(state._main_trie._data.items()):
            if account is None:
                continue
            code, storage = state.get_code(account.code_hash), state._storage_tries.get(address)
            need(len(code) <= 65536, "Query poststate code bound")
            result[hx(address)] = {"nonce": hex(account.nonce), "balance": hex(account.balance), "code": hx(code),
                "storage": {} if storage is None else {hx(k): "0x" + int(v).to_bytes(32, "big").hex() for k, v in sorted(storage._data.items()) if v != 0}}
        original.check_allocation(result)
        return result

    def query(self, request, initial, expected_root):
        # The stock wrapper still performs zero-valued fee credits and system
        # calls. Bind the declared inert scaffold and nonempty coinbase that
        # keep these wrapper touches explicit and harmless for this matrix.
        for address in original.SYSTEMS:
            need(initial.get(address) == self.d["allocation"][address], "Query system scaffold changed")
        coinbase = initial.get(self.d["header"]["miner"])
        need(coinbase is not None and (quantity(coinbase["nonce"]) != 0 or coinbase["code"] != "0x"), "Query needs declared nonempty coinbase")
        state, initial_root = self.state(initial)
        need(initial_root == expected_root, "Query initial root mismatch")
        _, signed, identity = self.signed_query(request, initial)
        tracked = self.tracker.BlockState(pre_state=state)
        block_env = self.block_environment(tracked)
        trace = QueryTrace(self, self.keccak(signed))
        prior_trace = self.trace.set_evm_trace(trace)
        try:
            output = self.fork.apply_body(block_env, (signed,), ())
        finally:
            self.trace.set_evm_trace(prior_trace)
        diff = self.tracker.extract_block_diff(tracked)
        post_root = hx(state.compute_state_root(diff))
        self.state_mpt.apply_changes_to_state(state, diff)
        need(hx(self.state_mpt.state_root(state)) == post_root, "Query diff root mismatch")
        allocation = self.serialize_state(state)
        need(self.state(allocation)[1] == post_root, "Query serialized root mismatch")
        key = self.rlp.encode(self.Uint(0))
        receipt_raw = self.trie_get(output.receipts_trie, key)
        need(type(receipt_raw) is bytes and receipt_raw[:1] == b"\x02" and output.receipt_keys == (key,), "Query single receipt")
        receipt = self.rlp.decode_to(self.blocks.Receipt, receipt_raw[1:])
        charged = output.cumulative_gas_used if self.amsterdam else output.block_gas_used
        need(receipt.cumulative_gas_used == charged and receipt.logs == output.block_logs, "Query receipt totals")
        need(receipt.bloom == self.bloom.logs_bloom(receipt.logs), "Query receipt bloom")
        need(len(receipt.logs) <= 1024, "Query log count bound")
        logs = [{"address": hx(log.address), "topics": [hx(t) for t in log.topics], "data": hx(log.data)} for log in receipt.logs]
        need(all(len(raw(log["data"])) <= 65536 and len(log["topics"]) <= 4 for log in logs), "Query log bound")
        terminal = trace.terminal[0] if trace.terminal else None
        if terminal is not None:
            need(receipt.succeeded == (terminal["error"] is None), "Query trace/receipt status mismatch")
        execution_status = "success" if receipt.succeeded else "reverted" if terminal and terminal["error"]["type"] == "Revert" else "failed"
        lifecycle = trace.finish(receipt.succeeded)
        target_observed = any(row["address"] == self.d["target"] and row["beneficiary"] == self.d["target"]
                              and row["completed"] and row["error"] is None and row["frameError"] is None for row in lifecycle["selfdestructs"])
        block_gas = max(output.block_gas_used, output.block_state_gas_used) if self.amsterdam else output.block_gas_used
        environment = dict(self.d["environment"], currentBaseFee="0x0")
        requests = [hx(r) for r in output.requests] if self.fork_name in ("osaka", "amsterdam") else []
        return {"status": "observed", "request": request, **identity,
                "inputStateRoot": initial_root, "initialAllocation": initial, "allocation": allocation, "stateRoot": post_root,
                "sourceHeaderHash": self.d["headerHash"], "sourceEnvironment": self.d["environment"], "environment": environment,
                "entrypoint": "stock_" + self.d["fork"] + "_apply_body", "executionStatus": execution_status,
                "returnData": None if terminal is None else terminal["returnData"], "chargedGas": str(charged),
                "singleTransactionBlockGasUsed": str(block_gas), "blockGasUsed": str(block_gas),
                "blockExecutionGasUsed": str(output.block_gas_used) if self.amsterdam else None,
                "blockStateGasUsed": str(output.block_state_gas_used) if self.amsterdam else None,
                "logs": logs, "receipt": {"status": "success" if receipt.succeeded else "failed", "chargedGas": str(charged), "logs": logs},
                "receiptBytes": hx(receipt_raw), "receiptBloom": hx(receipt.bloom),
                "receiptsRoot": hx(self.root(output.receipts_trie)), "transactionsRoot": hx(self.root(output.transactions_trie)),
                "logsHash": hx(self.keccak(self.rlp.encode(receipt.logs))), "transactionEnd": terminal,
                "transactionEndGasMeaning": "grant_minus_remaining_before_refund_and_floor",
                "returnDataAvailability": "official_TransactionEnd" if terminal else "unavailable_no_TransactionEnd_event",
                "storageClears": sorted(hx(address) for address in diff.storage_clears), "requests": requests,
                "neutralExceptSenderNonce": neutral_except_sender_nonce(initial, allocation, request["from"], logs),
                "targetSelfdestructObserved": target_observed, "lifecycle": lifecycle}


def main():
    need(len(sys.argv) in (4, 5) and (len(sys.argv) == 4 or sys.argv[4] == "--prepare-only"), "Expected INPUT TOOLCHAIN EXPECTED_INPUT_SHA256 [--prepare-only]")
    need(sys.flags.isolated and sys.dont_write_bytecode, "Use python -I -B")
    path, toolchain = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    need(path.is_file() and path.stat().st_size <= 128 * 1024, "Input bound")
    encoded = path.read_bytes()
    need(hashlib.sha256(encoded).hexdigest() == sys.argv[3], "Input digest mismatch")
    d = json.loads(encoded, object_pairs_hook=original.unique, parse_constant=original.reject_constant)
    validate_templates(d)
    # Always validate the original without executing before query admission.
    saved_argv = sys.argv[:]
    try:
        sys.argv = saved_argv[:4] + ["--prepare-only"]
        prepared = original.main()
    finally:
        sys.argv = saved_argv
    api = ReferenceAPI(d, toolchain)
    initial_root = api.state(d["allocation"])[1]
    need(initial_root == d["initialStateRoot"], "Initial query allocation root mismatch")
    query_preparation = []
    for template in d["queryTemplates"]:
        if template["kind"] == "contract_call":
            _, _, identity = api.signed_query(template["request"], d["allocation"])
            query_preparation.append({"index": template["index"], "phase": "before", "status": "prepared_no_execution", **identity})
    scope = {"profile": "synthetic_unpriced_context", "sourceBaseFee": "7", "executionBaseFee": "0", "gasPrice": "0",
             "sourceHeaderHash": d["headerHash"], "canonicalHeaderRehashed": False,
             "entrypoint": "stock_apply_body_signed_type2_zero_fee", "senderNonceSource": "each_reference_snapshot",
             "snapshotSource": "EELS_initial_or_settled_original_allocation", "queryWritesReused": False,
             "queryGasLimit": "1000000", "signingModule": api.signing_module,
             "wrapperCaveat": "stock_system_processing_and_zero_fee_credits_retained; inert_system_scaffold_and_preexisting_nonempty_query_coinbase"}
    if len(saved_argv) == 5:
        return {**prepared, "queryReferenceScope": scope, "queryTemplates": d["queryTemplates"], "queryPreparation": query_preparation,
                "queryReferences": [{"index": t["index"], "kind": t["kind"], "template": t,
                                     "before": {"status": "prepared_no_execution"}, "after": {"status": "prepared_no_execution"}} for t in d["queryTemplates"]]}
    report = original.main()
    need(report["status"] == "completed", "Original did not complete")
    settled_root = api.state(report["allocation"])[1]
    need(settled_root == report["stateRoot"], "Settled original root mismatch")
    rows = []
    for template in d["queryTemplates"]:
        row = {"index": template["index"], "kind": template["kind"], "template": template}
        for phase, allocation, state_root in (("before", d["allocation"], initial_root), ("after", report["allocation"], settled_root)):
            if template["kind"] == "native_balance":
                account = allocation.get(template["account"])
                row[phase] = {"status": "observed", "account": template["account"], "inputStateRoot": state_root,
                              "balance": str(0 if account is None else quantity(account["balance"]))}
            else:
                # No recovery/retry: malformed or failed execution invalidates
                # this process; the outer driver retains raw failure evidence.
                row[phase] = api.query(template["request"], allocation, state_root)
        rows.append(row)
    return {**report, "queryReferenceScope": scope, "queryReferences": rows}


if __name__ == "__main__":
    result = json.dumps(main(), sort_keys=True, separators=(",", ":"))
    need(len(result.encode()) <= MAX_OUTPUT, "Lifecycle output bound")
    print(result)
