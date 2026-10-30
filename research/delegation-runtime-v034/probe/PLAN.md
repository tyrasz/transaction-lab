# Fixed delegation runtime probes

Twelve synthetic authenticated-state cases, declared before any execution. Each executes exactly once through the actual isolated product. No public RPC, Geth, shared full-VM counterpart, signing, broadcast, production changes, retries or outcome replacement. The caller has empty code, nonce 1 and 1e12 wei. Transactions use the existing priced EIP-1559 fixture, gas 200000, zero value/data, basefee 7 and fee caps 13/3. Nested calls forward 100000 gas and return two words: child success flag, child returned word (zero if no return). Delegated implementation returns 42. Allocations and full verified synthetic headers are saved before dispatch.

Ordered cases:

1. Amsterdam root destination `ef0100` (3 bytes).
2. Amsterdam root destination `ef0100` plus 19 address bytes (22 bytes).
3. Amsterdam root destination `ef0100` plus exact 20-byte implementation address plus `00` (24 bytes).
4. Amsterdam nested CALL to the 3-byte destination.
5. Amsterdam nested DELEGATECALL to the 24-byte destination.
6. Amsterdam root exact 23-byte designation control.
7. Amsterdam nested CALL exact designation control.
8. Amsterdam nested DELEGATECALL exact designation control.
9. Amsterdam root exact designation pointing to another exact designation, whose destination returns 42 (one-hop resolution control).
10. Cancun root exact designation bytes before activation.
11. Prague root 24-byte destination, to distinguish historical/runtime paths.
12. Amsterdam ordinary INVALID (`fe`) root control.

Amsterdam uses the existing Sepolia common/header fixture; historical cases use its mainnet Cancun/Prague fixture. This is a runtime diagnostic, not public-chain evidence or consensus adjudication. Raw child IPC messages, diagnostic stdout/stderr, proof broker requests/replies and final parent outputs are retained, including failure/unavailable results. Transparent listeners observe existing channels without changing messages or engine inputs. Existing isolated process limits are capped to 10 seconds wall/8 seconds execution. Total diagnostic deadline is 120 seconds; no attempt is repeated. All runtime top-level modules, fixture dependencies and package locks are hashed before and after; this compact packet references the repository dependency trees rather than copying them. Source drift makes its results unusable. A completed EVM invalid-opcode result is distinguished from a parent-unavailable or host-failure result; expected status is never supplied to execution.
