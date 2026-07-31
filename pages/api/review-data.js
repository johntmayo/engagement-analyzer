import { CAPTAIN_HEADERS, rowToCaptain } from '../../lib/airtable';
import {
  SESSION_OVERRIDE_HEADERS,
  SESSION_RULE_HEADERS,
  ZOOM_ATTENDANCE_HEADERS,
  ZOOM_MATCH_REVIEW_HEADERS,
  ZOOM_SESSION_HEADERS,
  ensureWorkbookSheets,
  readSheetRows,
} from '../../lib/google-sheets';
import { normalizeTopic, rowsToObjects } from '../../lib/zoom-matching';

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function diceSimilarity(left, right) {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const pairs = new Map();
  for (let i = 0; i < left.length - 1; i += 1) {
    const pair = left.slice(i, i + 2);
    pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < right.length - 1; i += 1) {
    const pair = right.slice(i, i + 2);
    const count = pairs.get(pair) || 0;
    if (count > 0) {
      overlap += 1;
      pairs.set(pair, count - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length - 2);
}

function captainSuggestions(name, captains) {
  const normalized = normalizeName(name);
  if (!normalized) return [];
  return captains
    .map((captain) => ({
      captainRecordId: captain.airtable_record_id,
      residentId: captain.resident_id,
      name: captain.full_name,
      email: captain.email,
      score: diceSimilarity(normalized, normalizeName(captain.full_name)),
    }))
    .filter((candidate) => candidate.score >= 0.64)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((candidate) => ({
      ...candidate,
      score: Math.round(candidate.score * 100),
    }));
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
      sessionRows,
      attendanceRows,
      reviewRows,
      ruleRows,
      overrideRows,
    ] = await Promise.all([
      readSheetRows('Captains', CAPTAIN_HEADERS.length),
      readSheetRows('Zoom Sessions', ZOOM_SESSION_HEADERS.length),
      readSheetRows('Zoom Attendance', ZOOM_ATTENDANCE_HEADERS.length),
      readSheetRows('Zoom Match Review', ZOOM_MATCH_REVIEW_HEADERS.length),
      readSheetRows('Session Rules', SESSION_RULE_HEADERS.length),
      readSheetRows('Session Overrides', SESSION_OVERRIDE_HEADERS.length),
    ]);

    const captains = captainRows.map(rowToCaptain)
      .filter((captain) => captain.is_active !== 'FALSE')
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
    const captainById = new Map(
      captains.map((captain) => [captain.airtable_record_id, captain])
    );
    const sessions = rowsToObjects(ZOOM_SESSION_HEADERS, sessionRows);
    const sessionById = new Map(
      sessions.map((session) => [session.session_id, session])
    );
    const attendance = rowsToObjects(ZOOM_ATTENDANCE_HEADERS, attendanceRows);
    const reviews = rowsToObjects(ZOOM_MATCH_REVIEW_HEADERS, reviewRows);
    const rules = rowsToObjects(SESSION_RULE_HEADERS, ruleRows);
    const overrides = rowsToObjects(SESSION_OVERRIDE_HEADERS, overrideRows);
    const rulesByTopic = new Map(rules.map((rule) => [rule.topic_key, rule]));
    const overridesBySession = new Map(
      overrides.map((override) => [override.session_id, override])
    );

    const identityGroups = new Map();
    reviews.forEach((review) => {
      const email = String(review.participant_email || '').trim().toLowerCase();
      const name = String(review.participant_name || '').trim();
      const sharedEmail = String(review.reason || '').includes(
        'maps to multiple captains'
      );
      const identityType = email && (!sharedEmail || !name) ? 'email' : 'name';
      const identityValue = identityType === 'email' ? email : normalizeName(name);
      if (!identityValue) return;
      const key = `${identityType}:${identityValue}`;
      const group = identityGroups.get(key) || {
        key,
        identityType,
        identityValue,
        displayName: name || '(No name)',
        email,
        appearances: 0,
        sessionIds: new Set(),
        topics: new Set(),
        dates: [],
        reasons: new Set(),
        candidateIds: new Set(),
        candidateNames: new Set(),
      };
      group.appearances += 1;
      group.sessionIds.add(review.session_id);
      if (review.topic) group.topics.add(review.topic);
      if (review.date) group.dates.push(review.date);
      if (review.reason) group.reasons.add(review.reason);
      String(review.candidate_captain_ids || '').split('|')
        .map((value) => value.trim()).filter(Boolean)
        .forEach((value) => group.candidateIds.add(value));
      String(review.candidate_names || '').split('|')
        .map((value) => value.trim()).filter(Boolean)
        .forEach((value) => group.candidateNames.add(value));
      identityGroups.set(key, group);
    });

    const identities = [...identityGroups.values()].map((group) => {
      const exactCandidates = [...group.candidateIds].map((id) => {
        const captain = captainById.get(id);
        return captain ? {
          captainRecordId: id,
          residentId: captain.resident_id,
          name: captain.full_name,
          email: captain.email,
          score: 100,
        } : null;
      }).filter(Boolean);
      return {
        key: group.key,
        identityType: group.identityType,
        identityValue: group.identityValue,
        displayName: group.displayName,
        email: group.email,
        appearances: group.appearances,
        sessions: group.sessionIds.size,
        topics: [...group.topics].slice(0, 5),
        firstSeen: group.dates.sort()[0] || '',
        lastSeen: group.dates.sort().at(-1) || '',
        reasons: [...group.reasons],
        suggestions: exactCandidates.length
          ? exactCandidates
          : captainSuggestions(group.displayName, captains),
      };
    }).sort((a, b) =>
      b.appearances - a.appearances || a.displayName.localeCompare(b.displayName)
    );

    const prospectGroups = new Map();
    attendance.filter((record) => record.match_status === 'prospective')
      .forEach((record) => {
        const key = String(
          record.participant_email || record.participant_name
        ).trim().toLowerCase();
        if (!key) return;
        const session = sessionById.get(record.session_id);
        const prospect = prospectGroups.get(key) || {
          key,
          name: record.participant_name || '(No name)',
          email: record.participant_email || '',
          dates: [],
          sessions: 0,
        };
        prospect.sessions += 1;
        if (session?.date) prospect.dates.push(session.date);
        prospectGroups.set(key, prospect);
      });
    const onboardingProspects = [...prospectGroups.values()].map((prospect) => ({
      ...prospect,
      firstSeen: prospect.dates.sort()[0] || '',
      lastSeen: prospect.dates.sort().at(-1) || '',
      dates: undefined,
    }));

    const attendanceBySession = new Map();
    attendance.forEach((record) => {
      const current = attendanceBySession.get(record.session_id) || [];
      current.push(record);
      attendanceBySession.set(record.session_id, current);
    });
    const meetingGroups = new Map();
    sessions.forEach((session) => {
      const topicKey = normalizeTopic(session.topic);
      const rule = rulesByTopic.get(topicKey);
      const records = attendanceBySession.get(session.session_id) || [];
      const group = meetingGroups.get(topicKey) || {
        topicKey,
        topic: session.topic,
        classification: rule?.classification || session.classification || 'unclassified',
        expectedZone: rule?.expected_zone || '',
        notes: rule?.notes || '',
        hostCaptainRecordId: rule?.host_captain_record_id || '',
        sessionIds: new Set(),
        dates: [],
        attendanceRecords: 0,
        matchedCaptains: 0,
        unmatched: 0,
        expectedGuests: 0,
        hostNames: new Set(),
        hostCaptainIds: new Set(),
        classifications: new Set(),
        sessionItems: [],
      };
      group.sessionIds.add(session.session_id);
      if (session.date) group.dates.push(session.date);
      group.attendanceRecords += records.length;
      group.matchedCaptains += records.filter(
        (record) => record.match_status === 'matched'
      ).length;
      group.unmatched += records.filter(
        (record) => ['unmatched', 'ambiguous', 'review'].includes(record.match_status)
      ).length;
      group.expectedGuests += records.filter(
        (record) => record.match_status === 'expected_guest'
      ).length;
      if (session.host_name) group.hostNames.add(session.host_name);
      if (session.host_captain_record_id) {
        group.hostCaptainIds.add(session.host_captain_record_id);
      }
      group.classifications.add(session.classification || 'unclassified');
      const override = overridesBySession.get(session.session_id);
      group.sessionItems.push({
        sessionId: session.session_id,
        date: session.date,
        durationMinutes: Number(session.duration_minutes) || 0,
        attendanceRecords: records.length,
        matchedCaptains: records.filter(
          (record) => record.match_status === 'matched'
        ).length,
        classification: session.classification || 'unclassified',
        classificationSource: session.classification_source || (
          override ? 'session_override' : rule ? 'series_default' : 'unclassified'
        ),
        expectedZone: session.expected_zone || '',
        hostName: session.host_name || '',
        hostCaptainRecordId: session.host_captain_record_id || '',
        override: override ? {
          classification: override.classification,
          expectedZone: override.expected_zone || '',
          notes: override.notes || '',
          hostCaptainRecordId: override.host_captain_record_id || '',
        } : null,
      });
      meetingGroups.set(topicKey, group);
    });

    const meetings = [...meetingGroups.values()].map((group) => ({
      topicKey: group.topicKey,
      topic: group.topic,
      classification: group.classification,
      expectedZone: group.expectedZone,
      notes: group.notes,
      hostCaptainRecordId: group.hostCaptainRecordId,
      sessions: group.sessionIds.size,
      firstDate: group.dates.sort()[0] || '',
      lastDate: group.dates.sort().at(-1) || '',
      attendanceRecords: group.attendanceRecords,
      matchedCaptains: group.matchedCaptains,
      unmatched: group.unmatched,
      expectedGuests: group.expectedGuests,
      hostNames: [...group.hostNames],
      hostCaptains: [...group.hostCaptainIds].map((id) =>
        captainById.get(id)?.full_name || id
      ),
      mixedClassifications: group.classifications.size > 1,
      classifications: [...group.classifications],
      sessionItems: group.sessionItems.sort(
        (a, b) => String(b.date).localeCompare(String(a.date))
      ),
    })).sort((a, b) => {
      if (a.classification !== b.classification) {
        if (a.classification === 'unclassified') return -1;
        if (b.classification === 'unclassified') return 1;
      }
      return b.lastDate.localeCompare(a.lastDate);
    });

    return res.status(200).json({
      identities,
      onboardingProspects,
      meetings,
      captains: captains.map((captain) => ({
        airtableRecordId: captain.airtable_record_id,
        residentId: captain.resident_id,
        name: captain.full_name,
        email: captain.email,
        zone: captain.zones,
      })),
      summary: {
        identitiesToReview: identities.length,
        reviewOccurrences: reviews.length,
        onboardingProspects: onboardingProspects.length,
        meetingTopics: meetings.length,
        unclassifiedMeetings: meetings.filter(
          (meeting) => meeting.classification === 'unclassified'
        ).length,
        matchedHosts: sessions.filter(
          (session) => session.host_match_status === 'matched'
        ).length,
      },
    });
  } catch (error) {
    console.error('Review data load failed:', error);
    return res.status(500).json({
      error: error.message || 'Review workspace could not be loaded',
    });
  }
}
