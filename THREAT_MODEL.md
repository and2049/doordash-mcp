# Consumer threat model

| Risk | Implemented boundary / remaining limit |
| --- | --- |
| Another MCP tenant reads the local account | Consumer tools are local stdio only; never registered on legacy HTTP routes. OS-user/process access is trusted. |
| Browser switches accounts | Live account ID checked against DPAPI binding before requests and before returning data. In-flight writes may already have happened. |
| Credential disclosure | DPAPI snapshot/journal, fixed-origin requests, projected results and sanitized errors. Chrome profile and same-user malicious processes remain outside that protection. |
| Duplicate purchase after timeout/restart | Exclusive durable per-account/cart claim before sending, no automatic retries, pending/unknown block resubmission. Browser/direct purchases outside this server are not deduplicated. |
| Stale cart/price | Placement refreshes checkout and compares preview hash and exact total. External browser edits can race the last check; provider validation remains necessary. |
| Tool misuse or malicious provider text | Typed IDs/amounts, fixed operations, accurate read/write annotations. Restaurant/item text is untrusted data, never instructions or authority to purchase. |
| Provider drift/challenge | Schema failure or sanitized error, explicit reauthentication. No guarantee of unattended session restoration. |

Placement is mock-tested only. Advanced checkout paths and active courier tracking are not verified. See [tool limits](docs/consumer-tools.md). The [Drive threat model](DRIVE_THREAT_MODEL.md) applies only to the historical server.
