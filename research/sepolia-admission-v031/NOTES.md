# Explicit execution admission

Header verification, query identity and ancestry support for Sepolia do not establish executable Sepolia support. The Ethereum call wrapper now accepts an explicit trusted numeric chain selector and routes it through a central execution admission check before any state access. Both Sepolia BPO2 and Amsterdam remain unsupported. Request or header chain fields cannot change the host-selected network. Unknown or noncanonical selectors also fail before state access.

The admitted mainnet Shanghai-through-BPO2 behavior remains unchanged. Default and explicit mainnet execution produce identical gas, profile, environment, logs and state changes. The old unsupported-fork message is preserved; malformed-header messages can now come from the stricter network selector. No parent, worker, HTTP or execution-engine integration is enabled by this change.

All 43 focused controls pass in both the implementation run and independent review. They include the saved, hash-verified live Sepolia header, query identity support, execution refusal, hostile chain selectors and mainnet parity. These checks use local fixtures; no live request or broadcast occurs.
