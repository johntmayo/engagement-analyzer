import { google } from 'googleapis';

import { CAPTAIN_HEADERS, rowToCaptain } from './airtable';
import {
  EMAIL_EVENT_HEADERS,
  GMAIL_SYNC_STATE_HEADERS,
  IDENTITY_LINK_HEADERS,
  appendSheetRow,
  ensureWorkbookSheets,
  readSheetRows,
  replaceSheetRows,
} from './google-sheets';
import {
  buildCaptainIdentityIndex,
  matchIdentityByEmail,
} from './identity';
import { objectsToRows, rowsToObjects, stableId } from './zoom-matching';

const RECENT_BATCH_SIZE = 100;
const INITIAL_BATCH_SIZE = 200;
const BACKFILL_BATCH_SIZE = 400;

const EMAIL_SAFE_METHODS = new Set([
  'manual_identity_link',
  'manual_non_captain',
  'manual_ignore',
  'manual_needs_research',
  'unique_email',
  'shared_email_exact_name',
  'shared_email',
  'conflicting_manual_links',
]);

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function extractEmailAddresses(value) {
  const matches = String(value || '').match(
    /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi
  );
  return [...new Set((matches || []).map(normalizeEmail).filter(Boolean))];
}

function splitAddresses(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap(extractEmailAddresses))];
  }
  return extractEmailAddresses(value);
}

function gmailConfigStatus() {
  const mailboxes = String(process.env.GMAIL_MAILBOXES || '')
    .split(/[,;\s]+/)
    .map(normalizeEmail)
    .filter(Boolean);
  const authMode = String(process.env.GMAIL_AUTH_MODE || '').trim().toLowerCase();
  const hasServiceAccount = Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY
  );
  const hasOAuth = Boolean(
    process.env.GMAIL_OAUTH_CLIENT_ID
    && process.env.GMAIL_OAUTH_CLIENT_SECRET
    && process.env.GMAIL_OAUTH_REFRESH_TOKEN
  );
  const missing = [];
  if (!mailboxes.length) missing.push('GMAIL_MAILBOXES');
  if (!authMode) missing.push('GMAIL_AUTH_MODE (domain_wide|oauth)');
  if (authMode === 'domain_wide') {
    if (!hasServiceAccount) missing.push('GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_PRIVATE_KEY');
  }
  if (authMode === 'oauth' && !hasOAuth) {
    missing.push('GMAIL_OAUTH_CLIENT_ID/GMAIL_OAUTH_CLIENT_SECRET/GMAIL_OAUTH_REFRESH_TOKEN');
  }
  return {
    configured: missing.length === 0,
    missing,
    mailboxes,
    authMode: authMode || null,
    directions: String(process.env.GMAIL_DIRECTIONS || 'inbound,outbound')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    lookbackDays: Math.max(
      1,
      Math.min(365, Number(process.env.GMAIL_LOOKBACK_DAYS) || 84)
    ),
  };
}

export function getGmailIntegrationStatus() {
  const config = gmailConfigStatus();
  return {
    ready: config.configured,
    source: 'gmail',
    ...config,
    notes: [
      'Gmail is a captain engagement source (inbound/outbound correspondence), not the Resend organizer digest.',
      'Never auto-merge identities; attach events only via confirmed emails / identity links.',
      'The live fetch stores message metadata only (mailbox, sender, recipients, date, IDs); it does not store message bodies.',
      'Mailbox activity remains transparent evidence; the separate versioned engagement engine rolls matched events into active weeks.',
    ],
  };
}

function getHeader(headers, name) {
  const target = String(name).toLowerCase();
  return (headers || []).find((header) =>
    String(header.name || '').toLowerCase() === target
  )?.value || '';
}

function gmailEpoch(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return String(Math.floor(date.getTime() / 1000));
}

function mailboxCoverage(mailbox, existingEvents) {
  const timestamps = existingEvents
    .filter((event) => normalizeEmail(event.mailbox) === mailbox)
    .map((event) => Date.parse(event.occurred_at || ''))
    .filter(Number.isFinite);
  if (!timestamps.length) return { earliest: null, latest: null };
  return {
    earliest: new Date(Math.min(...timestamps)),
    latest: new Date(Math.max(...timestamps)),
  };
}

function createDelegatedGmailClient(mailbox) {
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    subject: mailbox,
  });
  return google.gmail({ version: 'v1', auth });
}

function isRetryableGmailError(error) {
  const message = String(error?.message || error || '');
  return error?.code === 429
    || error?.code === 500
    || error?.code === 503
    || /quota exceeded|rate limit|backend error/i.test(message);
}

async function withGmailRetry(operation, { attempts = 4 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableGmailError(error) || attempt === attempts) throw error;
      const delayMs = [2000, 10000, 60000][attempt - 1] || 60000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function fetchMailboxEvents(
  mailbox,
  config,
  existingEvents,
  syncState = null
) {
  if (config.authMode !== 'domain_wide') {
    throw new Error(
      `Gmail auth mode "${config.authMode}" is not implemented; use domain_wide`
    );
  }

  const gmail = createDelegatedGmailClient(mailbox);
  const coverage = mailboxCoverage(mailbox, existingEvents);
  const targetDate = new Date(Date.now() - config.lookbackDays * 86400000);
  const completedTarget = Date.parse(syncState?.backfill_target || '');
  const stateSaysComplete = syncState?.backfill_complete === 'TRUE'
    && Number.isFinite(completedTarget)
    && completedTarget <= targetDate.getTime();
  const recentStart = coverage.latest
    ? new Date(coverage.latest.getTime() - 2 * 86400000)
    : targetDate;
  const directionQuery = [];
  if (
    config.directions.includes('inbound')
    && !config.directions.includes('outbound')
  ) {
    directionQuery.push('-in:sent');
  } else if (
    config.directions.includes('outbound')
    && !config.directions.includes('inbound')
  ) {
    directionQuery.push('in:sent');
  }

  const listMessages = async (query, maxResults) => {
    const response = await withGmailRetry(() => gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    }));
    return response.data.messages || [];
  };

  const recentQuery = [
    `after:${gmailEpoch(recentStart)}`,
    ...directionQuery,
  ].join(' ');
  const recentRefs = await listMessages(
    recentQuery,
    coverage.latest ? RECENT_BATCH_SIZE : INITIAL_BATCH_SIZE
  );

  // Once recent mail is safe, use the remaining quota budget to walk backward.
  // Progress is derived from the oldest stored event, so no separate cursor can
  // be lost. Repeated syncs eventually fill the complete lookback window.
  let backfillRefs = [];
  if (
    !stateSaysComplete
    &&
    coverage.earliest
    && coverage.earliest.getTime() > targetDate.getTime()
  ) {
    const backfillQuery = [
      `after:${gmailEpoch(targetDate)}`,
      `before:${gmailEpoch(coverage.earliest)}`,
      ...directionQuery,
    ].join(' ');
    backfillRefs = await listMessages(backfillQuery, BACKFILL_BATCH_SIZE);
  }
  const messageRefs = [...new Map(
    [...recentRefs, ...backfillRefs].map((message) => [message.id, message])
  ).values()];

  const events = [];
  const fetchErrors = [];
  const batchSize = 20;
  for (let index = 0; index < messageRefs.length; index += batchSize) {
    const batch = messageRefs.slice(index, index + batchSize);
    const settled = await Promise.allSettled(batch.map(({ id }) =>
      withGmailRetry(async () => {
        const messageResponse = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Date'],
        });
        return messageResponse.data;
      })
    ));
    const messages = settled
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);
    settled.forEach((result, offset) => {
      if (result.status === 'rejected') {
        fetchErrors.push({
          messageId: batch[offset]?.id || '',
          error: result.reason?.message || 'Message metadata fetch failed',
        });
      }
    });

    messages.forEach((message) => {
      const headers = message.payload?.headers || [];
      const fromEmails = extractEmailAddresses(getHeader(headers, 'From'));
      const toEmails = extractEmailAddresses(getHeader(headers, 'To'));
      const ccEmails = extractEmailAddresses(getHeader(headers, 'Cc'));
      const labels = message.labelIds || [];
      const direction = labels.includes('SENT') ? 'outbound' : 'inbound';
      if (!config.directions.includes(direction)) return;

      const internalDate = Number(message.internalDate);
      const occurredAt = Number.isFinite(internalDate) && internalDate > 0
        ? new Date(internalDate).toISOString()
        : new Date(getHeader(headers, 'Date')).toISOString();

      events.push({
        mailbox,
        direction,
        message_id: message.id || '',
        thread_id: message.threadId || '',
        occurred_at: occurredAt,
        from_email: fromEmails[0] || '',
        to_emails: toEmails,
        cc_emails: ccEmails,
        subject: '',
        snippet: '',
        labels,
      });
    });

    if (index + batchSize < messageRefs.length) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  const earliestFetched = events
    .map((event) => Date.parse(event.occurred_at || ''))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  const oldestAfter = Math.min(
    coverage.earliest?.getTime() ?? Number.POSITIVE_INFINITY,
    earliestFetched ?? Number.POSITIVE_INFINITY
  );
  const backfillComplete = stateSaysComplete
    || oldestAfter <= targetDate.getTime()
    || Boolean(
      coverage.earliest
      && backfillRefs.length < BACKFILL_BATCH_SIZE
    )
    || Boolean(
      !coverage.earliest
      && recentRefs.length < INITIAL_BATCH_SIZE
    );

  return {
    mailbox,
    lookbackTarget: targetDate.toISOString(),
    earliestBefore: coverage.earliest?.toISOString() || '',
    latestBefore: coverage.latest?.toISOString() || '',
    recentMessagesFound: recentRefs.length,
    backfillMessagesFound: backfillRefs.length,
    messagesFound: messageRefs.length,
    messageErrors: fetchErrors.length,
    oldestAfter: Number.isFinite(oldestAfter)
      ? new Date(oldestAfter).toISOString()
      : '',
    backfillComplete,
    events,
  };
}

/**
 * Normalize already-fetched mailbox events into Sheets.
 * Live Gmail API fetch stays behind auth config (domain-wide delegation or OAuth).
 */
export async function storeEmailEvents(events = []) {
  if (!Array.isArray(events) || !events.length) {
    throw new Error('A non-empty events array is required');
  }

  const startedAt = Date.now();
  const syncedAt = new Date().toISOString();
  await ensureWorkbookSheets();

  const [captainRows, identityRows, existingRows] = await Promise.all([
    readSheetRows('Captains', CAPTAIN_HEADERS.length),
    readSheetRows('Identity Links', IDENTITY_LINK_HEADERS.length),
    readSheetRows('Email Events', EMAIL_EVENT_HEADERS.length),
  ]);

  const captains = captainRows.map(rowToCaptain);
  const identityLinks = rowsToObjects(IDENTITY_LINK_HEADERS, identityRows);
  const index = buildCaptainIdentityIndex(captains, identityLinks, {
    sources: ['zoom', 'dashboard', 'gmail'],
  });
  const existing = rowsToObjects(EMAIL_EVENT_HEADERS, existingRows);
  const byId = new Map(existing.map((event) => [event.event_id, event]));

  let matched = 0;
  let review = 0;
  let unmatched = 0;

  events.forEach((raw) => {
    const direction = String(raw.direction || '').toLowerCase();
    const fromEmail = extractEmailAddresses(raw.from_email || raw.from)[0] || '';
    const toEmails = Array.isArray(raw.to_emails)
      ? splitAddresses(raw.to_emails)
      : splitAddresses(raw.to_emails || raw.to);
    const ccEmails = Array.isArray(raw.cc_emails)
      ? splitAddresses(raw.cc_emails)
      : splitAddresses(raw.cc_emails || raw.cc);
    const counterpartEmails = direction === 'outbound'
      ? [...toEmails, ...ccEmails]
      : [fromEmail].filter(Boolean);

    let match = {
      status: 'unmatched',
      captain: null,
      confidence: 'none',
      method: 'no_counterpart_email',
    };
    for (const email of counterpartEmails) {
      const candidate = matchIdentityByEmail(email, index);
      if (EMAIL_SAFE_METHODS.has(candidate.method)) {
        match = candidate;
        if (candidate.status === 'matched') break;
      }
    }

    if (match.status === 'matched') matched += 1;
    if (match.status === 'ambiguous') review += 1;
    if (match.status === 'unmatched') unmatched += 1;

    const messageId = String(raw.message_id || raw.id || '').trim();
    const eventId = messageId
      ? stableId(['email', raw.mailbox || '', messageId])
      : stableId([
        'email',
        raw.mailbox || '',
        direction,
        raw.occurred_at || '',
        fromEmail,
        toEmails.join(','),
        raw.subject || '',
      ]);

    byId.set(eventId, {
      event_id: eventId,
      mailbox: raw.mailbox || '',
      direction,
      message_id: messageId,
      thread_id: raw.thread_id || '',
      occurred_at: raw.occurred_at || raw.date || '',
      from_email: fromEmail,
      to_emails: toEmails.join(', '),
      cc_emails: ccEmails.join(', '),
      subject: raw.subject || '',
      snippet: raw.snippet || '',
      captain_record_id: match.captain?.airtable_record_id || '',
      match_status: match.status,
      match_confidence: match.confidence || 'none',
      match_method: match.method || '',
      labels: Array.isArray(raw.labels) ? raw.labels.join('|') : (raw.labels || ''),
      synced_at: syncedAt,
    });
  });

  const merged = [...byId.values()].sort((a, b) =>
    String(b.occurred_at).localeCompare(String(a.occurred_at))
  );
  await replaceSheetRows(
    'Email Events',
    EMAIL_EVENT_HEADERS,
    objectsToRows(EMAIL_EVENT_HEADERS, merged)
  );

  const durationMs = Date.now() - startedAt;
  await appendSheetRow('Sync Log', [
    syncedAt,
    'gmail',
    'success',
    events.length,
    matched,
    0,
    review,
    durationMs,
    `Stored ${events.length} email events; ${matched} matched to captains`,
  ]);

  return {
    syncedAt,
    eventsStored: events.length,
    totalEvents: merged.length,
    matched,
    review,
    unmatched,
    durationMs,
  };
}

export async function syncGmailMailbox() {
  const status = getGmailIntegrationStatus();
  if (!status.ready) {
    const error = new Error(
      `Gmail sync is not configured yet. Missing: ${status.missing.join(', ')}. `
      + 'Sheets plumbing is ready (Email Events tab + store endpoint). '
      + 'Provide mailbox list, direction policy, credits-assigned meaning, and auth mode to enable live fetch.'
    );
    error.statusCode = 501;
    error.details = status;
    throw error;
  }

  await ensureWorkbookSheets();
  const [existingRows, stateRows] = await Promise.all([
    readSheetRows('Email Events', EMAIL_EVENT_HEADERS.length),
    readSheetRows('Gmail Sync State', GMAIL_SYNC_STATE_HEADERS.length),
  ]);
  const existingEvents = rowsToObjects(EMAIL_EVENT_HEADERS, existingRows);
  const existingStates = rowsToObjects(GMAIL_SYNC_STATE_HEADERS, stateRows);
  const stateByMailbox = new Map(
    existingStates.map((state) => [normalizeEmail(state.mailbox), state])
  );
  const mailboxResults = [];
  const mailboxErrors = [];

  // Fetch sequentially to avoid spiking Gmail API quota across delegated users.
  for (const mailbox of status.mailboxes) {
    try {
      mailboxResults.push(
        await fetchMailboxEvents(
          mailbox,
          status,
          existingEvents,
          stateByMailbox.get(mailbox)
        )
      );
    } catch (error) {
      mailboxErrors.push({
        mailbox,
        error: error.message || 'Mailbox fetch failed',
      });
    }
  }

  if (!mailboxResults.length) {
    const error = new Error(
      `Gmail fetch failed for every mailbox: ${mailboxErrors
        .map((item) => `${item.mailbox}: ${item.error}`)
        .join('; ')}`
    );
    error.statusCode = 502;
    error.details = { ...status, mailboxErrors };
    throw error;
  }

  const events = mailboxResults.flatMap((result) => result.events);
  const syncedAt = new Date().toISOString();
  const nextStates = new Map(
    existingStates.map((state) => [normalizeEmail(state.mailbox), state])
  );
  mailboxResults.forEach((result) => {
    nextStates.set(result.mailbox, {
      mailbox: result.mailbox,
      backfill_target: result.lookbackTarget,
      oldest_event_at: result.oldestAfter,
      backfill_complete: result.backfillComplete ? 'TRUE' : 'FALSE',
      updated_at: syncedAt,
    });
  });
  await replaceSheetRows(
    'Gmail Sync State',
    GMAIL_SYNC_STATE_HEADERS,
    objectsToRows(GMAIL_SYNC_STATE_HEADERS, [...nextStates.values()])
  );
  if (!events.length) {
    return {
      syncedAt,
      eventsFetched: 0,
      eventsStored: 0,
      totalEvents: existingEvents.length,
      matched: 0,
      review: 0,
      unmatched: 0,
      mailboxes: mailboxResults.map(({ events: ignored, ...result }) => result),
      mailboxErrors,
    };
  }

  const stored = await storeEmailEvents(events);
  return {
    ...stored,
    eventsFetched: events.length,
    mailboxes: mailboxResults.map(({ events: ignored, ...result }) => result),
    mailboxErrors,
  };
}
