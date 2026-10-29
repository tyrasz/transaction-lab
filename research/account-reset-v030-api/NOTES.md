# Account reset: synthetic API development check

Two fixed synthetic cases ran once through the production 0.30.0 request listener, local loader, proof transport and isolated child. The request listener was invoked in process; this is handler serialization coverage, not a browser or socket check. Every proof/code response came from the declared authenticated fixture. No public RPC, wallet operation or independent client ran.

Both original calls succeeded and deleted the old target under Shanghai rules. In the neutral case, the before query encountered a CREATE2 collision and returned 0. After the deletion, the query recreated the target, its constructor read fresh zero storage and installed new code, that code returned 43, and the enclosing helper reverted. The API retained the measured 0→43 result because the creator nonce, value transfer, code and storage changes were rolled back. The native balance query retained 17→0 wei.

The retaining case returned 43 from successful query execution but left recreation behind. Its measurement is unavailable, with null public values; the report is partial. The later native balance query still measured 17→0 wei from the original overlay. This is the intended mutation boundary, not a failed original execution.

The scalar uses the existing balance-query shape only to exercise a disposable getter. The synthetic value 43 is not evidence about a real token, asset price, public transaction or general accuracy rate. These were known development fixtures, not a prospective sample.

- Product source identity: `ea26e7722f41544341f38f282492917fd1425d8ed9ecf250314d06f052b0d4e0`.
- Capture manifest: `ac76e782d425895f5ea237a35ea069a88edde4c3c5ac21ffaecfb68ca95fd500`.
- Two cases, 16 synthetic RPC replies each; source identity unchanged at all capture checks.
- `baseline-gap.tap` preserves the pre-fix neutral-query failure. `preview-controls.tap` records 6 passing query/parent controls; `api-controls.tap` records the passing handler integration group covering both scenarios.

The declaration retains the complete product/runtime identity and the capture/fixture file hashes. It does not copy the runtime dependency tree into this compact packet. `verify.mjs` checks saved inventory, transport-byte joins and result consistency without executing a VM or making requests; `verification.json` retains its result. This checker is not an independent proof or EVM reexecution.

From the repository root, the artifact-only check is `node research/account-reset-v030-api/verify.mjs`. Do not rerun `capture.mjs` into the sealed capture directory.
