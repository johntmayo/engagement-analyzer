import { createHash } from 'crypto';

import { CAPTAIN_HEADERS, rowToCaptain } from './airtable';
import { buildCaptainIdentityIndex, matchZoomParticipant } from './identity';
import { rematchStoredZoomData } from './rematch-zoom';
import {
  IDENTITY_LINK_HEADERS,
  ZOOM_ATTENDANCE_HEADERS,
  ZOOM_MATCH_REVIEW_HEADERS,
  ZOOM_SESSION_HEADERS,
  appendSheetRow,
  ensureWorkbookSheets,
  readSheetRows,
  replaceSheetRows,
} from './google-sheets';

function stableId(...parts) {
  return createHash('sha256')
    .update(parts.map((part) => String(part || '')).join('|'))
    .digest('hex')
    .slice(0, 24);
}

function rowsToObjects(headers, rows) {
  return rows.map((row) => Object.fromEntries(
    headers.map((header, index) => [header, row[index] ?? ''])
  ));
}

function objectsToRows(headers, objects) {
  return objects.map((object) => headers.map((header) => object[header] ?? ''));
}

function reviewReason(method) {
  const reasons = {
    conflicting_manual_links: 'Conflicting manual identity links',
    shared_email: 'Email address maps to multiple captains',
    shared_exact_name: 'Exact name maps to multiple captains',
    unrecognized_email_and_name: 'Email and name are not recognized',
    unrecognized_name: 'Name is not recognized and no email was provided',
  };
  return reasons[method] || 'Identity requires review';
}

export async function syncZoomSessionsToSheets(sessions) {
  const startedAt = Date.now();
  const syncedAt = new Date().toISOString();
  await ensureWorkbookSheets();

  const [
    captainRows,
    identityLinkRows,
    existingSessionRows,
    existingAttendanceRows,
    existingReviewRows,
  ] = await Promise.all([
    readSheetRows('Captains', CAPTAIN_HEADERS.length),
    readSheetRows('Identity Links', IDENTITY_LINK_HEADERS.length),
    readSheetRows('Zoom Sessions', ZOOM_SESSION_HEADERS.length),
    readSheetRows('Zoom Attendance', ZOOM_ATTENDANCE_HEADERS.length),
    readSheetRows('Zoom Match Review', ZOOM_MATCH_REVIEW_HEADERS.length),
  ]);

  const captains = captainRows
    .map(rowToCaptain)
    .filter((captain) => captain.airtable_record_id);
  const identityLinks = rowsToObjects(IDENTITY_LINK_HEADERS, identityLinkRows);
  const identityIndex = buildCaptainIdentityIndex(captains, identityLinks);
  const incomingSessionIds = new Set();
  const newSessions = [];
  const newAttendance = [];
  const newReviews = [];
  const matchedCaptainIds = new Set();

  sessions.forEach((session) => {
    const sessionId = stableId(
      'session',
      session.meetingId,
      session.date,
      session.topic
    );
    incomingSessionIds.add(sessionId);
    newSessions.push({
      session_id: sessionId,
      meeting_id: session.meetingId || '',
      topic: session.topic || '(Untitled)',
      date: session.date || '',
      duration_minutes: Number(session.duration) || 0,
      source: session.source || 'api',
      synced_at: syncedAt,
      host_id: session.hostId || '',
      host_name: session.hostName || '',
      host_email: String(session.hostEmail || '').trim().toLowerCase(),
      host_captain_record_id: '',
      host_match_status: 'unknown',
      host_match_confidence: 'none',
      classification: 'unclassified',
      classification_source: 'unclassified',
      expected_zone: '',
    });

    (session.participants || []).forEach((participant) => {
      const match = matchZoomParticipant(participant, identityIndex);
      const participantIdentity = String(
        participant.email || participant.name || 'unknown'
      ).trim().toLowerCase();
      const attendanceId = stableId('attendance', sessionId, participantIdentity);
      if (match.captain) {
        matchedCaptainIds.add(match.captain.airtable_record_id);
      }

      newAttendance.push({
        attendance_id: attendanceId,
        session_id: sessionId,
        captain_record_id: match.captain?.airtable_record_id || '',
        resident_id: match.captain?.resident_id || '',
        participant_name: participant.name || '',
        participant_email: String(participant.email || '').trim().toLowerCase(),
        duration_seconds: Number(participant.duration) || 0,
        match_status: match.status,
        match_confidence: match.confidence,
        match_method: match.method,
        synced_at: syncedAt,
        session_classification: 'unclassified',
      });

      if (match.status !== 'matched') {
        newReviews.push({
          review_id: stableId('review', attendanceId),
          session_id: sessionId,
          topic: session.topic || '(Untitled)',
          date: session.date || '',
          participant_name: participant.name || '',
          participant_email: String(participant.email || '').trim().toLowerCase(),
          reason: reviewReason(match.method),
          candidate_captain_ids: match.candidates
            .map((captain) => captain.airtable_record_id).join(' | '),
          candidate_names: match.candidates
            .map((captain) => captain.full_name).join(' | '),
          confidence: match.confidence,
          detected_at: syncedAt,
        });
      }
    });
  });

  const sessionMap = new Map(
    rowsToObjects(ZOOM_SESSION_HEADERS, existingSessionRows)
      .map((session) => [session.session_id, session])
  );
  newSessions.forEach((session) => {
    const existing = sessionMap.get(session.session_id);
    sessionMap.set(session.session_id, {
      ...session,
      classification: existing?.classification || session.classification,
      classification_source:
        existing?.classification_source || session.classification_source,
      expected_zone: existing?.expected_zone || '',
    });
  });

  const retainedAttendance = rowsToObjects(
    ZOOM_ATTENDANCE_HEADERS,
    existingAttendanceRows
  ).filter((attendance) => !incomingSessionIds.has(attendance.session_id));
  const retainedReviews = rowsToObjects(
    ZOOM_MATCH_REVIEW_HEADERS,
    existingReviewRows
  ).filter((review) => !incomingSessionIds.has(review.session_id));

  const mergedSessions = [...sessionMap.values()]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const mergedAttendance = [...retainedAttendance, ...newAttendance];
  const mergedReviews = [...retainedReviews, ...newReviews]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  await replaceSheetRows(
    'Zoom Sessions',
    ZOOM_SESSION_HEADERS,
    objectsToRows(ZOOM_SESSION_HEADERS, mergedSessions)
  );
  await replaceSheetRows(
    'Zoom Attendance',
    ZOOM_ATTENDANCE_HEADERS,
    objectsToRows(ZOOM_ATTENDANCE_HEADERS, mergedAttendance)
  );
  await replaceSheetRows(
    'Zoom Match Review',
    ZOOM_MATCH_REVIEW_HEADERS,
    objectsToRows(ZOOM_MATCH_REVIEW_HEADERS, mergedReviews)
  );

  const rematched = await rematchStoredZoomData({ writeLog: false });
  const durationMs = Date.now() - startedAt;
  await appendSheetRow('Sync Log', [
    syncedAt,
    'zoom',
    'success',
    sessions.length,
    rematched.captainsMatched,
    0,
    rematched.reviewsNeeded,
    durationMs,
    `${rematched.matchedAttendances}/${rematched.attendanceRecords} attendance records matched; ${rematched.hostsMatched} hosts matched`,
  ]);

  return {
    syncedAt,
    sessionsProcessed: sessions.length,
    attendanceRecords: rematched.attendanceRecords,
    matchedAttendances: rematched.matchedAttendances,
    captainsMatched: rematched.captainsMatched,
    hostsMatched: rematched.hostsMatched,
    reviewsNeeded: rematched.reviewsNeeded,
    expectedGuests: rematched.expectedGuests,
    durationMs,
  };
}
