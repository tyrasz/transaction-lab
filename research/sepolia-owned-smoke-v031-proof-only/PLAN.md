# Third declared owned-engine Sepolia smoke: proof-derived empty code

This separately declared development check uses the public EOA
`0x6efb29cee3b414272eb7a8f3ebabf873d36bc033` retained by `sepolia-smoke-v2`.
It does not select a different wallet or alter an outcome-dependent request.
The unsigned call sends exactly `1000000000000000` wei (0.001 test ETH) to
`0x000000000000000000000000000000000000dead`, with data `0x`, total gas
`21000`, and the default unpriced profile. Two explicit native-balance queries
measure that sender and recipient. No signing, broadcasting, funding, state
overrides, faucet, fee settlement, provider execution oracle or transaction
inclusion is involved. Wallet ownership is not claimed.

The one public endpoint is `https://rpc.sepolia.ethpandaops.io`, listed in the
Ethereum Lists Sepolia network definition at
https://github.com/ethereum-lists/chains/blob/master/_data/chains/eip155-11155111.json
(reviewed before dispatch). This is a separately declared third supplier attempt.
The engine now derives exact empty runtime bytes only from a verified account
proof committing to empty code or proving account absence. Such accounts require
no eth_getCode transport; provenance retains the real proof ID, null code ID and
an explicit derivation label. Nonempty runtime still requires a code response
whose hash matches the proof. The second 1RPC attempt remains immutable in
../sepolia-owned-smoke-v031-1rpc, manifest
80250020a55703755f9b09330cac8b3b6707f338c71732b3415dd5669a7c2448.
It verified the sender proof, then failed at code retrieval and final-header
confirmation. Both previous failures remain in the three-attempt record.
This attempt does not contact either previously failing endpoint.
The first PublicNode attempt is immutable in `../sepolia-owned-smoke-v031`
(manifest `fbe7ff9463b50e9728560234170837e3cddfc876d0536c644221c041b2691dab`):
its first account proof returned -32602, so no accounts or execution were
verified. That failure remains in the three-attempt record. It is not discarded
or silently retried. The harness retains the second-attempt correction that preserves the saved HTTP observation if its terminal phase check
subsequently fails; that edge did not occur in the first 2.110-second attempt. The fixed sequence is: `eth_chainId`; one latest full
header; the exact fixed isolated preview with trusted numeric chain 11155111;
and a final `eth_getBlockByNumber` at the selected number. During the preview,
only `eth_getProof` and `eth_getCode` for the two declared accounts with
`{blockHash: selectedHash, requireCanonical: true}` are allowed. No storage
slots, ancestry, balance aliases, `eth_call`, `eth_simulateV1`, retries,
fallback providers or substitutions are admitted. The worker's demanded proof
and code replies are recorded exactly; expected poststate is never an input.

The isolated result is durably saved before the final header read. A separate
single POST to `http://127.0.0.1:5174/api/evm/local-preview` records the running
main application's chain admission using the same request and selected hash.
That HTTP observation is separate from the internal engine result; the current
public API is expected to reject Sepolia. No server is restarted or modified.

Public dispatch is capped at 12 requests, 2 MiB per response and 8 MiB total;
each request has at most 25 seconds. Selection ends by 30 seconds; the worker
phase ends by 85 seconds with at most 55 seconds of child execution; the final
header ends by 110 seconds; the loopback observation ends by 115 seconds.
Terminal cancellation/drain has at most 5 seconds and the whole active attempt
at most 120 seconds, checked using both wall and monotonic clocks. Native fetch
and body reads are cancelled and tracked; pending work, clock reversal, exceeded
limits, malformed replies, source drift or failed persistence make the result
unusable. A failed proof method/hash selector or a changed sender/recipient
state is retained without replacing the request. In particular, 21000 gas can
be insufficient if the recipient is absent or executes code.

Before dispatch, an exclusive STARTED file and plan bind the exact harness
source hashes, complete local loader/runtime/dependency inventory and Node
executable hash. The same source identity is checked after the attempt. This
packet records that complete inventory rather than copying another dependency
archive. All saved artifact hashes are rechecked against their original write
identities before the final manifest. No parallel work is allowed to save a
late unmanifested wire file. Errors and unavailable/partial outcomes remain
visible. An artifact-only verifier checks hashes, exact RPC joins, full header,
account proofs, and retained native arithmetic without rerunning the EVM.

Successful proof binding establishes consistency with the selected header's
state root, not consensus/finality, an independent-client accuracy result,
automatic complete effect coverage, fee effects or public HTTP Sepolia support.
The earlier v2 provider-only result and incomplete v1 failure packet remain
unchanged and are not used as expected poststate.
