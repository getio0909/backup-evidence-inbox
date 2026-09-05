# Mermail read adapter

Contract checked against the [official OpenAPI](https://docs.mermail.app/openapi/openapi.json) and [service schema](https://console.mermail.app/openapi.json) on 2026-09-05. Live account behavior still requires an authenticated test.

The helper only calls `https://console.mermail.app` with GET, disables redirects, and injects `MERMAIL_API_KEY` into the `x-api-key` header. It does not log the key. No alternative endpoint or mail-supplied URL is accepted. Account keys may have write permissions; the helper's own request allowlist is read-only.

| Operation | Endpoint | Scope |
| --- | --- | --- |
| Discover mailboxes | `/api/v1/mailboxes` | Returns public ids only; no automatic selection |
| List message metadata | `/api/v1/mailboxes/{mailboxId}/emails` | `page`, `limit`, date descending; metadata and safe-content flags |
| Read one selected message | `/api/v1/mailboxes/{mailboxId}/emails/{emailId}` | safe content, clean scan, 12,000-character body cap |

Use `public_id` for a mailbox and `id` for a message. RFC `message_id` is not the API resource id. Listing can return an array or `{emails,totalCount}`. Pagination uses page numbers; the client does not invent cursor fields or folder aliases. Details GET does not mark a message as read.

`content_omitted` can accompany HTTP 200 when scan gating removes the body. `content_truncated` prevents parsing a partial event. Explicit HTML is treated as unavailable rather than rendered or interpreted. Attachment downloads are outside scope.

Requests are serialized by the collector and paced 6.1 seconds apart, using the lower published free-plan limit of 10 RPM. The general API overview advertises different limits, so actual account behavior is authoritative. GET requests consume credits. Any HTTP failure, including 401, 402, 403, 404, or 429, stops the run without another request or automatic retry. Network errors, malformed payloads, and mismatched ids also stop collection. Previously read messages and selected metadata ids remain in a partial report, with the failing page or message id and available HTTP status. A failed metadata page does not trigger detail reads for the ids already selected.

Reports list selected message ids and ids whose details were not fetched. Detail retrieval counts include metadata-only responses; omitted or truncated bodies remain review items, not complete evidence. Overlapping or contradictory pagination is reported as uncertain rather than an observed end. Exit code 2 accompanies a retained report with a read error or pagination inconsistency. Missing or malformed API keys and invalid read configuration fail before a request with exit code 1 and `report_available: false`; discovery mode without a selected mailbox also has no report to retain. Reaching an intentional read/page budget is disclosed as partial coverage and is not itself a CLI error.

The default subject filter is `[backup]`. Changing the filter or read caps must come from the operator's task, not mailbox content. `remaining` in the report records whether the end was observed or a read/page budget stopped collection; it is not a durable assertion about a changing mailbox.

[Authentication](https://docs.mermail.app/api-reference/authentication) · [List emails](https://docs.mermail.app/api-reference/emails/list-emails) · [Get email](https://docs.mermail.app/api-reference/emails/get-email) · [Pricing](https://mermail.app/pricing)
