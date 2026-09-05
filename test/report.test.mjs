import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs, renderMarkdown } from '../skills/backup-evidence-inbox/scripts/report.mjs';

const script = fileURLToPath(new URL('../skills/backup-evidence-inbox/scripts/report.mjs', import.meta.url));

test('CLI demo is executable without credentials, reads all demo messages and stays synthetic', () => {
  const run = spawnSync(process.execPath, [script, '--demo'], { encoding: 'utf8', env: {} });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.synthetic, true);
  assert.equal(report.restore_verified, false);
  assert.ok(report.summary.input_messages >= 6);
  assert.ok(report.runs.some(r => r.source_ids.length === 3));
});

test('live mode with missing credentials fails and cannot masquerade as an empty successful report', () => {
  const run = spawnSync(process.execPath, [script, '--live', '--mailbox-id', 'box-test'], { encoding: 'utf8', env: {} });
  assert.equal(run.status, 1);
  assert.deepEqual(JSON.parse(run.stdout), { error: 'missing_or_invalid_api_key', report_available: false });
  assert.equal(run.stderr, '');
});

test('live mode requires exact mailbox selection and cannot be mixed with a demo', () => {
  assert.throws(() => parseArgs(['--live']));
  assert.throws(() => parseArgs(['--demo', '--live', '--mailbox-id', 'a']));
  assert.throws(() => parseArgs(['--demo', '--mailbox-id', 'a']));
});

test('Markdown cannot turn identifiers into active links or table markup', () => {
  const report = { synthetic: true, assessed_at: '2026-09-05T22:00:00Z',
    runs: [{ job_id: '<img src=x>', run_id: '[click](https://example.invalid)', declared_status: 'success',
      source_ids: ['m1|m2'], review_reasons: [], sender_auth_status: 'unknown' }], issues: [], review_items: [] };
  const markdown = renderMarkdown(report);
  assert.ok(!markdown.includes('<img'));
  assert.ok(!markdown.includes('[click]('));
  assert.ok(markdown.includes('m1\\|m2'));
  assert.ok(markdown.includes('SYNTHETIC DEMO'));
  assert.ok(markdown.includes('Restore verification has not been performed'));
});

test('Markdown retains scope and the id of a message that disappeared', () => {
  const output = renderMarkdown({ synthetic: false, assessed_at: '2026-09-05T22:00:00Z', runs: [], issues: [], review_items: [],
    collection: { status: 'partial', remaining: 'end_observed', api_requests: 2,
      scope: { mailbox_id: 'box-one', subject_contains: '[backup]', max_messages: 10, max_pages: 2, page_size: 25 },
      selected_message_ids: ['gone-id', 'pending-id'], not_fetched_message_ids: ['gone-id', 'pending-id'],
      errors: [{ message_id: 'gone-id', code: 'not_found', status: 404 }] } });
  assert.ok(output.includes('box-one'));
  assert.ok(output.includes('10 messages, 2 pages'));
  assert.ok(output.includes('gone-id'));
  assert.ok(output.includes('not\\_found'));
  assert.ok(output.includes('HTTP 404'));
  assert.ok(output.includes('Details not fetched: gone-id, pending-id'));
  assert.ok(!output.includes('No additional flags'));
});

test('CLI returns a scoped partial report with exit 2 after an API failure, without further requests', () => {
  for (const format of ['json', 'markdown']) {
    const source = `
      let calls = 0;
      globalThis.fetch = async () => {
        if (++calls !== 1) throw new Error('Unexpected additional request');
        return new Response('{}', { status: 429, headers: { 'Retry-After': '0' } });
      };
      process.argv = [process.execPath, ${JSON.stringify(script)}, '--live', '--mailbox-id', 'box-test', '--format', ${JSON.stringify(format)}];
      await import(${JSON.stringify(new URL('../skills/backup-evidence-inbox/scripts/report.mjs', import.meta.url).href)});
      if (calls !== 1) throw new Error('Expected exactly one mocked request');
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', env: { MERMAIL_API_KEY: 'test-only-not-a-real-key' },
    });
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.equal(run.stderr, '');
    assert.ok(!run.stdout.includes('test-only-not-a-real-key'));
    if (format === 'json') {
      const report = JSON.parse(run.stdout);
      assert.equal(report.collection.status, 'partial');
      assert.equal(report.collection.scope.mailbox_id, 'box-test');
      assert.deepEqual(report.collection.errors, [{ page: 1, code: 'rate_limited', status: 429 }]);
      assert.equal(report.restore_verified, false);
    } else {
      assert.ok(run.stdout.includes('The read was incomplete'));
      assert.ok(run.stdout.includes('page-1'));
      assert.ok(run.stdout.includes('HTTP 429'));
      assert.ok(!run.stdout.includes('No additional flags'));
    }
  }
});
