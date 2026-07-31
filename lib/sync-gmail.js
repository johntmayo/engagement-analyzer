import { CAPTAIN_HEADERS, rowToCaptain } from './airtable';
import {
  EMAIL_EVENT_HEADERS,
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

function splitAddresses(value) {
  return String(value || '')
    .split(/[,;]+/)
    .map(normalizeEmail)
    .filter(Boolean);
}

function gmailConfigStatus() {
  const mailboxes = String(process.env.GMAIL_MAILBOXES || '')
    .split(/[,;\s]+/)
    .map((value) => value.trim())
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
    if (!process.env.GMAIL_DELEGATED_USER) missing.push('GMAIL_DELEGATED_USER');
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
      'Organizer answers still needed: which mailbox(es), inbound vs outbound vs both, what “credits assigned” means, and auth approach.',
    ],
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

  events.forEach((raw) => {
    const direction = String(raw.direction || '').toLowerCase();
    const fromEmail = normalizeEmail(raw.from_email || raw.from);
    const toEmails = Array.isArray(raw.to_emails)
      ? raw.to_emails.map(normalizeEmail).filter(Boolean)
      : splitAddresses(raw.to_emails || raw.to);
    const ccEmails = Array.isArray(raw.cc_emails)
      ? raw.cc_emails.map(normalizeEmail).filter(Boolean)
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
    if (match.status === 'unmatched' || match.status === 'ambiguous') review += 1;

    const messageId = String(raw.message_id || raw.id || '').trim();
    const eventId = messageId
      ? stableId(['email', messageId])
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

  // Live Gmail API fetch will be implemented once auth mode + mailboxes are confirmed.
  const error = new Error(
    'Gmail auth settings are present, but live mailbox fetch is not enabled yet. '
    + 'Use POST /api/sync-gmail with { events: [...] } to store normalized correspondence, '
    + 'or finish the Gmail API client after confirming domain-wide delegation vs user OAuth.'
  );
  error.statusCode = 501;
  error.details = status;
  throw error;
}
