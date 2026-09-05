# Backup Evidence Inbox

An independent community Mermail companion for reviewing backup notification emails. It groups repeated runs, flags empty artifacts and contradictory claims, and keeps restoration evidence separate from job completion.

It is not the official Mermail plugin. The local demo is synthetic; it does not prove a live integration or a successful database restore.

## Run the demo

Node.js 22 or newer; no third-party dependencies or package installation.

```bash
node skills/backup-evidence-inbox/scripts/report.mjs --demo --format markdown
node --test test/*.test.mjs
```

The skill is self-contained under `skills/backup-evidence-inbox`. Its scripts and sample data travel with that directory. See [SKILL.md](skills/backup-evidence-inbox/SKILL.md) for use in an Agent Skills-compatible client.

For core mailbox workflows and MCP setup, use the [official Mermail skills](https://github.com/Nudgen-Marketing/mermail-skills). This companion adds a notification evidence workflow and does not replace that package.

## Use an existing export

```bash
node skills/backup-evidence-inbox/scripts/report.mjs --input /path/to/messages.json --format markdown
```

[The event format](skills/backup-evidence-inbox/references/evidence-format.md) defines normalized messages and structured backup notifications. Arbitrary natural-language alerts go to the review queue; the parser does not guess successful outcomes.

## Read a Mermail test inbox

Create or use a dedicated free test workspace through the official Mermail console. Inject `MERMAIL_API_KEY` through a secret manager or the launching environment. Do not pass the key on the command line or commit it.

```bash
node skills/backup-evidence-inbox/scripts/report.mjs --list-mailboxes
node skills/backup-evidence-inbox/scripts/report.mjs --live --mailbox-id MAILBOX_PUBLIC_ID --format markdown
```

Select the exact returned mailbox id. The default subject filter is `[backup]`; `--subject-contains TEXT` changes it. Defaults are 10 selected messages and two metadata pages; upper caps are 20 messages and three pages. Reads consume API credits and are paced at the lower published free-tier limit.

Output goes to stdout. No message is sent, marked read, deleted, or restored. Unknown sender authentication produces tentative analysis; email declarations never set `restore_verified` to true. [The adapter contract](skills/backup-evidence-inbox/references/mermail-api.md) describes request scope, limits, and failures.

If a live read fails, the helper stops further requests and retains previously read evidence, selected ids, and the failing page or message in a partial report. Exit code 2 indicates a report with a read error or inconsistent pagination; exit code 1 indicates that no report is available. Read and page budgets remain explicit even when the command exits successfully.

Use synthetic messages for public demonstrations. Real reports retain job/run/message identifiers and should be treated as private operational material.

## Implementation status

Local analysis, bounded read adapter, structured output, and synthetic scenarios are implemented. On 2026-09-05, API-key authentication and reads of synthetic Gmail-to-Mermail notifications were verified. Live observations produced a tentative failure issue and an empty-artifact issue; sender authentication remained unknown. The integration also confirmed that agent-safe content can collapse line breaks into spaces, which the event parser now supports.

Repeated-alert grouping is covered by the local synthetic tests; a live duplicate pair has not yet been verified. A recorded workflow, public repository publication, and contest submission remain outstanding. No database restore is performed by this project.
