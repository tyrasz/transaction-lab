# Fixed Aave approval → supply discovery (incomplete first packet)

The one synthetic unsigned candidate stopped after 12 successful read-only RPC calls and 35,499 response bytes. It established a USDC balance of 3,962,903,485 raw units, initial Pool allowance zero, and a supply revert of `ERC20: transfer amount exceeds allowance`. An actual approve call succeeded with one allowance storage change and sender nonce 52→53. A subsequent isolated allowance query returned 3,962,903,485.

The discovery script then rejected a valid-looking extra unchanged `pre.balance` field in that query’s diff: pre nonce53 plus native balance, post nonce54. Offline comparison binds the pre balance exactly to the separately pinned native balance. This is a local assertion stop, not a provider transport failure. Deposit-after-approval and the final canonical header check were never attempted. The original incomplete result is retained.

See [raw capture](capture.json), [index](index.json), [frozen plan](plan.json) and [manifest](manifest.json). A separately authorized supplemental continuation may perform only the three unattempted observations; it must not rewrite or rerun this packet. This derived approve→supply input is not the original signed supplyWithPermit transaction and is not an accuracy cohort.
