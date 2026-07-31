import { createHash } from 'crypto';

import { buildCaptainIdentityIndex, matchZoomParticipant } from './identity';

export function stableId(...parts) {
  return createHash('sha256')
    .update(parts.map((part) => String(part || '')).join('|'))
    .digest('hex')
    .slice(0, 24);
}

export function normalizeTopic(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function rowsToObjects(headers, rows) {
  return rows.map((row) => Object.fromEntries(
    headers.map((header, index) => [header, row[index] ?? ''])
  ));
}

export function objectsToRows(headers, objects) {
  return objects.map((object) => headers.map((header) => object[header] ?? ''));
}

function reviewReason(method) {
  const reasons = {
    conflicting_manual_links: 'Conflicting manual identity links',
    shared_email: 'Email address maps to multiple captains',
    shared_exact_name: 'Exact name maps to multiple captains',
    unrecognized_email_and_name: 'Email and name are not recognized',
    unrecognized_name: 'Name is not recognized and no email was provided',
    manual_needs_research: 'Previously marked as needing more research',
  };
  return reasons[method] || 'Identity requires review';
}

function ruleIndex(rules) {
  return new Map(rules.map((rule) => [
    rule.topic_key || normalizeTopic(rule.display_topic),
    rule,
  ]));
}

function shouldCreateReview(match, classification) {
  if (['matched', 'non_captain', 'ignored'].includes(match.status)) return false;
  if (['internal', 'test_exclude', 'onboarding'].includes(classification)) return false;
  if (classification === 'community' && match.status === 'unmatched') return false;
  return true;
}

export function rematchZoomData({
  sessions,
  attendance,
  captains,
  identityLinks,
  sessionRules,
  sessionOverrides = [],
  syncedAt = new Date().toISOString(),
}) {
  const identityIndex = buildCaptainIdentityIndex(captains, identityLinks);
  const rules = ruleIndex(sessionRules);
  const overrides = new Map(
    sessionOverrides.map((override) => [override.session_id, override])
  );
  const matchedCaptainIds = new Set();
  const matchedHostIds = new Set();

  const rematchedSessions = sessions.map((session) => {
    const rule = rules.get(normalizeTopic(session.topic));
    const override = overrides.get(session.session_id);
    const classification = override?.classification
      || rule?.classification
      || session.classification
      || 'unclassified';
    const hostIdentity = {
      name: session.host_name || '',
      email: session.host_email || '',
    };
    const hostMatch = (hostIdentity.name || hostIdentity.email)
      ? matchZoomParticipant(hostIdentity, identityIndex)
      : null;
    const assignedHostId = override?.host_captain_record_id
      || rule?.host_captain_record_id;
    const assignedHost = assignedHostId
      ? identityIndex.byId.get(assignedHostId)
      : null;
    const hostCaptain = assignedHost || hostMatch?.captain || null;
    if (hostCaptain) {
      matchedHostIds.add(hostCaptain.airtable_record_id);
    }
    return {
      ...session,
      host_captain_record_id: hostCaptain?.airtable_record_id || '',
      host_match_status: assignedHost ? 'matched' : hostMatch?.status || 'unknown',
      host_match_confidence: assignedHost ? 'certain' : hostMatch?.confidence || 'none',
      classification,
      classification_source: override
        ? 'session_override'
        : rule
          ? 'series_default'
          : 'unclassified',
      expected_zone: override?.expected_zone || rule?.expected_zone || '',
      synced_at: syncedAt,
    };
  });

  const sessionsById = new Map(
    rematchedSessions.map((session) => [session.session_id, session])
  );
  const reviews = [];
  const rematchedAttendance = attendance.map((record) => {
    const session = sessionsById.get(record.session_id);
    const classification = session?.classification || 'unclassified';
    const match = matchZoomParticipant({
      name: record.participant_name,
      email: record.participant_email,
    }, identityIndex);
    let status = match.status;
    let method = match.method;

    if (classification === 'community' && match.status === 'unmatched') {
      status = 'expected_guest';
      method = 'community_guest';
    } else if (classification === 'onboarding' && match.status === 'unmatched') {
      status = 'prospective';
      method = 'onboarding_prospect';
    } else if (
      ['internal', 'test_exclude'].includes(classification)
      && ['unmatched', 'ambiguous', 'review'].includes(match.status)
    ) {
      status = 'excluded';
      method = 'excluded_session';
    }

    if (match.captain) {
      matchedCaptainIds.add(match.captain.airtable_record_id);
    }

    const rematched = {
      ...record,
      captain_record_id: match.captain?.airtable_record_id || '',
      resident_id: match.captain?.resident_id || '',
      match_status: status,
      match_confidence: match.confidence,
      match_method: method,
      synced_at: syncedAt,
      session_classification: classification,
    };

    if (shouldCreateReview(match, classification)) {
      reviews.push({
        review_id: stableId('review', record.attendance_id),
        session_id: record.session_id,
        topic: session?.topic || '',
        date: session?.date || '',
        participant_name: record.participant_name || '',
        participant_email: record.participant_email || '',
        reason: reviewReason(match.method),
        candidate_captain_ids: match.candidates
          .map((captain) => captain.airtable_record_id).join(' | '),
        candidate_names: match.candidates
          .map((captain) => captain.full_name).join(' | '),
        confidence: match.confidence,
        detected_at: syncedAt,
      });
    }

    return rematched;
  });

  const matchedAttendances = rematchedAttendance.filter(
    (record) => record.match_status === 'matched'
  ).length;

  return {
    sessions: rematchedSessions,
    attendance: rematchedAttendance,
    reviews: reviews.sort((a, b) => String(b.date).localeCompare(String(a.date))),
    summary: {
      sessions: rematchedSessions.length,
      attendanceRecords: rematchedAttendance.length,
      matchedAttendances,
      captainsMatched: matchedCaptainIds.size,
      hostsMatched: rematchedSessions.filter((session) =>
        session.host_match_status === 'matched'
      ).length,
      captainHostsMatched: matchedHostIds.size,
      reviewsNeeded: reviews.length,
      expectedGuests: rematchedAttendance.filter((record) =>
        record.match_status === 'expected_guest'
      ).length,
      onboardingProspects: rematchedAttendance.filter((record) =>
        record.match_status === 'prospective'
      ).length,
    },
  };
}
