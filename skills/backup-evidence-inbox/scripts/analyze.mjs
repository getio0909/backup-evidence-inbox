import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({ messages: 1000, text_bytes: 65536, total_bytes: 2097152 });
const PREFIX = /^BACKUP_EVIDENCE_V1[ \t\r\n]+/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const EVIDENCE_KEYS = new Set(['job_id', 'run_id', 'occurred_at', 'status', 'artifact_bytes', 'restore_status']);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sortedUnique = (values) => [...new Set(values)].sort(compare);

export class AnalysisInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AnalysisInputError';
    this.code = code;
  }
}

function reject(code, message) { throw new AnalysisInputError(code, message); }

function canonical(value, depth = 0) {
  if (depth > 8) reject('INPUT_TOO_LARGE', 'Input nesting exceeds the limit.');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > LIMITS.text_bytes) reject('INPUT_TOO_LARGE', 'A string exceeds the byte limit.');
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length > 1000) reject('INPUT_TOO_LARGE', 'An array exceeds the item limit.');
    return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort(compare);
    if (keys.length > 64 || keys.some((key) => key.length > 128)) reject('INPUT_TOO_LARGE', 'Object metadata exceeds the limit.');
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
  }
  reject('INVALID_MESSAGE', 'Messages must contain JSON values only.');
}

function timestamp(value, field, now) {
  if (value === undefined || value === null || value === '') return { reasons: [`missing_${field}`] };
  if (typeof value !== 'string' || value.length > 64) return { reasons: [`${field}_invalid_timestamp`] };
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return { reasons: [`${field}_invalid_timestamp`] };
  const [, yearString, monthString, dayString, hourString, minuteString, secondString, , zone] = match;
  const [year, month, day, hour, minute, second] = [yearString, monthString, dayString, hourString, minuteString, secondString].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) {
    return { reasons: [`${field}_invalid_calendar_date`] };
  }
  if (!zone) return { reasons: [`${field}_timezone_missing`] };
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) {
    return { reasons: [`${field}_invalid_timezone`] };
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return { reasons: [`${field}_invalid_timestamp`] };
  return { millis, reasons: millis > now ? [`${field}_in_future`] : [] };
}

function validateMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) reject('INVALID_MESSAGE', 'Each message must be an object.');
  if (typeof message.id !== 'string' || !SOURCE_ID.test(message.id)) reject('INVALID_MESSAGE_ID', 'Each message needs a bounded source identifier.');
  for (const [field, limit] of [['subject', 2048], ['from', 512], ['text', LIMITS.text_bytes]]) {
    if (message[field] !== undefined && message[field] !== null && typeof message[field] !== 'string') {
      reject('INVALID_MESSAGE', 'Message text metadata must use strings.');
    }
    if (Buffer.byteLength(message[field] || '') > limit) reject('INPUT_TOO_LARGE', 'Message text metadata exceeds the byte limit.');
  }
  for (const field of ['content_omitted', 'content_truncated', 'truncated']) {
    if (message[field] !== undefined && typeof message[field] !== 'boolean') reject('INVALID_MESSAGE', 'Content completeness metadata must use booleans.');
  }
}

function parseEvidence(text) {
  const prefix = PREFIX.exec(text);
  if (!prefix) return { reasons: ['unstructured_body'] };
  let payload;
  try { payload = JSON.parse(text.slice(prefix[0].length)); } catch { return { reasons: ['malformed_structured_body'] }; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { reasons: ['invalid_evidence_object'] };
  const reasons = [];
  if (Object.keys(payload).some((key) => !EVIDENCE_KEYS.has(key))) reasons.push('unexpected_evidence_fields');
  for (const field of ['job_id', 'run_id']) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') reasons.push(`missing_${field}`);
    else if (typeof payload[field] !== 'string' || !IDENTIFIER.test(payload[field])) reasons.push(`invalid_${field}`);
  }
  if (!['success', 'failed'].includes(payload.status)) reasons.push('invalid_declared_status');
  if (payload.artifact_bytes !== undefined && (!Number.isSafeInteger(payload.artifact_bytes) || payload.artifact_bytes < 0)) reasons.push('invalid_artifact_bytes');
  if (payload.restore_status !== undefined && !['passed', 'failed', 'not_performed'].includes(payload.restore_status)) reasons.push('invalid_restore_status');
  return { payload, reasons };
}

function safeJobFields(payload) {
  const fields = {};
  for (const field of ['job_id', 'run_id']) if (typeof payload?.[field] === 'string' && IDENTIFIER.test(payload[field])) fields[field] = payload[field];
  return fields;
}

function declared(values, fallback) {
  const unique = sortedUnique(values);
  return unique.length === 0 ? fallback : unique.length === 1 ? unique[0] : 'conflicting';
}

export function analyzeMessages(messages, { now = Date.now() } = {}) {
  if (!Array.isArray(messages)) reject('INVALID_INPUT', 'Input must be a message array.');
  if (messages.length > LIMITS.messages) reject('INPUT_TOO_LARGE', 'Message count exceeds the limit.');
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) reject('INVALID_NOW', 'Assessment time must be a valid millisecond timestamp.');
  const seen = new Map();
  const unique = [];
  let totalBytes = 0;
  for (const message of messages) {
    validateMessage(message);
    const serialized = canonical(message);
    totalBytes += Buffer.byteLength(serialized);
    if (totalBytes > LIMITS.total_bytes) reject('INPUT_TOO_LARGE', 'Total message bytes exceed the limit.');
    const digest = createHash('sha256').update(serialized).digest('hex');
    if (seen.has(message.id)) {
      if (seen.get(message.id) !== digest) reject('DUPLICATE_ID_CONFLICT', 'A source identifier refers to different message content.');
    } else {
      seen.set(message.id, digest);
      unique.push(message);
    }
  }

  const groups = new Map();
  const reviewItems = [];
  let restoreClaims = 0;
  for (const message of unique) {
    const received = timestamp(message.received_at, 'received_at', now);
    const authentication = ['pass', 'fail'].includes(message.sender_authentication?.status)
      ? message.sender_authentication.status : 'unknown';
    const trustReasons = authentication === 'pass' ? []
      : [authentication === 'fail' ? 'sender_authentication_failed' : 'sender_authentication_unknown'];
    const metadataReasons = [...received.reasons, ...trustReasons];
    if (message.scan_status !== 'clean') metadataReasons.push('scan_not_clean');
    if (message.content_omitted === true) metadataReasons.push('content_omitted');
    if (message.content_truncated === true || message.truncated === true) metadataReasons.push('content_truncated');
    if (message.scan_status !== 'clean' || message.content_omitted === true || message.content_truncated === true || message.truncated === true) {
      reviewItems.push({ source_ids: [message.id], reasons: sortedUnique(metadataReasons), body_interpreted: false });
      continue;
    }
    const parsed = parseEvidence(message.text || '');
    if (!parsed.payload) {
      reviewItems.push({ source_ids: [message.id], reasons: sortedUnique([...metadataReasons, ...parsed.reasons]), body_interpreted: false });
      continue;
    }
    const { payload } = parsed;
    const occurred = timestamp(payload.occurred_at, 'occurred_at', now);
    const structuralReasons = [...received.reasons, ...parsed.reasons, ...occurred.reasons];
    const sender = (message.from || '').trim().toLowerCase();
    if (!sender) structuralReasons.push('missing_claimed_sender');
    if (payload.restore_status === 'passed') restoreClaims += 1;
    if (structuralReasons.length) {
      reviewItems.push({
        ...safeJobFields(payload), source_ids: [message.id],
        reasons: sortedUnique([...structuralReasons, ...trustReasons]), body_interpreted: true,
      });
      continue;
    }
    // Authentication tiers remain separate even when the claimed sender and job match.
    const key = JSON.stringify([authentication, sender, payload.job_id, payload.run_id]);
    if (!groups.has(key)) groups.set(key, { authentication, payloads: [], sourceIds: [], reasons: trustReasons });
    const group = groups.get(key);
    group.payloads.push(payload);
    group.sourceIds.push(message.id);
  }

  const runs = [];
  const issues = [];
  for (const group of groups.values()) {
    const payloads = group.payloads;
    const first = payloads[0];
    const statuses = sortedUnique(payloads.map((item) => item.status));
    const sizes = [...new Set(payloads.flatMap((item) => item.artifact_bytes === undefined ? [] : [item.artifact_bytes]))].sort((a, b) => a - b);
    const restores = sortedUnique(payloads.flatMap((item) => item.restore_status === undefined ? [] : [item.restore_status]));
    const reasons = [...group.reasons];
    if (statuses.includes('failed')) reasons.push('backup_failure_reported');
    if (statuses.length > 1) reasons.push('status_conflict');
    if (sizes.length === 0) reasons.push('artifact_evidence_missing');
    if (sizes.includes(0)) reasons.push('empty_artifact_reported');
    if (sizes.length > 1) reasons.push('artifact_size_conflict');
    if (restores.length === 0) reasons.push('restore_not_reported');
    if (restores.includes('not_performed')) reasons.push('restore_not_performed');
    if (restores.includes('failed')) reasons.push('restore_failure_reported');
    if (restores.includes('passed')) reasons.push('restore_pass_claim_unverified');
    if (restores.length > 1) reasons.push('restore_status_conflict');
    const run = {
      job_id: first.job_id,
      run_id: first.run_id,
      source_ids: sortedUnique(group.sourceIds),
      sender_auth_status: group.authentication,
      tentative_group: group.authentication !== 'pass',
      declared_status: declared(statuses, 'not_reported'),
      artifact_bytes: sizes.length === 1 ? sizes[0] : null,
      declared_artifact_bytes: sizes,
      declared_restore_status: declared(restores, 'not_reported'),
      evidence_status: 'email_claim_only',
      restore_verified: false,
      review_reasons: sortedUnique(reasons),
    };
    runs.push(run);
    if (reasons.length) issues.push({
      kind: statuses.length > 1 || sizes.length > 1 || restores.length > 1 ? 'conflicting_claims'
        : statuses.includes('failed') ? 'backup_failure'
          : sizes.includes(0) ? 'empty_artifact' : 'review_required',
      job_id: run.job_id, run_id: run.run_id, source_ids: run.source_ids,
      sender_auth_status: run.sender_auth_status, tentative_group: run.tentative_group,
      reasons: run.review_reasons,
    });
  }
  const order = (a, b) => compare(a.job_id || '', b.job_id || '')
    || compare(a.run_id || '', b.run_id || '') || compare(a.source_ids.join('\0'), b.source_ids.join('\0'));
  runs.sort(order);
  issues.sort(order);
  reviewItems.sort(order);
  return {
    schema_version: 1,
    assessed_at: new Date(now).toISOString(),
    summary: {
      input_messages: messages.length,
      unique_messages: unique.length,
      duplicate_messages: messages.length - unique.length,
      grouped_runs: runs.length,
      tentative_runs: runs.filter((run) => run.tentative_group).length,
      issues: issues.length,
      review_items: reviewItems.length,
      unverified_restore_claims: restoreClaims,
    },
    runs,
    issues,
    review_items: reviewItems,
    evidence_status: 'email_claims_only_not_independently_verified',
    restore_verified: false,
  };
}
