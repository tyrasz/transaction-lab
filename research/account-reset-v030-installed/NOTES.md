# Installed evidence verification — 0.30.0

Main was fast-forwarded to evidence commit `0098ff75`, following the already running implementation `989e5488e2e076a249583a15e414e695c75574d0`. The saved-artifact correction auditor and two-case API packet verifier both passed from the main checkout. The correction auditor also verifies the original account-reset capture and its retained failures. Every archived runtime dependency, including paths normally ignored by Git, is committed and available after relocation.

No EVM, Geth or public RPC was executed for this installed check. The app continues running version0.30.0 on localhost5174; its [health and regression evidence](../account-reset-v030-release/NOTES.md) is unchanged. Sepolia execution remains unsupported by the public local endpoint; the successful viem-provider test and actual application rejection are retained in the [live test packet](../sepolia-smoke-v2/NOTES.md).
