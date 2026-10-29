# Sepolia proof and ancestry chain binding

This development step adds an explicit, trusted chain selection to sparse-input reproof and authenticated header ancestry. Defaults remain Ethereum mainnet. The worker and public API still use those defaults and still reject Sepolia; this change alone enables no public execution path.

The collector carries its selected Ethereum network into ancestry verification. Every ancestor is verified with that network's schedule at the ancestor's own timestamp. The synthetic transition fixture crosses from an Amsterdam source header to BPO2 ancestors and checks the two different header shapes, exact parent links, heights and timestamps. Sepolia ancestry snapshots retain network/schedule metadata; mainnet snapshots keep their previous shape. Unsupported or inconsistent network/header combinations fail before ancestor transport dispatch.

The fact validator accepts a parent-supplied expected chain and requires the claimed context to match before accessing its private proof cache. That cache remains keyed by the cryptographic proof inputs: the same state-root proof is mathematically valid across networks. Neither this cache nor a header hash establishes network membership, consensus or finality. The parent must still bind source context to its selected endpoint and chain handshake.

All **26 focused tests pass**, covering existing mainnet proofs/ancestry as well as Sepolia account absence, storage, cached reproof, changed network labels, malformed ancestor metadata, the upgrade boundary and BLOCKHASH range behavior. Independent code review repeated all 26 controls successfully. These checks use synthetic authenticated initial state and saved header templates, with no EVM execution or public requests.

The next integration step must carry the same trusted chain through parent/worker identity, preview queries, execution context and HTTP admission. Current acceptance remains closed until those paths and Amsterdam runtime rules are separately verified.
