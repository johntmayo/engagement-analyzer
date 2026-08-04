import {
  CAPTAIN_HEADERS,
  DATA_QUALITY_HEADERS,
  rowToCaptain,
} from '../../lib/airtable';
import {
  DASHBOARD_ACCESS_HEADERS,
  DASHBOARD_MATCH_REVIEW_HEADERS,
  EMAIL_EVENT_HEADERS,
  WORKBOOK_SHEETS,
  ZOOM_ATTENDANCE_HEADERS,
  ZOOM_MATCH_REVIEW_HEADERS,
  ZOOM_SESSION_HEADERS,
  ensureWorkbookSheets,
  readSheetRows,
} from '../../lib/google-sheets';

function rowsToObjects(headers, rows) {
  return rows.map((row) => Object.fromEntries(
    headers.map((header, index) => [header, row[index] ?? ''])
  ));
}

function newZoomSummary() {
  return {
    sessionIds: new Set(),
    totalDurationSeconds: 0,
    firstSeen: '',
    lastSeen: '',
    attendedByType: {
      captain: new Set(),
      working_group: new Set(),
      captain_support: new Set(),
      onboarding: new Set(),
      community: new Set(),
    },
    activityDates: new Map(),
    hostedSessionIds: new Set(),
    communityHostedIds: new Set(),
    lastHosted: '',
  };
}

function normalizeZoneToken(value) {
  return String(value || '').trim().toLowerCase();
}

function captainMatchesZone(captain, expectedZone) {
  const expected = normalizeZoneToken(expectedZone);
  if (!expected) return false;
  if (expected === 'all' || expected === '*' || expected === 'all captains') {
    return true;
  }
  return String(captain.zones || '').split('|')
    .map((zone) => normalizeZoneToken(zone))
    .filter(Boolean)
    .includes(expected);
}

function isEligibleCaptainSession(session) {
  return session.classification === 'captain'
    && Boolean(normalizeZoneToken(session.expected_zone));
}

function dashboardRecency(lastSeenAt, now = Date.now()) {
  const timestamp = Date.parse(lastSeenAt || '');
  if (!Number.isFinite(timestamp)) return 'Not observed';
  const days = Math.max(0, Math.floor((now - timestamp) / 86400000));
  if (days === 0) return 'Today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await ensureWorkbookSheets();
    const [
      captainRows,
      qualityRows,
      syncRows,
      zoomSessionRows,
      zoomAttendanceRows,
      zoomReviewRows,
      dashboardAccessRows,
      dashboardReviewRows,
      emailEventRows,
    ] = await Promise.all([
      readSheetRows('Captains', CAPTAIN_HEADERS.length),
      readSheetRows('Data Quality', DATA_QUALITY_HEADERS.length),
      readSheetRows('Sync Log', WORKBOOK_SHEETS['Sync Log'].length),
      readSheetRows('Zoom Sessions', ZOOM_SESSION_HEADERS.length),
      readSheetRows('Zoom Attendance', ZOOM_ATTENDANCE_HEADERS.length),
      readSheetRows('Zoom Match Review', ZOOM_MATCH_REVIEW_HEADERS.length),
      readSheetRows('Dashboard Access', DASHBOARD_ACCESS_HEADERS.length),
      readSheetRows('Dashboard Match Review', DASHBOARD_MATCH_REVIEW_HEADERS.length),
      readSheetRows('Email Events', EMAIL_EVENT_HEADERS.length),
    ]);

    const includeInactive = req.query.includeInactive === 'true';
    const baseCaptains = captainRows
      .map(rowToCaptain)
      .filter((captain) => includeInactive || captain.is_active !== 'FALSE');
    const issues = rowsToObjects(DATA_QUALITY_HEADERS, qualityRows);
    const syncLog = rowsToObjects(WORKBOOK_SHEETS['Sync Log'], syncRows);
    const zoomSessions = rowsToObjects(ZOOM_SESSION_HEADERS, zoomSessionRows);
    const zoomAttendance = rowsToObjects(
      ZOOM_ATTENDANCE_HEADERS,
      zoomAttendanceRows
    );
    const dashboardAccess = rowsToObjects(
      DASHBOARD_ACCESS_HEADERS,
      dashboardAccessRows
    );
    const emailEvents = rowsToObjects(EMAIL_EVENT_HEADERS, emailEventRows);
    const dashboardByCaptain = new Map();
    dashboardAccess.forEach((row) => {
      if (row.match_status !== 'matched' || !row.captain_record_id) return;
      const current = dashboardByCaptain.get(row.captain_record_id);
      if (!current) {
        dashboardByCaptain.set(row.captain_record_id, row);
        return;
      }
      const currentTime = Date.parse(current.last_seen_at || '') || 0;
      const nextTime = Date.parse(row.last_seen_at || '') || 0;
      if (nextTime >= currentTime) {
        dashboardByCaptain.set(row.captain_record_id, row);
      }
    });
    const emailByCaptain = new Map();
    emailEvents.forEach((event) => {
      if (event.match_status !== 'matched' || !event.captain_record_id) return;
      const current = emailByCaptain.get(event.captain_record_id) || {
        total: 0,
        inbound: 0,
        outbound: 0,
        lastAt: '',
      };
      current.total += 1;
      if (event.direction === 'inbound') current.inbound += 1;
      if (event.direction === 'outbound') current.outbound += 1;
      if (
        event.occurred_at
        && (!current.lastAt || event.occurred_at > current.lastAt)
      ) {
        current.lastAt = event.occurred_at;
      }
      emailByCaptain.set(event.captain_record_id, current);
    });
    const sessionById = new Map(
      zoomSessions.map((session) => [session.session_id, session])
    );
    const zoomByCaptain = new Map();

    zoomAttendance.forEach((attendance) => {
      if (attendance.match_status !== 'matched' || !attendance.captain_record_id) return;
      const session = sessionById.get(attendance.session_id);
      const current = zoomByCaptain.get(attendance.captain_record_id)
        || newZoomSummary();
      current.sessionIds.add(attendance.session_id);
      current.totalDurationSeconds += Number(attendance.duration_seconds) || 0;
      const classification = session?.classification || 'unclassified';
      current.attendedByType[classification]?.add(attendance.session_id);
      if (session?.date) {
        if (!current.firstSeen || session.date < current.firstSeen) {
          current.firstSeen = session.date;
        }
        if (!current.lastSeen || session.date > current.lastSeen) {
          current.lastSeen = session.date;
        }
        if (classification !== 'test_exclude') {
          current.activityDates.set(attendance.session_id, session.date);
        }
      }
      zoomByCaptain.set(attendance.captain_record_id, current);
    });
    zoomSessions.forEach((session) => {
      if (!session.host_captain_record_id) return;
      const current = zoomByCaptain.get(session.host_captain_record_id)
        || newZoomSummary();
      current.hostedSessionIds.add(session.session_id);
      if (session.classification === 'community') {
        current.communityHostedIds.add(session.session_id);
      }
      if (session.classification !== 'test_exclude' && session.date) {
        current.activityDates.set(`host:${session.session_id}`, session.date);
      }
      if (session.date && (!current.lastHosted || session.date > current.lastHosted)) {
        current.lastHosted = session.date;
      }
      zoomByCaptain.set(session.host_captain_record_id, current);
    });

    const captains = baseCaptains.map((captain) => {
      const zoom = zoomByCaptain.get(captain.airtable_record_id) || newZoomSummary();
      const dashboard = dashboardByCaptain.get(captain.airtable_record_id) || null;
      const email = emailByCaptain.get(captain.airtable_record_id) || null;
      const eligibleCaptainSessions = zoomSessions.filter((session) =>
        isEligibleCaptainSession(session)
        && captainMatchesZone(captain, session.expected_zone)
      );
      const eligibleIds = new Set(
        eligibleCaptainSessions.map((session) => session.session_id)
      );
      const eligibleAttended = [...zoom.attendedByType.captain].filter(
        (sessionId) => eligibleIds.has(sessionId)
      ).length;
      const attendanceRate = eligibleIds.size
        ? eligibleAttended / eligibleIds.size
        : null;
      const now = Date.now();
      const recent90 = [...zoom.activityDates.values()].filter((date) => {
        const age = (now - new Date(`${date}T00:00:00`).getTime()) / 86400000;
        return age >= 0 && age < 90;
      }).length;
      const prior90 = [...zoom.activityDates.values()].filter((date) => {
        const age = (now - new Date(`${date}T00:00:00`).getTime()) / 86400000;
        return age >= 90 && age < 180;
      }).length;
      const trend = recent90 > prior90 ? 'increasing'
        : recent90 < prior90 ? 'decreasing'
          : 'steady';
      const otherHosted = zoom.hostedSessionIds.size
        - zoom.communityHostedIds.size;
      const signal = (
        key,
        label,
        value,
        reason,
        source = 'Zoom Sessions + Zoom Attendance'
      ) => ({ key, label, value, reason, source });
      const signals = [
        signal(
          'captain_meetings_attended',
          'Captain meetings attended',
          zoom.attendedByType.captain.size,
          'Matched attendance in sessions classified as captain.'
        ),
        signal(
          'captain_attendance_rate',
          'Eligible captain-meeting attendance',
          attendanceRate === null
            ? 'Not available'
            : `${eligibleAttended}/${eligibleIds.size} (${Math.round(attendanceRate * 100)}%)`,
          'Only captain sessions with an explicit expected zone (or all/all captains) enter the rate. Zone-specific sessions apply only to matching zones; unclassified expected-zone blanks are excluded so all ~168 captains are not implied.'
        ),
        signal(
          'working_group_participation',
          'Working-group participation',
          zoom.attendedByType.working_group.size,
          'Optional working-group attendance is positive and never enters an absence denominator.'
        ),
        signal(
          'captain_support_interactions',
          'Captain-support interactions',
          zoom.attendedByType.captain_support.size,
          'Matched participation in one-to-one help, coaching, or troubleshooting.'
        ),
        signal(
          'onboarding_milestone',
          'Onboarding milestone',
          zoom.attendedByType.onboarding.size
            ? [...zoom.attendedByType.onboarding]
              .map((id) => sessionById.get(id)?.date).filter(Boolean).sort()[0]
            : 'Not observed',
          'Earliest matched attendance in a session classified as onboarding.'
        ),
        signal(
          'community_hosting',
          'Community meetings hosted',
          zoom.communityHostedIds.size,
          'Manual or identity-matched captain host on a community session; hosting is a strong leadership signal.',
          'Zoom Sessions + organizer host assignment'
        ),
        signal(
          'other_hosting',
          'Other meetings hosted',
          otherHosted,
          'Manual or identity-matched captain host on non-community sessions.',
          'Zoom Sessions + organizer host assignment'
        ),
        signal(
          'last_zoom_activity',
          'Last observed Zoom activity',
          [...zoom.activityDates.values()].sort().at(-1) || 'Not observed',
          'Latest non-excluded matched attendance or credited hosting activity.'
        ),
        signal(
          'last_dashboard_access',
          'Last dashboard use',
          dashboardRecency(dashboard?.last_seen_at, now),
          dashboard
            ? `Last seen ${dashboard.last_seen_at} for matched dashboard login `
              + `${dashboard.login_email}. Absence here never counts against a captain.`
            : 'No matched Zone Dashboard User Access row for this captain yet.',
          'Zone Dashboard User Access'
        ),
        signal(
          'email_interactions',
          'Mailbox interactions',
          email
            ? `${email.total} (${email.inbound} in / ${email.outbound} out)`
            : 'Not observed',
          email
            ? 'Matched inbound/outbound correspondence events stored from mailbox sync.'
            : 'Gmail/mailbox events are not loaded for this captain yet.',
          'Gmail / mailbox'
        ),
        signal(
          'last_email_activity',
          'Last mailbox activity',
          email?.lastAt || 'Not observed',
          email
            ? 'Latest matched inbound or outbound email event.'
            : 'No matched mailbox events yet.',
          'Gmail / mailbox'
        ),
        signal(
          'organizer_interaction',
          'Last organizer-recorded interaction',
          captain.last_organizer_recorded_interaction || 'Not recorded',
          'Organizer-maintained interaction date from the Airtable captain roster.',
          'Airtable People'
        ),
        signal(
          'zoom_trend',
          'Zoom activity trend',
          `${trend} (${recent90} recent / ${prior90} prior)`,
          'Compares observed attendance and hosting events in the latest 90 days with the preceding 90 days.'
        ),
      ];
      return {
        ...captain,
        zoom: {
          sessionsAttended: zoom.sessionIds.size,
          totalDurationMinutes: Math.round(zoom.totalDurationSeconds / 60),
          firstSeen: zoom.firstSeen,
          lastSeen: zoom.lastSeen,
          captainMeetingsAttended: zoom.attendedByType.captain.size,
          eligibleCaptainMeetings: eligibleIds.size,
          eligibleCaptainMeetingsAttended: eligibleAttended,
          captainMeetingAttendanceRate: attendanceRate,
          workingGroupParticipations: zoom.attendedByType.working_group.size,
          captainSupportInteractions: zoom.attendedByType.captain_support.size,
          onboardingMilestone: zoom.attendedByType.onboarding.size
            ? [...zoom.attendedByType.onboarding]
              .map((id) => sessionById.get(id)?.date).filter(Boolean).sort()[0] || ''
            : '',
          sessionsHosted: zoom.hostedSessionIds.size,
          communitySessionsHosted: zoom.communityHostedIds.size,
          otherSessionsHosted: otherHosted,
          lastHosted: zoom.lastHosted,
          trend: { direction: trend, recent90, prior90 },
        },
        dashboard: dashboard
          ? {
            loginEmail: dashboard.login_email,
            lastSeenAt: dashboard.last_seen_at || '',
            loginCount: Number(dashboard.login_count) || 0,
            matchMethod: dashboard.match_method || '',
          }
          : null,
        email: email
          ? {
            total: email.total,
            inbound: email.inbound,
            outbound: email.outbound,
            lastAt: email.lastAt || '',
          }
          : null,
        signals,
      };
    });
    const latestSync = [...syncLog].reverse()
      .find((entry) => entry.source === 'airtable') || null;
    const latestZoomSync = [...syncLog].reverse()
      .find((entry) => entry.source === 'zoom') || null;
    const latestDashboardSync = [...syncLog].reverse()
      .find((entry) => entry.source === 'dashboard_access') || null;
    const latestGmailSync = [...syncLog].reverse()
      .find((entry) => entry.source === 'gmail') || null;

    return res.status(200).json({
      captains,
      issues,
      latestSync,
      latestZoomSync,
      latestDashboardSync,
      latestGmailSync,
      summary: {
        captains: captains.length,
        zones: new Set(captains.flatMap((captain) =>
          String(captain.zones || '').split('|').map((zone) => zone.trim()).filter(Boolean)
        )).size,
        missingResidentIds: issues.filter((issue) =>
          issue.type === 'missing_resident_id'
        ).length,
        reviewFlags: issues.filter((issue) =>
          issue.type !== 'missing_resident_id'
        ).length,
        zoomSessions: zoomSessions.length,
        matchedZoomAttendances: zoomAttendance.filter((attendance) =>
          attendance.match_status === 'matched'
        ).length,
        zoomReviews: zoomReviewRows.length,
        matchedZoomHosts: zoomSessions.filter((session) =>
          session.host_match_status === 'matched'
        ).length,
        dashboardMatched: dashboardAccess.filter((row) =>
          row.match_status === 'matched'
        ).length,
        dashboardReviews: dashboardReviewRows.length,
        emailEvents: emailEvents.length,
        emailMatched: emailEvents.filter((event) =>
          event.match_status === 'matched'
        ).length,
      },
    });
  } catch (error) {
    console.error('Captain roster load failed:', error);
    return res.status(500).json({
      error: error.message || 'Captain roster could not be loaded',
    });
  }
}
