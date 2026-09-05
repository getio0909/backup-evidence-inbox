#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMessages } from './analyze.mjs';
import { createClient, collectMessages } from './mermail.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const HELP = `Backup Evidence Inbox — community Mermail companion
node report.mjs --demo [--format json|markdown]
node report.mjs --input FILE [--format json|markdown]
node report.mjs --list-mailboxes
node report.mjs --live --mailbox-id ID [--subject-contains TEXT] [--max-messages 10] [--max-pages 2] [--format json|markdown]

Live modes use MERMAIL_API_KEY from the process environment and only GET requests.
No inbox is selected automatically. Default subject filter is [backup].
Reads are paced at <=10 requests/minute. Nothing is sent, marked read, or restored.
Output goes to stdout; local input is limited to 2 MiB. Reports retain job/run/message ids.
Exit 2 retains a partial report after a read failure or inconsistent pagination; exit 1 means no report.
`;

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = { mode: null, format: 'json' };
  const flags = new Set(['--demo', '--input', '--live', '--list-mailboxes']);
  const values = new Map([['--format', 'format'], ['--mailbox-id', 'mailboxId'],
    ['--subject-contains', 'subjectContains'], ['--max-messages', 'maxMessages'], ['--max-pages', 'maxPages']]);
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (seen.has(arg)) throw Object.assign(new Error(), { code: 'duplicate_argument' });
    seen.add(arg);
    if (flags.has(arg)) {
      if (options.mode) throw Object.assign(new Error(), { code: 'conflicting_modes' });
      options.mode = arg.slice(2);
      if (arg === '--input') options.input = args[++i];
    } else if (values.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Object.assign(new Error(), { code: 'missing_argument_value' });
      options[values.get(arg)] = arg.startsWith('--max-') ? Number(value) : value;
    } else throw Object.assign(new Error(), { code: 'unknown_argument' });
  }
  if (!options.mode || !['json', 'markdown'].includes(options.format) ||
      (options.mode === 'input' && (!options.input || options.input.startsWith('--'))) ||
      (options.mode === 'live' && !options.mailboxId)) throw Object.assign(new Error(), { code: 'invalid_arguments' });
  if (options.mode !== 'live' && ['mailboxId', 'subjectContains', 'maxMessages', 'maxPages'].some(k => k in options)) {
    throw Object.assign(new Error(), { code: 'live_options_require_live_mode' });
  }
  return options;
}

function md(value) {
  return String(value ?? 'unknown').replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()|#!]/g, '\\$&');
}

export function renderMarkdown(report) {
  const lines = ['# Backup notification evidence report', '',
    `Data: ${report.synthetic ? 'SYNTHETIC DEMO' : 'email observations'}`, '',
    '**Restore verification has not been performed. Email claims do not prove recoverability.**', '',
    `Assessed at: ${md(report.assessed_at)}`, '',
    '| Job | Run | Email claim | Sender authentication | Source messages | Review |',
    '| --- | --- | --- | --- | --- | --- |'];
  for (const run of report.runs) lines.push(`| ${md(run.job_id)} | ${md(run.run_id)} | ${md(run.declared_status)} | ${md(run.sender_auth_status)} | ${run.source_ids.map(md).join(', ')} | ${(run.review_reasons ?? []).map(md).join(', ') || 'Restore remains unverified'} |`);
  lines.push('', '## Review queue', '');
  for (const item of [...report.issues, ...report.review_items]) {
    lines.push(`- ${md(item.kind ?? 'review')}: ${item.source_ids.map(md).join(', ')} — ${(item.reasons ?? []).map(md).join(', ')}`);
  }
  if (!report.issues.length && !report.review_items.length) lines.push(
    report.collection?.status === 'partial' ? 'The read was incomplete; see read scope and coverage below.'
      : 'No additional flags in the selected sample. This is not a backup health certification.');
  if (report.collection) {
    const c = report.collection;
    lines.push('', '## Read scope and coverage', '',
      `Mailbox: ${md(c.scope.mailbox_id)}; subject contains: ${md(c.scope.subject_contains)}.`, '',
      `Budget: ${c.scope.max_messages} messages, ${c.scope.max_pages} pages, ${c.scope.page_size} metadata rows per page.`, '',
      `Read coverage: ${md(c.status)}; remaining: ${md(c.remaining)}; API requests: ${c.api_requests}.`);
    if (c.selected_message_ids?.length) lines.push('', `Selected messages: ${c.selected_message_ids.map(md).join(', ')}.`);
    if (c.not_fetched_message_ids?.length) lines.push('', `Details not fetched: ${c.not_fetched_message_ids.map(md).join(', ')}.`);
    if (c.errors.length) {
      lines.push('', '### Read failures', '');
      for (const error of c.errors) lines.push(`- ${md(error.message_id ?? `page-${error.page ?? 'unknown'}`)}: ${md(error.code)}${error.status ? ` (HTTP ${md(error.status)})` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function loadInput(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw Object.assign(new Error(), { code: 'input_file_limit' });
  const bytes = await readFile(path);
  if (bytes.length > 2 * 1024 * 1024) throw Object.assign(new Error(), { code: 'input_file_limit' });
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw Object.assign(new Error(), { code: 'invalid_input_json' }); }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(HELP); return; }
    let report;
    if (options.mode === 'list-mailboxes') {
      const client = createClient({ apiKey: process.env.MERMAIL_API_KEY });
      process.stdout.write(`${JSON.stringify({ mailboxes: await client.listMailboxes(), api_requests: client.requestCount }, null, 2)}\n`);
      return;
    }
    if (options.mode === 'live') {
      const client = createClient({ apiKey: process.env.MERMAIL_API_KEY });
      const { messages, collection } = await collectMessages(client, options);
      report = { ...analyzeMessages(messages), synthetic: false, collection };
    } else {
      const messages = await loadInput(options.mode === 'demo' ? resolve(root, '../assets/demo-messages.json') : options.input);
      report = { ...analyzeMessages(messages, options.mode === 'demo' ? { now: Date.parse('2026-09-05T22:00:00Z') } : {}), synthetic: options.mode === 'demo' };
    }
    process.stdout.write(options.format === 'markdown' ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`);
    if (report.collection?.errors.length) process.exitCode = 2;
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(error.code) ? error.code : 'report_failed';
    process.stdout.write(`${JSON.stringify({ error: code, report_available: false })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
