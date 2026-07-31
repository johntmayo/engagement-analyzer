import { google } from 'googleapis';

import { CAPTAIN_HEADERS, DATA_QUALITY_HEADERS } from './airtable';

export const IDENTITY_LINK_HEADERS = [
  'identity_link_id',
  'captain_record_id',
  'resident_id',
  'source',
  'identity_type',
  'identity_value',
  'match_method',
  'confidence',
  'notes',
  'created_at',
  'updated_at',
  'status',
];

export const ZOOM_SESSION_HEADERS = [
  'session_id',
  'meeting_id',
  'topic',
  'date',
  'duration_minutes',
  'source',
  'synced_at',
  'host_id',
  'host_name',
  'host_email',
  'host_captain_record_id',
  'host_match_status',
  'host_match_confidence',
  'classification',
  'classification_source',
  'expected_zone',
];

export const ZOOM_ATTENDANCE_HEADERS = [
  'attendance_id',
  'session_id',
  'captain_record_id',
  'resident_id',
  'participant_name',
  'participant_email',
  'duration_seconds',
  'match_status',
  'match_confidence',
  'match_method',
  'synced_at',
  'session_classification',
];

export const ZOOM_MATCH_REVIEW_HEADERS = [
  'review_id',
  'session_id',
  'topic',
  'date',
  'participant_name',
  'participant_email',
  'reason',
  'candidate_captain_ids',
  'candidate_names',
  'confidence',
  'detected_at',
];

export const SESSION_RULE_HEADERS = [
  'rule_id',
  'topic_key',
  'display_topic',
  'classification',
  'expected_zone',
  'notes',
  'created_at',
  'updated_at',
  'host_captain_record_id',
];

export const SESSION_OVERRIDE_HEADERS = [
  'override_id',
  'session_id',
  'classification',
  'expected_zone',
  'notes',
  'host_captain_record_id',
  'created_at',
  'updated_at',
];

// Paste/export mirror of Zone Dashboard Access tab when USER_ACCESS_SHEET_ID
// is unavailable. Preferred source remains the live User Access Registry.
export const DASHBOARD_ACCESS_SOURCE_HEADERS = [
  'login_email',
  'sheet_url',
  'zone_name',
  'captain_display_name',
  'contact_email',
  'role',
  'active',
  'date_added',
  'notes',
  'last_seen_at',
  'login_count',
];

export const DASHBOARD_ACCESS_HEADERS = [
  'access_id',
  'login_email',
  'captain_record_id',
  'resident_id',
  'display_name',
  'zones',
  'role',
  'active',
  'last_seen_at',
  'login_count',
  'match_status',
  'match_confidence',
  'match_method',
  'source_rows',
  'synced_at',
];

export const DASHBOARD_MATCH_REVIEW_HEADERS = [
  'review_id',
  'login_email',
  'display_name',
  'zones',
  'role',
  'last_seen_at',
  'login_count',
  'reason',
  'candidate_captain_ids',
  'candidate_names',
  'confidence',
  'detected_at',
];

export const EMAIL_EVENT_HEADERS = [
  'event_id',
  'mailbox',
  'direction',
  'message_id',
  'thread_id',
  'occurred_at',
  'from_email',
  'to_emails',
  'cc_emails',
  'subject',
  'snippet',
  'captain_record_id',
  'match_status',
  'match_confidence',
  'match_method',
  'labels',
  'synced_at',
];

export const WORKBOOK_SHEETS = {
  Captains: CAPTAIN_HEADERS,
  'Identity Links': IDENTITY_LINK_HEADERS,
  'Zoom Sessions': ZOOM_SESSION_HEADERS,
  'Zoom Attendance': ZOOM_ATTENDANCE_HEADERS,
  'Zoom Match Review': ZOOM_MATCH_REVIEW_HEADERS,
  'Session Rules': SESSION_RULE_HEADERS,
  'Session Overrides': SESSION_OVERRIDE_HEADERS,
  'Dashboard Access Source': DASHBOARD_ACCESS_SOURCE_HEADERS,
  'Dashboard Access': DASHBOARD_ACCESS_HEADERS,
  'Dashboard Match Review': DASHBOARD_MATCH_REVIEW_HEADERS,
  'Email Events': EMAIL_EVENT_HEADERS,
  'Data Quality': DATA_QUALITY_HEADERS,
  'Sync Log': [
    'synced_at',
    'source',
    'status',
    'records_fetched',
    'active_captains',
    'inactive_captains',
    'issues_found',
    'duration_ms',
    'message',
  ],
};

function requireSheetsConfig() {
  const config = {
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  };

  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length) {
    throw new Error(`Missing Google Sheets configuration: ${missing.join(', ')}`);
  }

  return config;
}

let sheetsClientPromise = null;
let workbookReadyAt = 0;
const WORKBOOK_READY_TTL_MS = 15 * 60 * 1000;

async function getSheetsClient() {
  if (!sheetsClientPromise) {
    const { email, privateKey } = requireSheetsConfig();
    const auth = new google.auth.JWT({
      email,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsClientPromise = google.sheets({ version: 'v4', auth });
  }
  return sheetsClientPromise;
}

function isQuotaError(error) {
  const message = String(error?.message || error || '');
  return error?.code === 429
    || /quota exceeded|rate limit/i.test(message);
}

export function sheetsErrorMessage(error) {
  if (isQuotaError(error)) {
    return 'Google Sheets rate limit hit. Wait about a minute, keep linking identities, then click “Rematch stored Zoom data” once to apply them all.';
  }
  return error?.message || 'Google Sheets request failed';
}

async function withSheetsRetry(operation, { attempts = 4 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isQuotaError(error) || attempt === attempts) break;
      const delayMs = Math.min(15000, 1000 * (2 ** (attempt - 1)));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const wrapped = new Error(sheetsErrorMessage(lastError));
  wrapped.cause = lastError;
  throw wrapped;
}

function quoteSheetTitle(title) {
  return `'${title.replace(/'/g, "''")}'`;
}

function columnName(number) {
  let name = '';
  let current = number;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

export async function ensureWorkbookSheets({ force = false } = {}) {
  if (!force && Date.now() - workbookReadyAt < WORKBOOK_READY_TTL_MS) {
    return { created: [], cached: true };
  }

  return withSheetsRetry(async () => {
    const { spreadsheetId } = requireSheetsConfig();
    const sheets = await getSheetsClient();
    const workbook = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties.title',
    });
    const existingTitles = new Set(
      (workbook.data.sheets || []).map((sheet) => sheet.properties.title)
    );
    const missingTitles = Object.keys(WORKBOOK_SHEETS)
      .filter((title) => !existingTitles.has(title));

    if (missingTitles.length) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: missingTitles.map((title) => ({
            addSheet: { properties: { title } },
          })),
        },
      });
    }

    // First readiness pass (or force) refreshes all headers for schema migrations.
    // Later calls only header newly created tabs.
    const titlesToHeader = (force || workbookReadyAt === 0)
      ? Object.keys(WORKBOOK_SHEETS)
      : missingTitles;
    if (titlesToHeader.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: titlesToHeader.map((title) => ({
            range: `${quoteSheetTitle(title)}!A1:${columnName(WORKBOOK_SHEETS[title].length)}1`,
            values: [WORKBOOK_SHEETS[title]],
          })),
        },
      });
    }

    workbookReadyAt = Date.now();
    return { created: missingTitles, cached: false };
  });
}

export async function readSheetRows(title, columnCount) {
  return withSheetsRetry(async () => {
    const { spreadsheetId } = requireSheetsConfig();
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteSheetTitle(title)}!A2:${columnName(columnCount)}`,
    });
    return response.data.values || [];
  });
}

export async function readExternalSheetValues(spreadsheetId, range) {
  if (!spreadsheetId) {
    throw new Error('An external spreadsheet ID is required');
  }
  return withSheetsRetry(async () => {
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
    return response.data.values || [];
  });
}

export async function replaceSheetRows(title, headers, rows) {
  return withSheetsRetry(async () => {
    const { spreadsheetId } = requireSheetsConfig();
    const sheets = await getSheetsClient();
    const quotedTitle = quoteSheetTitle(title);
    const lastColumn = columnName(headers.length);

    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${quotedTitle}!A2:${lastColumn}`,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${quotedTitle}!A1:${lastColumn}${Math.max(rows.length + 1, 1)}`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers, ...rows] },
    });
  });
}

export async function appendSheetRow(title, row) {
  return withSheetsRetry(async () => {
    const { spreadsheetId } = requireSheetsConfig();
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${quoteSheetTitle(title)}!A:A`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
  });
}
