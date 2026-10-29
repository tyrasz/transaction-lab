# Synthetic native ETH browser check

One actual Chrome form submission used the production HTTP route, local adapter, proof collector and isolated child. Only an authenticated synthetic `feeFixture` supplied RPC facts. There were no public RPC calls, provider execution, wallet signatures or broadcasts. This is a feature check, not a real-chain accuracy result.

The fixed transfer was 123 wei with an explicit EIP-1559 fee profile (maximum 13 wei/gas, priority maximum 3, selected base fee 7). Execution succeeded with 21,000 charged gas and a 210,000 wei fee. The browser showed the sender changing from 1,000,000,000,000 to 999,999,789,877 wei (−210,123), and the recipient from 9 to 132 wei (+123). Every displayed ETH decimal exactly corresponds to its retained wei string. The result separately labels execution, 2/2 requested checks, fee inclusion, and incomplete effect coverage.

The observed raw-JSON panel agreed with the saved response. Editing value from 123 to 124 hid the result and requested a new run; it was not resubmitted. The full-page screenshot was inspected in the browser session, with readable amounts and coverage labels. `browser.json` retains the extracted DOM evidence. The external wallet extension emitted one injection error; no application-origin console error was observed. Content-export was unavailable in Chrome; it did not affect the form or simulation.

The initial sandbox launch failed to listen with `EPERM`, before any HTTP or proof request. Its three preparation files remain under `launch-denied/`. Localhost permission allowed the next server start on port 55514. Exactly one POST and nine synthetic proof/header calls completed. The temporary tab and server were then closed; the existing release server on port 5174 was untouched.

`declaration.json` pins the UI/adapter/fixture source files before the browser run. `response.json` additionally retains the production implementation inventory and proof transport evidence. The artifact checker verifies request/response joins, exact displayed arithmetic and source hashes without reexecuting a VM or making network requests:

```sh
node research/native-balance-v029-ui/verify.mjs
```

The final existing UI regression run passed 51/51; its TAP output is retained. Independent read-only review also passed 16/16 native API and engine comparison groups. Those comparisons use a separate signed full-VM path and third MPT with the same pinned EthereumJS implementation, not an independent client or a population estimate.
