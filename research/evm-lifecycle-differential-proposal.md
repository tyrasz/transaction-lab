# Proposed synthetic differential check — not frozen or executed

Use all sixteen identities already fixed in
`evm-lifecycle-conformance-v1/proposal.json`, retaining every unsupported,
unavailable or mismatched result without substitution. This is a separate
synthetic experiment; its outcomes cannot change the official signed results.

For each identity, declare a new transaction with the same initial allocation,
sender, destination (including creation), calldata, value, nonce and secret key.
Set gas to `min(original gas, 5,000,000)`, gas price and block base fee to zero.
All selected transactions are legacy type 0; no access list, authorization or
blob context needs transformation. Declare one valid synthetic Ethereum header
per initial state with a mainnet Osaka timestamp/number, the original coinbase,
randomness and block gas limit, and the newly computed initial state root.
Both executions must consume exactly this header and transaction. Any changed
environmental fields are listed explicitly before freezing. Missing ancestry
stays unsupported, with no invented block hashes.

Build three independent full state managers from the same fixture **pre**
allocation. One remains immutable and answers the product's bounded account,
storage-proof and bytecode requests. A second performs a genuinely signed,
zero-price full-VM `runTx` without admission skips. A third applies only the
product's validated net changes to the same initial allocation, including whole
account deletion, then computes its complete Merkle root. Reference execution
outputs and official expected poststates never enter the proof source or either
execution request. Run the product first and seal its inputs/output before the
reference executes.

Compare execution status, return bytes, ordered logs, charged gas (including
creation intrinsic costs, refunds and calldata floor), and the complete final
Merkle root. Also retain and compare explicit account/code/storage changes for
the union of initial and observed affected identities; an absent account must
stay distinct from an existing empty one. A complete root comparison detects
unlisted slot or account changes without pretending sparse changes enumerate
all storage. Root reverts must retain only the valid transaction-level effects.

This is practical with the existing full-state fixture loader, product isolated
executor, proof utilities and full-VM scope. New work is a small synthetic
declaration/header builder, immutable proof adapter, complete-state application
and comparator, and a frozen bounded runner. Preserve the product's normal
unsupported paths and limits; do not raise them to force agreement. Static
inspection found no initially existing empty account in these sixteen inputs,
but execution may still encounter unsupported behavior. Record it as such.

Independence is limited: both paths use pinned EthereumJS opcode execution. The
comparison exercises different transaction/finalization/state paths, including
our sparse overlays, proof reconstruction, deletion masking and parent checks.
It is not a second independent EVM implementation and does not establish full
signed-fee, admission, consensus, or general EIP-161 support in the product.
