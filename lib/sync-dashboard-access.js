import { CAPTAIN_HEADERS, rowToCaptain } from './airtable';
import {
  DASHBOARD_ACCESS_HEADERS,
  DASHBOARD_ACCESS_SOURCE_HEADERS,
  DASHBOARD_MATCH_REVIEW_HEADERS,
  IDENTITY_LINK_HEADERS,
  appendSheetRow,
  ensureWorkbookSheets,
  readExternalSheetValues,
  readSheetRows,
  replaceSheetRows,
} from './google-sheets';
import {
  buildCaptainIdentityIndex,
  matchIdentityByEmail,
} from './identity';
import { objectsToRows, rowsToObjects, stableId } from './zoom-matching';

const ACCESS_COLUMN_ALIASES = {
  login_email: ['login_email', 'login email', 'email'],
  sheet_url: ['sheet_url', 'sheet url'],
  zone_name: ['zone_name', 'zone name'],
  captain_display_name: [
    'captain_display_name',
    'captain display name',
    'captain_name',
    'captain name',
  ],
  contact_email: ['contact_email', 'contact email'],
  role: ['role'],
  active: ['active'],
  last_seen_at: ['last_seen_at', 'last seen at'],
  login_count: ['login_count', 'login count'],
};

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isActiveValue(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized === 'TRUE' || normalized === 'YES' || normalized === '1';
}

function parseLoginCount(value) {
  const count = Number.parseInt(String(value || '0').replace(/,/g, ''), 10);
  return Number.isFinite(count) ? count : 0;
}

function laterTimestamp(a, b) {
  const aTime = Date.parse(a || '');
  const bTime = Date.parse(b || '');
  if (!Number.isFinite(aTime)) return b || '';
  if (!Number.isFinite(bTime)) return a || '';
  return bTime >= aTime ? b : a;
}

function columnIndexes(headers) {
  return Object.fromEntries(
    Object.entries(ACCESS_COLUMN_ALIASES).map(([key, aliases]) => {
      const normalizedAliases = new Set(aliases.map(normalizeHeader));
      const index = headers.findIndex((header) =>
        normalizedAliases.has(normalizeHeader(header))
      );
      return [key, index];
    })
  );
}

function rowValue(row, indexes, key) {
  const index = indexes[key];
  return index >= 0 ? row[index] ?? '' : '';
}

function parseAccessRows(values) {
  if (!values.length) return [];
  const headers = (values[0] || []).map((header) => String(header || '').trim());
  const indexes = columnIndexes(headers);
  if (indexes.login_email < 0) {
    throw new Error(
      'Access source is missing a login_email column. Expected Zone Dashboard Access headers.'
    );
  }

  return values.slice(1)
    .map((row, index) => {
      const loginEmail = normalizeEmail(rowValue(row, indexes, 'login_email'));
      if (!loginEmail) return null;
      return {
        rowNumber: index + 2,
        login_email: loginEmail,
        sheet_url: String(rowValue(row, indexes, 'sheet_url') || '').trim(),
        zone_name: String(rowValue(row, indexes, 'zone_name') || '').trim(),
        captain_display_name: String(
          rowValue(row, indexes, 'captain_display_name') || ''
        ).trim(),
        contact_email: normalizeEmail(rowValue(row, indexes, 'contact_email')),
        role: String(rowValue(row, indexes, 'role') || 'captain').trim().toLowerCase()
          || 'captain',
        active: isActiveValue(rowValue(row, indexes, 'active')),
        last_seen_at: String(rowValue(row, indexes, 'last_seen_at') || '').trim(),
        login_count: parseLoginCount(rowValue(row, indexes, 'login_count')),
      };
    })
    .filter(Boolean);
}

function aggregateAccessRows(rows) {
  const byEmail = new Map();
  rows.forEach((row) => {
    const current = byEmail.get(row.login_email) || {
      login_email: row.login_email,
      display_name: '',
      zones: new Set(),
      roles: new Set(),
      active: false,
      last_seen_at: '',
      login_count: 0,
      source_rows: 0,
      contact_email: '',
    };
    current.source_rows += 1;
    current.active = current.active || row.active;
    current.last_seen_at = laterTimestamp(current.last_seen_at, row.last_seen_at);
    current.login_count = Math.max(current.login_count, row.login_count);
    if (row.zone_name) current.zones.add(row.zone_name);
    if (row.role) current.roles.add(row.role);
    if (!current.display_name && row.captain_display_name) {
      current.display_name = row.captain_display_name;
    }
    if (!current.contact_email && row.contact_email) {
      current.contact_email = row.contact_email;
    }
    byEmail.set(row.login_email, current);
  });
  return [...byEmail.values()].map((entry) => ({
    ...entry,
    zones: [...entry.zones].join(' | '),
    role: entry.roles.has('admin')
      ? 'admin'
      : [...entry.roles][0] || 'captain',
  }));
}

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

function matchDashboardIdentity(entry, index) {
  // Email-first only. Never auto-match dashboard logins by display name.
  const emailMatch = matchIdentityByEmail(entry.login_email, index);
  if (EMAIL_SAFE_METHODS.has(emailMatch.method)) {
    return emailMatch;
  }

  // Staff / admin rows that never match a captain are expected non-captains.
  if (entry.role === 'admin' || entry.role === 'lot_weeding_admin') {
    return {
      status: 'non_captain',
      captain: null,
      candidates: [],
      confidence: 'high',
      method: 'dashboard_admin_role',
    };
  }

  return {
    status: 'unmatched',
    captain: null,
    candidates: [],
    confidence: 'none',
    method: 'unrecognized_dashboard_email',
  };
}

async function loadAccessSourceValues() {
  const externalId = String(process.env.USER_ACCESS_SHEET_ID || '').trim();
  if (externalId) {
    const values = await readExternalSheetValues(externalId, 'Access!A1:Z10000');
    return {
      source: 'user_access_sheet',
      spreadsheetId: externalId,
      values,
    };
  }

  const sourceRows = await readSheetRows(
    'Dashboard Access Source',
    DASHBOARD_ACCESS_SOURCE_HEADERS.length
  );
  if (!sourceRows.length) {
    throw new Error(
      'No dashboard access source configured. Set USER_ACCESS_SHEET_ID to the Zone Dashboard User Access Registry spreadsheet ID (share Viewer access with the Analyzer service account), or paste Access-tab rows into the workbook tab “Dashboard Access Source”.'
    );
  }
  return {
    source: 'workbook_source_tab',
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
    values: [DASHBOARD_ACCESS_SOURCE_HEADERS, ...sourceRows],
  };
}

export async function syncDashboardAccess() {
  const startedAt = Date.now();
  const syncedAt = new Date().toISOString();

  await ensureWorkbookSheets();
  const [{ source, values }, captainRows, identityRows] = await Promise.all([
    loadAccessSourceValues(),
    readSheetRows('Captains', CAPTAIN_HEADERS.length),
    readSheetRows('Identity Links', IDENTITY_LINK_HEADERS.length),
  ]);

  const captains = captainRows.map(rowToCaptain);
  const identityLinks = rowsToObjects(IDENTITY_LINK_HEADERS, identityRows);
  const index = buildCaptainIdentityIndex(captains, identityLinks, {
    sources: ['zoom', 'dashboard', 'gmail'],
  });

  const parsedRows = parseAccessRows(values);
  const aggregated = aggregateAccessRows(parsedRows);
  const accessRecords = [];
  const reviewRecords = [];

  aggregated.forEach((entry) => {
    const match = matchDashboardIdentity(entry, index);
    const accessId = stableId(['dashboard', entry.login_email]);
    const captain = match.captain;
    const matchStatus = match.status === 'matched'
      ? 'matched'
      : match.status === 'non_captain'
        ? 'non_captain'
        : match.status === 'ignored'
          ? 'ignored'
          : match.status === 'ambiguous'
            ? 'ambiguous'
            : 'unmatched';

    accessRecords.push({
      access_id: accessId,
      login_email: entry.login_email,
      captain_record_id: captain?.airtable_record_id || '',
      resident_id: captain?.resident_id || '',
      display_name: entry.display_name || captain?.full_name || '',
      zones: entry.zones || captain?.zones || '',
      role: entry.role,
      active: entry.active ? 'TRUE' : 'FALSE',
      last_seen_at: entry.last_seen_at,
      login_count: String(entry.login_count || 0),
      match_status: matchStatus,
      match_confidence: match.confidence || 'none',
      match_method: match.method || '',
      source_rows: String(entry.source_rows || 0),
      synced_at: syncedAt,
    });

    if (matchStatus === 'unmatched' || matchStatus === 'ambiguous') {
      reviewRecords.push({
        review_id: stableId(['dashboard-review', entry.login_email]),
        login_email: entry.login_email,
        display_name: entry.display_name,
        zones: entry.zones,
        role: entry.role,
        last_seen_at: entry.last_seen_at,
        login_count: String(entry.login_count || 0),
        reason: matchStatus === 'ambiguous'
          ? 'Multiple captains share this dashboard login email'
          : 'Dashboard login email is not linked to a captain',
        candidate_captain_ids: (match.candidates || [])
          .map((candidate) => candidate.airtable_record_id)
          .join('|'),
        candidate_names: (match.candidates || [])
          .map((candidate) => candidate.full_name)
          .join('|'),
        confidence: match.confidence || 'none',
        detected_at: syncedAt,
      });
    }
  });

  accessRecords.sort((a, b) => {
    const aTime = Date.parse(a.last_seen_at || '') || 0;
    const bTime = Date.parse(b.last_seen_at || '') || 0;
    return bTime - aTime || a.login_email.localeCompare(b.login_email);
  });
  reviewRecords.sort((a, b) => a.login_email.localeCompare(b.login_email));

  await replaceSheetRows(
    'Dashboard Access',
    DASHBOARD_ACCESS_HEADERS,
    objectsToRows(DASHBOARD_ACCESS_HEADERS, accessRecords)
  );
  await replaceSheetRows(
    'Dashboard Match Review',
    DASHBOARD_MATCH_REVIEW_HEADERS,
    objectsToRows(DASHBOARD_MATCH_REVIEW_HEADERS, reviewRecords)
  );

  const matched = accessRecords.filter((row) => row.match_status === 'matched');
  const withActivity = matched.filter((row) => row.last_seen_at);
  const durationMs = Date.now() - startedAt;
  await appendSheetRow('Sync Log', [
    syncedAt,
    'dashboard_access',
    'success',
    parsedRows.length,
    matched.length,
    accessRecords.filter((row) => row.active !== 'TRUE').length,
    reviewRecords.length,
    durationMs,
    `Source=${source}; ${withActivity.length} matched captains have last_seen_at`,
  ]);

  return {
    syncedAt,
    source,
    recordsFetched: parsedRows.length,
    uniqueLogins: accessRecords.length,
    matchedCaptains: matched.length,
    withLastSeen: withActivity.length,
    reviewsNeeded: reviewRecords.length,
    nonCaptains: accessRecords.filter((row) => row.match_status === 'non_captain').length,
    durationMs,
  };
}
