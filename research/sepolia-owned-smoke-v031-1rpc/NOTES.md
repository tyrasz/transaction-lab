# Second declared Sepolia attempt: unavailable

This separate, one-shot attempt used the documented public endpoint https://public.1rpc.io/sepolia (https://docs.1rpc.io/overview/supported-networks). The preceding PublicNode attempt in ../sepolia-owned-smoke-v031 remains unchanged and unavailable. Both attempts remain in the record: zero completed live owned executions out of two attempts. No further public attempt was made.

The request stayed fixed: sender 0x6efb29cee3b414272eb7a8f3ebabf873d36bc033, recipient 0x000000000000000000000000000000000000dead, 1000000000000000 wei (0.001 test ETH), gas 21000, empty calldata, chain 11155111, unpriced execution and explicit native queries for those two accounts. No signature, broadcast, funding override, code override, faucet, wallet substitution, retry or implicit fallback was used. The second harness changed the endpoint/provenance and the previously identified late-loopback failure-retention edge before freezing. Its five offline preparation controls passed.

The endpoint selected block 12020014, hash 0x0c0c65ab9c4a4433b4208bc1298bb908ae67fcece7d5625cf945e75c8cbc5e44. Its full 23-field Amsterdam header hash verifies. The sender eth_getProof response succeeded, but the next hash-bound eth_getCode request returned HTTP 400 / code 35: “chain is not available on free plan, please upgrade to paid plan.” The final same-number header reread returned HTTP 429 / code -32005, id:null, reporting a rate limit. These are retained provider messages, not requests to use a paid service or sign up. Final header confirmation is false.

No complete account/code pair was accepted into the engine, no EVM frame or opcode ran, and native before/after measurements were not attempted. The local result is unavailable; it establishes no successful transfer or measured balance change. The separate current-main loopback request returned HTTP 400 UNSUPPORTED_CHAIN, “Only Ethereum chain 1 is supported.” Public HTTP admission remains separate from internal execution support.

The saved nine-node sender account proof was subsequently checked offline against the selected header stateRoot. It authenticates balance 13136158997187517584658 wei (13136.158997187517584658 test ETH), nonce 748694, empty storage root and codeHash 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470. The latter commits to empty runtime bytes. This proof fact does not replace the refused code response in the original engine inputs, and does not establish consensus, finality or successful final header reread. The account-only proof audit is retained under audit/sender-proof.json; its initial code observation remains unknown when no bytes are supplied.

Five public JSON-RPC calls and one loopback request are retained; total response bytes including loopback were 18491. Transport drained completely, source identity remained unchanged, and terminal integrity checks completed at 26070.927292 milliseconds. The capture contains 16 manifested files plus its manifest.

The original frozen verifier rejected the legitimate HTTP 429 JSON-RPC error because id:null differs from request id 5. That failure is retained at audit/original-verifier-failure.log, and neither the frozen verifier nor any captured byte was edited. The separately declared audit/verify.mjs accepts a non-200 reply with matching or null id only when it is error-only, the wire retains a transport error, and the entire result remains unusable. It never admits a non-200 result as success. The supplement passed exact inventory, wire, broker/input, selected-header and loopback joins. Four artifact-only controls passed, including resealed result/usable forgeries and account-proof field/root tampering; these performed no VM execution or network request.

Capture manifest SHA256: 80250020a55703755f9b09330cac8b3b6707f338c71732b3415dd5669a7c2448
Plan file SHA256: f28b4d4d8d2b365a26099acce3d42f6a480026576337c7db1aa1c437bea3b370
Combined harness/runtime identity: 546a238ab1165baf48b5bf1ca02a9c856836c03c72b43b7d4b5edc35d212a4e8
Local implementation identity: 5ab9c93ad59c6b7f8c5d16e8f5da2cf951aa69bc7513b6d9c43b3a0b216a322a

Runtime files and Node identity are recorded in the source inventory rather than copied into a second dependency archive. This packet supplies no independent-client correctness, complete effect inventory, fee, inclusion or destination-credit claim.
