# Refuse unresolved Amsterdam settlement

The standalone gas helper now rejects post-target out-of-gas settlement with LOCAL_ETHEREUM_STATE_GAS_UNSUPPORTED. The immutable sibling two-client diagnostic captured a 20,000,000 versus 16,777,216 gas disagreement for that path. This update neither rewrites that packet nor selects a client's result as canonical. It removes the prior exception that could report a regular dimension above the regular gas limit.

A negative final transaction state-gas counter is also explicitly unsupported. Legitimate signed frame counters and negative reservoir deltas are different: a cross-frame refill can increase the reservoir above its initial value, and that case remains supported without clamping. No reachable negative-final-state transaction has been established.

All 14 focused controls pass, including actual signed full-VM transactions for creation, state allocation and clear, refunds, authorization preparation, rollback, nested refills and the retained out-of-gas behavior. These controls share EthereumJS with the helper and are not independent-client coverage. The out-of-gas fixture still records the library's 20M charge, while requiring local settlement to refuse it. Direct controls refuse both drained and preserved reservoir alternatives when flagged as the disputed path.

This helper remains unwired to public execution. Sepolia and Amsterdam are still unsupported by the public endpoint, and this change does not establish universal EVM accuracy.
