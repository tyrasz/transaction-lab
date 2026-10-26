# Fixed Aave sequence capture preparation

This packet selects three constructed unsigned examples at the same historical block end. It is neither an original signed transaction replay nor a prospective coverage cohort. The older discovery's stopped 12-call capture and separately approved 3-call continuation remain unchanged; all five provenance inputs are hash-pinned and copied at freeze.

The fixed order is:

1. `/api/evm/simulate`: supply alone, hypothesized to revert without allowance.
2. `/api/evm/simulate-sequence`: approve, then supply.
3. `/api/evm/simulate-sequence`: approve, supply, then the same supply again. The final call is hypothesized to execute and revert; earlier verified results must remain available.

All requests omit explicit queries, enabling automatic discovery. Every call retains the discovery's exact sender, recipient, calldata and zero value; the API receives canonical decimal `"0"`. Engine gas is fixed at 5,000,000. No prior output, funding adjustment or guessed allowance slot is passed as an API input. Each case independently starts from block `0x4badf912d1bcc7f77197108544be0ab4b8cef7a94fb7a4ee1e65fda816300dc7`.

## Freeze and execution

`node reports/standard-evm-sequence/freeze.mjs` performs only filesystem work. It copies 52 files: the complete 33-file loader/runtime identity, 13 relevant API/engine tests, three UI files, the Noble license and both capture scripts. The five provenance inputs are separate. Archived tests preserve source provenance; external fixtures referenced by those tests are not an assertion that the entire test suite is standalone inside the packet.

Before writing the final plan, freeze verifies every original input hash, all copied bytes, the loader's exact implementation inventory and fingerprint, and all three bodies using the archived production validators. No validation normalization may alter a request. Source bytes are checked again after imports and validation. `node reports/standard-evm-sequence/run.mjs --check` repeats these checks without opening a socket.

After explicit root authorization and shutdown of the ordinary server, `node reports/standard-evm-sequence/run.mjs` binds the archived application on `127.0.0.1:5174`, sends the three local HTTP requests in order, and closes it. `STARTED.json` is created exclusively before any socket binding or public call; an attempted packet cannot be restarted. Normal service stop/restart and subsequent browser replay belong to root. Browser verification must use saved responses and no additional public requests.

The only public endpoint is `https://eth.drpc.org`. Production transport enforces 65 requests/32 MiB/145 seconds for the single case and 258 requests/128 MiB/265 seconds for each sequence, with 8 MiB per response and 25 seconds per RPC. The runner separately caps all cases at 600 requests, 288 MiB observed RPC bytes and 12 minutes; the fixed profiles allow at most 581 requests. Local HTTP deadlines are 160/280/280 seconds and the explicit HTTP body cap is 512 MiB per case, separate from RPC wire bytes. No retries, replacements, new candidates or fallback providers are allowed. Shutdown has bounded five-second close/drain grace periods. Errors, incomplete bodies, unattempted rows and partial RPC evidence are retained rather than repaired.

## Retention and offline review

For each request the runner retains independent server and client HTTP captures, full parsed JSON when available, exact request/body hashes and byte counts, and an independent production-client RPC snapshot. Successful public RPC response text and its byte hash are retained by the transport; rejected provider bodies retain only their byte count/hash and sanitized failure. `results.json` reports capture completion separately from simulation success and includes the full nested sequence summary. The manifest binds every frozen source, input and generated capture artifact. A fully completed three-response packet is expected to contain 73 manifest entries; errors can yield a smaller explicitly recorded inventory.

Independent offline verification should:

- Check the exact plan/source/manifest inventories, input order, request hashes, source identity and all raw RPC envelope/parameter/body hashes, with an external mismatch latch during archived-handler replay. Exclude only validated generated IDs/timings from semantic comparisons.
- Decode each measured before/after token or allowance return word from its own exact query trace; compare raw measurement fields and deltas. Do not infer measurements from event amounts. Aave receipt-token changes may differ by one unit from USDC principal.
- Reconstruct the complete successful approval state from its validated diff. Step two's original trace, original diff and before-query contexts must use precisely that full state. Its after queries must use the complete composed approval-plus-supply state, including cleared slots. Measurement-call nonce increments must never enter the persistent sequence state.
- Require the final case's third call to have execution/revert evidence, not a skipped result, and retain the first two verified measurements. A synthetic skipped fourth call belongs to offline engine tests, not this live packet.
- Check original/trace/query/header binding, independent scalar read anchors, source block/full final headers, canonical invalidation, resource counters, and retained failures. A measured result is provider evidence, not an independent execution oracle or a security verdict.

The preparation preflight passed without network: all five input hashes; exact loader inventory/fingerprint; all 52 source files readable; three real-validator request checks; 1/2/3 call shapes; exact shared calldata and repeated third-call identity; no explicit queries; exact request hashes. Product test results are reported separately by root.
