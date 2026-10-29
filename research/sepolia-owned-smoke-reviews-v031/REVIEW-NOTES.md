# Independent saved-artifact review

Both attempts remain **unavailable**, with zero entered execution frames, zero completed native measurements and no transfer result. The reviews made no network requests and did not rerun the EVM. Neither wallet ownership, signed-transaction admission, fee payment, inclusion nor finality is established.

The PublicNode attempt is pinned by capture manifest `fbe7ff9463b50e9728560234170837e3cddfc876d0536c644221c041b2691dab`. All 16 listed artifacts, 1,720 implementation inventory entries (including one symlink), four harness files and the local Node executable match their recorded identities. Four public RPC requests and one local HTTP request were joined to their raw bytes. The first sender proof request returned `-32602`, “distance to target block exceeds maximum proof window.” The selected 23-field Amsterdam header and final reread agree, but no account proof or balance was obtained. The frozen producer's hypothetical late-loopback overwrite edge was not reached in this 2.110-second packet.

The separate 1RPC attempt is pinned by capture manifest `80250020a55703755f9b09330cac8b3b6707f338c71732b3415dd5669a7c2448`. Its 16 artifacts, same 1,720 implementation entries, four separately pinned harness files and Node executable also match. Five public RPC requests and one local HTTP request were joined. The sender proof succeeded; `eth_getCode` then returned HTTP 400/code 35 (plan restriction), and the final header reread returned HTTP 429/code -32005 with `id:null`. The original verifier's strict response-ID assertion failure is a retained verifier limitation; it does not turn this unavailable simulation into a success. This independent checker binds the observed non-200 failures explicitly and never consumes them as successful RPC results.

For the second packet, an independent nine-node secure Merkle Patricia path walk using RLP and Keccak validates the sender leaf against the selected header's state root at block **12020014**, hash `0x0c0c65ab9c4a4433b4208bc1298bb908ae67fcece7d5625cf945e75c8cbc5e44`. The authenticated leaf has nonce **748694**, balance **13136158997187517584658 wei** (**13136.158997187517584658 test ETH**), the empty-code hash and empty-storage root. These are selected-header proof facts, not completed engine inputs: the subsequent code fetch failed, no recipient proof was obtained, and no final-header confirmation was obtained. Four in-memory negative controls reject an altered claimed balance, state root, address and proof node.

Both local public-API observations retain HTTP 400 `UNSUPPORTED_CHAIN`. Source verification is an exact comparison against the currently retained source/dependency files and executable; these packets contain inventories rather than complete archived runtime bytes. Header rehashing and a valid membership proof establish consistency with the supplied header, not consensus or finality.

Run the artifact-only second checker from this worktree with:

```sh
node research/sepolia-owned-smoke-reviews-v031/second-audit.mjs
```

`first-audit.mjs` retains the initially executed fixed absolute worktree path. `second-audit.mjs` resolves the worktree relative to its own location. Both require the recorded source bytes and Node identity; neither provides an execution or network replay option. `first-audit.json` and `second-audit.json` retain their actual successful artifact-review outputs. The surrounding integration checkpoint was separately checked against all 24 manifest files, all 250 source hashes at commit `be305d8593c8a786e5569e34b98d8d9515329070`, and the retained full-run totals of 853/853 engine and 701/701 application tests.
