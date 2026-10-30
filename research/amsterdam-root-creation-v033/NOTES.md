# Root CREATE supplement results

This separate packet corrects the JSON declaration assertion that prevented
three original root inputs from entering either Node execution target. The
original [six-case capture](../amsterdam-storage-creation-v033/NOTES.md) remains
unchanged, with three unavailable root observations per Node path. Its six Geth
observations were reused; Geth was not rerun.

Exactly three product calls ran once each, followed by their three signed
EthereumJS counterparts. Original input bytes and the frozen implementation
were unchanged. The worker transformation is limited to a JSON round trip of
the expected declaration and imports redirected to that frozen implementation.
Three input-only controls passed before freezing (602.5 ms); the agent's earlier
three-control preparation log is also retained. Root review added the original
execution directory to the plan before freezing so saved process arguments can
be verified from a relocated checkout. No post-dispatch source edits were made.

- Root creation at the storage-only target returned unsupported in the product,
  with whole-attempt rollback and no execution prediction. EthereumJS reported a
  creation failure; the saved Geth result deployed while preserving initial
  storage. All seven EthereumJS/Geth comparison channels differ. Product pairs
  remain null.
- The absent-target and empty-storage root controls completed successfully and
  agree across all three implementations on all seven recorded channels:
  execution status, return bytes, charged gas, single-transaction block gas,
  full state root, target account/storage, and logs.

The bounded run took 2.362 seconds and retained 93,809 raw stdout/stderr bytes.
All six processes closed within their bounds, all source and saved-byte checks
passed, and no fatal error was reported. The artifact-only verifier passed,
reconstructing roots from retained outputs and joining the original saved Geth
results. It reused the original pure parser, made no network requests, and did
not execute any target. The verifier result is [verification.json](verification.json).

- Plan SHA-256: `5b122fd04fc426f4f8cca9ae279fd182993ec21ed587ce7208497c8a92e1fcc9`
- Source SHA-256: `9ee836216994116e571a9f6535ac2f30f2a4f5d3ffc5c12242439be34607b466`
- Capture manifest SHA-256: `0280a9e08de06a13ab163f8f7eaec07c65a05b3036058e4095c5a59f1ab0efbd`

These are fixed synthetic inputs, not additional public-chain observations.
The disagreement does not establish a canonical client winner, and the passing
controls do not establish a population accuracy percentage. EELS remains
source-only and was not executed.
