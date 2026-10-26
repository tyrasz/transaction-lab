# Supplemental sequence browser replay

Completed the three fixed cases in `reports/standard-evm-sequence`: supply without approval, approve then supply, and approve/supply/repeated supply, in that order. This directory is separate from the live evidence packet. The root task performed the actual browser submissions; this audit establishes source and response correspondence. Visual and interaction observations are separate from the file audit.

The replay server validates an explicitly supplied sealed-manifest hash, every archived source file, the implementation fingerprint, each input and HTTP response, and every retained RPC wire body. It serves the archived public UI and runs the archived real API handler and bounded transport on port 5176. Each browser request must match the next planned input object, including omitted automatic-query fields. Actual browser request bytes are retained because JSON field order can differ without changing the request.

The handler runs the engine again using byte-exact saved RPC responses. Unexpected provider requests fail. Both outgoing `fetch` and socket connections are blocked. A declared 50 ms local delay per saved response makes loading-state controls inspectable; generated run IDs, timestamps, durations and transport durations are excluded from comparison. All other response fields must match the live result. This is UI regression evidence, not a new blockchain execution or independent state oracle.

The bound live manifest is `6e861f3b9f21e8d878b5347a5990707a29fa32bca28a81bbce1cbf8ca473255c`. The archive is version 0.12.0 with implementation fingerprint `3b769d18eac4e46548420e51799baf0185f56154c1fbfaaed6914f8b4cb83e60`. Its 52 source files were checked before loading. Each case ran once, with three attempts and no failed or unmatched requests. All 112 recorded RPC responses (457,073 bytes) were consumed exactly. No public network requests were made.

The supply baseline reverted with no measured balances. The two-call sequence completed: its approval measured one allowance, and the following supply measured four token queries. The three-call sequence preserved those two successful steps, then executed and reverted on the repeated supply. All three responses retained their canonical verification. Full response JSON and exact browser/RPC request correspondence are saved beside `playback-results.json`; the verifier compares all fields except explicitly declared generated IDs and timing fields.

Reproduce the completed offline audit with:

```sh
node reports/standard-evm-sequence-ui-replay/verify.mjs --manifest-sha256 6e861f3b9f21e8d878b5347a5990707a29fa32bca28a81bbce1cbf8ca473255c
```

`verification.json` records a passing audit. The original live packet and product files remain unchanged. The replay server rejects repeat submissions; starting a new run is not necessary to verify the saved evidence.
