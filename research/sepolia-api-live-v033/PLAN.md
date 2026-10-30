# One Sepolia API observation

This packet records one request through the actual candidate server at
`http://127.0.0.1:5175`. It is separate from every earlier smoke packet and
does not replace their failures. No request is permitted until the parent
confirms that the candidate server and production sources are ready.

The fixed sequence is `GET /api/health`, `GET /api/config`, then exactly one
`POST /api/evm/local-preview`. Health and configuration must establish the
expected version, local engine, Sepolia capability and exact declared example
before the POST. The POST is the unchanged first local example: chain 11155111,
public sender `0x6efb29cee3b414272eb7a8f3ebabf873d36bc033`, recipient
`0x000000000000000000000000000000000000dead`, value 1000000000000000 wei,
data `0x`, gas `21000`, block `latest`, and native balance queries for those two
accounts. The sender is not claimed to belong to the user. No signing, broadcast,
funding, balance override, fee profile, alternate wallet, retry or fallback occurs.

The client makes at most three sequential HTTP requests, only to that loopback
origin. Its shared wall and monotonic window is 170 seconds; health and config
each receive at most 10 seconds and the POST receives only the remaining time.
Response limits are 1 MiB each for health/config and 96 MiB for the API result,
with a 98 MiB aggregate. Timeout/oversize aborts the socket; a further 1 second
allows closure to be observed, never extra execution eligibility. A late,
unclosed or truncated response is retained but unusable. The server retains its
own unchanged proof, execution, output and drain budgets. No direct public RPC
is implemented by this client. Server-side failed RPC bodies may be represented
only by hashes and safe errors; this packet does not invent missing raw bytes.

Preparation writes source and plan identities before execution. The source
identity includes the local loader's complete production/dependency inventory
and Node executable identity plus this harness's exact files. The run requires
the externally supplied plan hash, checks those identities before dispatch, and
creates an exclusive durable STARTED marker. It retains exact request body bytes,
raw response bytes, HTTP status/headers, timing, close status, the complete API
JSON, and a second local implementation identity after the requests. The API's
retained implementation must match the before/after identity for usable results.
Every written artifact is checked against its original hash before manifest seal.
Source bytes are identified, not duplicated as a second archived runtime here.

Artifact verification never executes an EVM or makes an HTTP/RPC request. It
checks the inventory and external plan/manifest pins; joins parsed JSON to exact
raw HTTP and retained RPC bodies; recomputes the selected header and input proof
facts; validates the original gas/native ledger; and binds exactly two native
rows to proven initial balances and validated original changes. A successful
transfer must be exactly -1000000000000000/+1000000000000000 wei. A completed
revert/failure is retained with zero native deltas. Unavailable/error results are
retained as unavailable, never zero balances. It requires chain 11155111, unchanged
full final header, unpriced output, closed/drained child and RPC work, and exact
query identity/unit/side observations. The validator modules must match their
recorded production source hashes; moving a packet does not authorize new code.

This is one source/proof-bound owned API observation, not a prospective coverage
rate, independent-client comparison, consensus/finality proof or security verdict.
Test ETH is not mainnet ETH. Preparation controls use injected HTTP replies and
authenticated synthetic state only; they perform no loopback or public request.

Commands after the explicit ready signal:

```
node research/sepolia-api-live-v033/run.mjs prepare research/sepolia-api-live-v033/capture
node research/sepolia-api-live-v033/run.mjs run research/sepolia-api-live-v033/capture <plan SHA256>
node research/sepolia-api-live-v033/verify.mjs research/sepolia-api-live-v033/capture <manifest SHA256> <plan SHA256>
```
