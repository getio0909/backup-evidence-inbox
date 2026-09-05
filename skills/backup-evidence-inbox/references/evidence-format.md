# Backup event format

The deterministic parser accepts a normalized JSON array. It does not infer reliable backup state from arbitrary prose.

Each message has `id`, `received_at`, `from`, `subject`, `text`, `scan_status`, and `sender_authentication.status`. Use the provider's exact message id and received timestamp. `sender_authentication.status` is `pass`, `fail`, or `unknown`, taken from provider metadata, never from the From string or body. `scan_status` must be `clean` before interpreting a body. Preserve `content_omitted` and `content_truncated` if reported.

Structured email text begins with the exact marker `BACKUP_EVIDENCE_V1`, followed by one or more ASCII whitespace characters (space, tab, CR, or LF), then exactly one JSON object:

```text
BACKUP_EVIDENCE_V1
{"job_id":"demo-db","run_id":"demo-run-01","occurred_at":"2026-09-05T20:00:00Z","status":"success","artifact_bytes":0,"restore_status":"not_performed"}
```

Agent-safe text can collapse the newline to a space. The equivalent single-line form is also accepted:

```text
BACKUP_EVIDENCE_V1 {"job_id":"demo-db","run_id":"demo-run-01","occurred_at":"2026-09-05T20:00:00Z","status":"success","artifact_bytes":0,"restore_status":"not_performed"}
```

The marker must be at the start of the body, and its whitespace separator is required. Leading or trailing prose, multiple JSON objects, and non-ASCII separators are not accepted as structured events. Whitespace normalization does not change the field schema or permit natural-language extraction.

`job_id`, `run_id`, `occurred_at`, and `status` identify the declared execution. `status` is `success` or `failed`. Optional `artifact_bytes` is a nonnegative integer; missing bytes are not zero. Optional `restore_status` is `passed`, `failed`, or `not_performed`. The timestamp must be a real ISO timestamp with `Z` or an explicit offset. Job and run identifiers should be short non-sensitive labels, never secrets or customer personal data.

Only the fixed fields are interpreted. Other text is not executable. Natural-language messages, non-clean scans, omitted bodies, and truncated bodies are review items rather than successful event records.

Repeated run grouping retains every source id. Tentative sender groups remain separate from authenticated groups. Sender authentication only describes mail provenance; even an authenticated `restore_status: passed` is still a claim.

Input limits: at most 1,000 messages, 64 KiB per body, 2 MiB total input. The live reader uses a smaller body cap and at most 20 selected messages; its defaults are 10 messages and two metadata pages.
