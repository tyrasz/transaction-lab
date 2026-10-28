# Direct commit diagnostic: observed result

This note is outside the sealed diagnostic capture. The one approved diagnostic invocation completed in a 15.145-second packet, with both source and intermediate-artifact integrity checks passing. It performed no transaction, VM, statetest, public RPC or original-case rerun. The original fee comparison remains **14 matched and 2 mismatched**.

The [raw process output](capture/raw.json) directly corroborates the earlier source-path diagnosis:

| Fresh state | Intermediate root | Commit result |
| --- | --- | --- |
| Exact original case-007 allocation; zero coinbase increment | `0xf59c7d63a4249f1ab3093109a4306dceda125b7c53242425ede4d60780fc443f` | Zero root; `unexpected storage wiping, 9999999999999999999999999999999999999999` |
| Same allocation, only coinbase storage changed to empty; same zero increment | Same intermediate root | Same root committed successfully; no error |

Both controls remove the empty coinbase account. The first begins with slot 991 equal to 91; the second begins with no storage. The differing commit outcomes isolate the existing nonempty-storage deletion guard. These diagnostic roots are **not transaction poststate roots**: no sender debit, nonce increment or message was executed. The diagnostic establishes the direct commit error for this synthetic state; it does not establish mainnet reachability, repair Geth, or turn either original failed statetest into a pass. See the [original explanation and pinned source anchors](../NOTES.md).

The [result](capture/results.json) retains seven corroborating checks, all true. A separate bounded artifact-only check verified the exact inventory hashes, sizes and modes; frozen source/input identities; original case-007 input join; the single storage-map difference; all four process records and lossless raw streams; recorded process paths; compiled diagnostic, Go and original Geth binary identities; raw-output/result equality; and every stated diagnostic observation. No rebuild or executable invocation was used for that check. It did not repeat the original before/after source scan or claim independent external chronology.

Identities:

- Plan: `e8dbd73cad60e090cef0280fdda27e8f43226751f9ee1647d178102a6f4d7838`.
- Input: `a85f1fcea303e54fc9fc364847c52eb4ef098b4150a7793ef9ac55ff4c4cc84b`.
- Evidence manifest: `632afe5700855360c634b390b2bd97f2ffa87c584ebe966607083d8a593ac4ed`.
- Retained diagnostic binary: `030b40a3a3143fe4be6dd931b71ca7081631e85f2579bba5233d0bed1e00f706` (15,606,738 bytes).
- Original fee evidence manifest remains `43d8d063d06ceea69ef3ef3f4a71cac0c227f47fc32c1993212af8fd7b5b6d7a`.

The diagnostic manifest binds 15 files totaling 18,681,696 bytes; including its 2,601-byte manifest, the sealed capture totals 18,684,297 bytes. Process stdout/stderr total 954 bytes. The frozen plan identifies 15,657 files in the installed Go distribution; that inventory is metadata, not an additional archived copy of Go. The retained binary and source are supplemental diagnostic artifacts, not a patched Geth toolchain.
