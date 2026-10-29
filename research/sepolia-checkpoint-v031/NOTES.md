# Sepolia development checkpoint

All 798 engine tests and 701 application tests pass on the combined source held stable for these runs. The application suite used temporary localhost servers. These are regression counts, not a sample-based estimate of EVM population accuracy. No failed tests or skipped cases occurred in these two runs.

New work includes explicit execution admission, balance-preserving Amsterdam contract clearing, trusted Sepolia fee schedule selection, and refusal of disputed out-of-gas/negative-final-state settlement. The two-client diagnostic independently retains one matching control and one gas/state-root mismatch; its original observations remain immutable.

The public app remains version0.30.0, with Sepolia unsupported. The earlier public-wallet test succeeded through viem and its provider, but the actual product endpoint returned400 UNSUPPORTED_CHAIN. Those are separate outcomes. No real private key, funded wallet creation, signature or broadcast was used.

Next integration work must carry trusted network selection through parent, worker and execution; implement Amsterdam transaction preparation and accounting; bind lifecycle clearing to parent validation and native-value accounting; carry the authenticated slot number; and verify the complete resulting preview before HTTP admission. State-gas disagreement remains unresolved. The current branch is development work and is not promoted to the running app.
