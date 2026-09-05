import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient, collectMessages, normalizeMessage } from '../skills/backup-evidence-inbox/scripts/mermail.mjs';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const baseEmail = (id, subject = '[backup] completed') => ({ id, subject, sender: 'demo@example.invalid',
  date: '2026-09-05T08:00:00Z', scan_status: 'clean', body_format: 'text', body: 'test',
  sender_authentication: { status: 'unknown' } });

function harness(responses) {
  const requests = [];
  const waits = [];
  const client = createClient({ apiKey: 'test-only-not-a-real-key',
    sleep: async ms => { waits.push(ms); },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(url.origin, 'https://console.mermail.app');
      assert.equal(options.headers['x-api-key'], 'test-only-not-a-real-key');
      if (!responses.length) throw new Error('Unexpected extra request');
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { client, requests, waits };
}

test('mailbox discovery returns only exact public ids and never chooses a mailbox', async () => {
  const { client, requests } = harness([json([{ public_id: 'box-one', email: 'private@example.invalid', name: 'private' }])]);
  assert.deepEqual(await client.listMailboxes(), [{ public_id: 'box-one' }]);
  assert.equal(requests[0].url.pathname, '/api/v1/mailboxes');
  assert.equal(requests[0].url.search, '');
});

test('both official list shapes work with metadata-only date pagination', async () => {
  const { client, requests, waits } = harness([json([baseEmail('m1')]), json({ emails: [baseEmail('m2')], totalCount: 3 })]);
  assert.equal((await client.listEmails('box-one')).totalCount, null);
  assert.equal((await client.listEmails('box-one', { page: 2 })).totalCount, 3);
  const query = requests[1].url.searchParams;
  assert.equal(query.get('page'), '2');
  assert.equal(query.get('metadata_only'), 'true');
  assert.equal(query.get('agent_safe_content'), 'true');
  assert.equal(query.get('sortDirection'), 'DESC');
  assert.equal(query.has('cursor'), false);
  assert.equal(query.has('folder'), false);
  assert.deepEqual(waits, [6100]);
});

test('only selected metadata matches are read, with scan gating and an explicit body cap', async () => {
  const { client, requests } = harness([json([baseEmail('other', 'Personal note'), baseEmail('chosen')]), json(baseEmail('chosen'))]);
  const result = await collectMessages(client, { mailboxId: 'box-one' });
  assert.deepEqual(result.messages.map(m => m.id), ['chosen']);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url.pathname, '/api/v1/mailboxes/box-one/emails/chosen');
  assert.equal(requests[1].url.searchParams.get('require_scan_status'), 'clean');
  assert.equal(requests[1].url.searchParams.get('max_body_chars'), '12000');
  assert.equal(result.collection.remaining, 'end_observed');
});

test('page deduplication and read caps cannot turn a partial sample into a full-inbox claim', async () => {
  const { client, requests } = harness([
    json([baseEmail('m1'), baseEmail('other', 'not a match')]),
    json([baseEmail('m1'), baseEmail('m2')]), json(baseEmail('m1')), json(baseEmail('m2')),
  ]);
  const result = await collectMessages(client, { mailboxId: 'box-one', pageSize: 2, maxMessages: 2 });
  assert.deepEqual(result.messages.map(m => m.id), ['m1', 'm2']);
  assert.equal(result.collection.remaining, 'inconsistent_pagination');
  assert.equal(result.collection.status, 'partial');
  assert.deepEqual(result.collection.errors, [{ code: 'overlapping_page', page: 2 }]);
  assert.equal(result.collection.metadata_seen, 3);
  assert.equal(requests.filter(r => /\/emails\/m1$/.test(r.url.pathname)).length, 1);
});

test('matching messages beyond the selection budget remain explicitly unprocessed', async () => {
  const { client } = harness([json([baseEmail('m1'), baseEmail('m2')]), json(baseEmail('m1'))]);
  const result = await collectMessages(client, { mailboxId: 'box-one', maxMessages: 1 });
  assert.equal(result.collection.remaining, 'not_all_selected');
  assert.equal(result.messages.length, 1);
});

test('a short page contradicting totalCount reports partial coverage rather than the end', async () => {
  const { client } = harness([json({ emails: [baseEmail('m1')], totalCount: 100 }), json(baseEmail('m1'))]);
  const result = await collectMessages(client, { mailboxId: 'box-one' });
  assert.equal(result.collection.status, 'partial');
  assert.equal(result.collection.remaining, 'inconsistent_pagination');
  assert.equal(result.collection.errors[0].code, 'short_page_before_total');
  assert.deepEqual(result.collection.scope, { mailbox_id: 'box-one', subject_contains: '[backup]', max_messages: 10, max_pages: 2, page_size: 25 });
});

test('a selected message disappearing gives a partial result rather than fabricated content', async () => {
  const { client } = harness([json([baseEmail('m1')]), json({ error: 'not found' }, 404)]);
  const result = await collectMessages(client, { mailboxId: 'box-one' });
  assert.equal(result.collection.status, 'partial');
  assert.deepEqual(result.collection.errors, [{ message_id: 'm1', code: 'not_found', status: 404 }]);
  assert.equal(result.messages.length, 0);
});

test('401, 402 and 403 stop immediately without copying remote payloads or exposing the key', async () => {
  for (const status of [401, 402, 403]) {
    const { client, requests } = harness([json({ error: 'test-only-not-a-real-key' }, status)]);
    await assert.rejects(client.listMailboxes(), error => error.status === status && !error.message.includes('test-only'));
    assert.equal(requests.length, 1);
  }
});

test('429 stops immediately without retrying even when Retry-After permits a short wait', async () => {
  for (const delay of ['0', '2']) {
    const { client, requests, waits } = harness([json({}, 429, { 'Retry-After': delay }), json([])]);
    await assert.rejects(client.listMailboxes(), { code: 'rate_limited', status: 429 });
    assert.equal(requests.length, 1);
    assert.deepEqual(waits, []);
  }
});

test('long or malformed rate-limit waits do not hold the caller or restart a loop', async () => {
  for (const header of ['120', 'invalid', '-1']) {
    const { client, requests, waits } = harness([json({}, 429, { 'Retry-After': header })]);
    await assert.rejects(client.listMailboxes(), { code: 'rate_limited' });
    assert.equal(requests.length, 1);
    assert.deepEqual(waits, []);
  }
});

test('HTTP 200 omitted or truncated content remains unusable evidence', () => {
  const omitted = normalizeMessage({ ...baseEmail('m1'), content_omitted: true, body: 'must not be parsed' });
  assert.equal(omitted.content_omitted, true);
  assert.equal(omitted.text, '');
  assert.equal(normalizeMessage({ ...baseEmail('m1'), content_truncated: true }).content_truncated, true);
  assert.equal(normalizeMessage({ ...baseEmail('m1'), body_format: 'html' }).text, '');
  assert.equal(normalizeMessage({ ...baseEmail('m1'), sender_authentication: undefined }).sender_authentication.status, 'unknown');
});

test('malformed completeness flags cannot normalize into apparently complete evidence', () => {
  for (const flag of ['content_omitted', 'content_truncated']) {
    for (const value of ['true', 'false', 1, null]) {
      assert.throws(() => normalizeMessage({ ...baseEmail('m1'), [flag]: value }), { code: 'invalid_message_metadata' });
    }
  }
  assert.equal(normalizeMessage({ ...baseEmail('m1'), date: null }).received_at, undefined);
});

test('resource ids, response shape, and detail identity cannot be guessed', async () => {
  const invalidId = harness([]);
  await assert.rejects(invalidId.client.getEmail('box-one', '../other'), { code: 'invalid_identifier' });
  assert.equal(invalidId.requests.length, 0);
  const wrongId = harness([json(baseEmail('another'))]);
  await assert.rejects(wrongId.client.getEmail('box-one', 'm1'), { code: 'message_id_mismatch' });
  const malformed = harness([json({ data: [] })]);
  await assert.rejects(malformed.client.listEmails('box-one'), { code: 'invalid_email_list' });
});

test('missing credentials and oversized responses fail before any usable report', async () => {
  assert.throws(() => createClient({ apiKey: '' }), { code: 'missing_or_invalid_api_key' });
  const { client } = harness([new Response('x'.repeat(2 * 1024 * 1024 + 1))]);
  await assert.rejects(client.listMailboxes(), { code: 'response_too_large' });
});

test('a failed metadata page retains selected ids and stops before any detail request', async () => {
  const { client, requests } = harness([
    json([baseEmail('m1'), baseEmail('m2')]), json({}, 429), json(baseEmail('m1')),
  ]);
  const { messages, collection } = await collectMessages(client, { mailboxId: 'box-one', pageSize: 2 });
  assert.deepEqual(messages, []);
  assert.equal(collection.status, 'partial');
  assert.equal(collection.remaining, 'unknown');
  assert.equal(collection.metadata_seen, 2);
  assert.deepEqual(collection.selected_message_ids, ['m1', 'm2']);
  assert.deepEqual(collection.not_fetched_message_ids, ['m1', 'm2']);
  assert.deepEqual(collection.errors, [{ page: 2, code: 'rate_limited', status: 429 }]);
  assert.equal(collection.api_requests, 2);
  assert.equal(requests.length, 2);
});

test('HTTP detail failures preserve earlier reads and stop before every remaining selected message', async () => {
  for (const status of [400, 401, 402, 403, 404, 429, 500]) {
    const { client, requests } = harness([
      json([baseEmail('m1'), baseEmail('m2'), baseEmail('m3')]),
      json(baseEmail('m1')), json({ error: 'private remote error marker' }, status), json(baseEmail('m3')),
    ]);
    const { messages, collection } = await collectMessages(client, { mailboxId: 'box-one' });
    assert.deepEqual(messages.map(message => message.id), ['m1']);
    assert.equal(collection.status, 'partial');
    assert.equal(collection.fetched_messages, 1);
    assert.deepEqual(collection.selected_message_ids, ['m1', 'm2', 'm3']);
    assert.deepEqual(collection.not_fetched_message_ids, ['m2', 'm3']);
    assert.equal(collection.errors[0].message_id, 'm2');
    assert.equal(collection.errors[0].status, status);
    assert.equal(collection.api_requests, 3);
    assert.equal(requests.length, 3);
    assert.ok(!JSON.stringify(collection).includes('private remote error marker'));
  }
});

test('network and malformed detail failures retain earlier reads without another request', async () => {
  for (const [response, code] of [[new Error('private transport marker'), 'network_or_timeout'],
    [new Response('{broken json'), 'invalid_response'],
    [json(baseEmail('wrong-message')), 'message_id_mismatch'],
    [json({ ...baseEmail('m2'), content_omitted: 'false' }), 'invalid_message_metadata']]) {
    const { client, requests } = harness([
      json([baseEmail('m1'), baseEmail('m2'), baseEmail('m3')]),
      json(baseEmail('m1')), response, json(baseEmail('m3')),
    ]);
    const { messages, collection } = await collectMessages(client, { mailboxId: 'box-one' });
    assert.deepEqual(messages.map(message => message.id), ['m1']);
    assert.deepEqual(collection.errors, [{ message_id: 'm2', code }]);
    assert.equal(collection.status, 'partial');
    assert.equal(requests.length, 3);
  }
});

test('invalid read configuration is fatal before a request, while malformed server ids give a partial report', async () => {
  for (const options of [{ mailboxId: '../other' }, { mailboxId: 'box-one', pageSize: 0 },
    { mailboxId: 'box-one', maxMessages: 0 }]) {
    const { client, requests } = harness([]);
    await assert.rejects(collectMessages(client, options));
    assert.equal(requests.length, 0);
  }
  const { client, requests } = harness([json([{ id: '../other' }])]);
  const { collection } = await collectMessages(client, { mailboxId: 'box-one' });
  assert.deepEqual(collection.errors, [{ page: 1, code: 'invalid_email_list' }]);
  assert.equal(collection.status, 'partial');
  assert.equal(requests.length, 1);
});
