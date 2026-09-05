const ORIGIN = 'https://console.mermail.app';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));

export class MermailError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = 'MermailError';
    this.code = code;
    this.status = status;
  }
}

function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw new MermailError('invalid_identifier');
  }
  return value;
}

async function boundedJson(response) {
  if (!response.body) throw new MermailError('invalid_response');
  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new MermailError('response_too_large');
      }
      parts.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch (error) {
    if (error instanceof MermailError) throw error;
    throw new MermailError('invalid_response');
  } finally {
    reader.releaseLock();
  }
}

export function createClient({ apiKey, fetchImpl = fetch, sleep = sleepDefault, intervalMs = 6100 } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
    throw new MermailError('missing_or_invalid_api_key');
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new MermailError('invalid_interval');
  let called = false;
  let requestCount = 0;

  async function get(path, query = {}) {
    if (!/^\/api\/v1\/mailboxes(?:\/[A-Za-z0-9_-]+\/emails(?:\/[A-Za-z0-9_-]+)?)?$/.test(path)) {
      throw new MermailError('endpoint_not_allowed');
    }
    const url = new URL(path, ORIGIN);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    if (called) await sleep(intervalMs);
    called = true;
    requestCount += 1;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET', redirect: 'error',
        headers: { 'x-api-key': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new MermailError('network_or_timeout');
    }
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      const code = ({ 400: 'invalid_request', 401: 'authentication_required',
        402: 'credits_exhausted', 403: 'access_denied', 404: 'not_found',
        429: 'rate_limited' })[response.status] || 'http_error';
      throw new MermailError(code, response.status);
    }
    return boundedJson(response);
  }

  return {
    get requestCount() { return requestCount; },
    async listMailboxes() {
      const data = await get('/api/v1/mailboxes');
      if (!Array.isArray(data)) throw new MermailError('invalid_mailbox_list');
      return data.map(box => ({ public_id: identifier(box.public_id) }));
    },
    async listEmails(mailboxId, { page = 1, limit = 25 } = {}) {
      identifier(mailboxId);
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new MermailError('invalid_pagination');
      }
      const data = await get(`/api/v1/mailboxes/${mailboxId}/emails`, {
        page, limit, sortColumn: 'date', sortDirection: 'DESC',
        metadata_only: true, agent_safe_content: true,
      });
      const emails = Array.isArray(data) ? data : data?.emails;
      const total = Array.isArray(data) ? null : data?.totalCount;
      if (!Array.isArray(emails) || emails.length > limit ||
          (total !== undefined && total !== null && (!Number.isSafeInteger(total) || total < 0))) {
        throw new MermailError('invalid_email_list');
      }
      for (const email of emails) {
        try { identifier(email?.id); }
        catch { throw new MermailError('invalid_email_list'); }
      }
      return { emails, totalCount: total ?? null };
    },
    async getEmail(mailboxId, emailId) {
      identifier(mailboxId); identifier(emailId);
      const data = await get(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}`, {
        agent_safe_content: true, require_scan_status: 'clean', max_body_chars: 12000,
      });
      if (!data || data.id !== emailId) throw new MermailError('message_id_mismatch');
      return data;
    },
  };
}

export function normalizeMessage(email) {
  const id = identifier(email?.id);
  for (const field of ['content_omitted', 'content_truncated']) {
    if (email[field] !== undefined && typeof email[field] !== 'boolean') throw new MermailError('invalid_message_metadata');
  }
  const auth = email.sender_authentication?.status;
  const bodyUnavailable = email.content_omitted === true || email.body_format === 'html' || typeof email.body !== 'string';
  return {
    id, received_at: typeof email.date === 'string' ? email.date : undefined,
    from: typeof email.sender === 'string' ? email.sender : '',
    subject: typeof email.subject === 'string' ? email.subject.slice(0, 512) : '',
    text: bodyUnavailable ? '' : email.body,
    scan_status: email.scan_status ?? null,
    sender_authentication: { status: ['pass', 'fail', 'unknown'].includes(auth) ? auth : 'unknown' },
    content_omitted: bodyUnavailable,
    content_truncated: email.content_truncated === true,
  };
}

export async function collectMessages(client, {
  mailboxId, subjectContains = '[backup]', maxMessages = 10, maxPages = 2, pageSize = 25,
} = {}) {
  identifier(mailboxId);
  if (typeof subjectContains !== 'string' || subjectContains.length < 1 || subjectContains.length > 200 ||
      !Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 20 ||
      !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 3 ||
      !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new MermailError('invalid_read_budget');
  const selected = new Map();
  const seen = new Set();
  const messages = [];
  const collection = { status: 'bounded_snapshot', scope: { mailbox_id: mailboxId,
    subject_contains: subjectContains, max_messages: maxMessages, max_pages: maxPages, page_size: pageSize },
    pages: 0, metadata_seen: 0,
    selected_messages: 0, fetched_messages: 0, remaining: 'unknown', errors: [], api_requests: 0 };
  function finish() {
    collection.selected_message_ids = [...selected.keys()];
    collection.selected_messages = selected.size;
    collection.fetched_messages = messages.length;
    const fetched = new Set(messages.map(message => message.id));
    collection.not_fetched_message_ids = [...selected.keys()].filter(id => !fetched.has(id));
    collection.api_requests = client.requestCount;
    if (collection.remaining !== 'end_observed' || collection.errors.length) collection.status = 'partial';
    return { messages, collection };
  }
  function readFailure(error, source) {
    if (!(error instanceof MermailError) || ['missing_or_invalid_api_key', 'invalid_identifier',
      'invalid_interval', 'invalid_pagination', 'invalid_read_budget', 'endpoint_not_allowed'].includes(error.code)) throw error;
    collection.status = 'partial';
    collection.errors.push({ ...source, code: error.code, ...(error.status === null ? {} : { status: error.status }) });
    return finish();
  }
  let clipped = false;
  for (let page = 1; page <= maxPages; page += 1) {
    let result;
    try { result = await client.listEmails(mailboxId, { page, limit: pageSize }); }
    catch (error) { return readFailure(error, { page }); }
    collection.pages += 1;
    const previousSeen = seen.size;
    for (const email of result.emails) {
      if (seen.has(email.id)) continue;
      seen.add(email.id);
      if (typeof email.subject === 'string' && email.subject.toLowerCase().includes(subjectContains.toLowerCase())) {
        if (selected.size < maxMessages) selected.set(email.id, email);
        else clipped = true;
      }
    }
    collection.metadata_seen = seen.size;
    if (seen.size - previousSeen < result.emails.length) {
      collection.status = 'partial';
      collection.remaining = 'inconsistent_pagination';
      collection.errors.push({ code: 'overlapping_page', page });
      break;
    }
    if (result.totalCount !== null && result.emails.length < pageSize &&
        (page - 1) * pageSize + result.emails.length < result.totalCount) {
      collection.status = 'partial';
      collection.remaining = 'inconsistent_pagination';
      collection.errors.push({ code: 'short_page_before_total', page });
      break;
    }
    const end = result.totalCount !== null ? page * pageSize >= result.totalCount : result.emails.length < pageSize;
    if (end) { collection.remaining = clipped ? 'not_all_selected' : 'end_observed'; break; }
    if (selected.size >= maxMessages) { collection.remaining = 'read_budget_reached'; break; }
    if (page === maxPages) collection.remaining = 'page_budget_reached';
  }
  for (const [id] of selected) {
    try {
      messages.push(normalizeMessage(await client.getEmail(mailboxId, id)));
    } catch (error) {
      return readFailure(error, { message_id: id });
    }
  }
  return finish();
}
