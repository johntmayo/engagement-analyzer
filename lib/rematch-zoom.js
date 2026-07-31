import { CAPTAIN_HEADERS, rowToCaptain } from './airtable';
import {
  IDENTITY_LINK_HEADERS,
  SESSION_OVERRIDE_HEADERS,
  SESSION_RULE_HEADERS,
  ZOOM_ATTENDANCE_HEADERS,
  ZOOM_MATCH_REVIEW_HEADERS,
  ZOOM_SESSION_HEADERS,
  appendSheetRow,
  ensureWorkbookSheets,
  readSheetRows,
  replaceSheetRows,
} from './google-sheets';
import { objectsToRows, rematchZoomData, rowsToObjects } from './zoom-matching';

export async function rematchStoredZoomData({ writeLog = true } = {}) {
  const startedAt = Date.now();
  const syncedAt = new Date().toISOString();
  await ensureWorkbookSheets();

  const [
    captainRows,
    identityLinkRows,
    sessionRuleRows,
    sessionOverrideRows,
    sessionRows,
    attendanceRows,
  ] = await Promise.all([
    readSheetRows('Captains', CAPTAIN_HEADERS.length),
    readSheetRows('Identity Links', IDENTITY_LINK_HEADERS.length),
    readSheetRows('Session Rules', SESSION_RULE_HEADERS.length),
    readSheetRows('Session Overrides', SESSION_OVERRIDE_HEADERS.length),
    readSheetRows('Zoom Sessions', ZOOM_SESSION_HEADERS.length),
    readSheetRows('Zoom Attendance', ZOOM_ATTENDANCE_HEADERS.length),
  ]);

  const result = rematchZoomData({
    captains: captainRows.map(rowToCaptain)
      .filter((captain) => captain.airtable_record_id),
    identityLinks: rowsToObjects(IDENTITY_LINK_HEADERS, identityLinkRows),
    sessionRules: rowsToObjects(SESSION_RULE_HEADERS, sessionRuleRows),
    sessionOverrides: rowsToObjects(
      SESSION_OVERRIDE_HEADERS,
      sessionOverrideRows
    ),
    sessions: rowsToObjects(ZOOM_SESSION_HEADERS, sessionRows)
      .filter((session) => session.session_id),
    attendance: rowsToObjects(ZOOM_ATTENDANCE_HEADERS, attendanceRows)
      .filter((record) => record.attendance_id),
    syncedAt,
  });

  await Promise.all([
    replaceSheetRows(
      'Zoom Sessions',
      ZOOM_SESSION_HEADERS,
      objectsToRows(ZOOM_SESSION_HEADERS, result.sessions)
    ),
    replaceSheetRows(
      'Zoom Attendance',
      ZOOM_ATTENDANCE_HEADERS,
      objectsToRows(ZOOM_ATTENDANCE_HEADERS, result.attendance)
    ),
    replaceSheetRows(
      'Zoom Match Review',
      ZOOM_MATCH_REVIEW_HEADERS,
      objectsToRows(ZOOM_MATCH_REVIEW_HEADERS, result.reviews)
    ),
  ]);

  const durationMs = Date.now() - startedAt;
  if (writeLog) {
    await appendSheetRow('Sync Log', [
      syncedAt,
      'zoom_rematch',
      'success',
      result.summary.sessions,
      result.summary.captainsMatched,
      0,
      result.summary.reviewsNeeded,
      durationMs,
      `${result.summary.matchedAttendances}/${result.summary.attendanceRecords} attendance records matched; ${result.summary.hostsMatched} hosts matched`,
    ]);
  }

  return { syncedAt, durationMs, ...result.summary };
}
