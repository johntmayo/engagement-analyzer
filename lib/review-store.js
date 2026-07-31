import { CAPTAIN_HEADERS, rowToCaptain } from './airtable';
import {
  IDENTITY_LINK_HEADERS,
  SESSION_OVERRIDE_HEADERS,
  SESSION_RULE_HEADERS,
  ensureWorkbookSheets,
  readSheetRows,
  replaceSheetRows,
} from './google-sheets';
import { rematchStoredZoomData } from './rematch-zoom';
import {
  normalizeTopic,
  objectsToRows,
  rowsToObjects,
  stableId,
} from './zoom-matching';

const IDENTITY_STATUSES = new Set([
  'linked',
  'non_captain',
  'ignored',
  'needs_research',
]);

const SESSION_CLASSIFICATIONS = new Set([
  'captain',
  'working_group',
  'captain_support',
  'onboarding',
  'community',
  'internal',
  'test_exclude',
  'unclassified',
]);

function normalizeIdentity(type, value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (type === 'email') return normalized;
  return normalized.replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function saveIdentityDecision({
  identityType,
  identityValue,
  status,
  captainRecordId = '',
  notes = '',
  rematch = false,
}) {
  if (!['email', 'name'].includes(identityType)) {
    throw new Error('Identity type must be email or name');
  }
  if (!IDENTITY_STATUSES.has(status)) {
    throw new Error('Unsupported identity decision');
  }
  if (status === 'linked' && !captainRecordId) {
    throw new Error('A captain is required for a linked identity');
  }

  await ensureWorkbookSheets();
  const [linkRows, captainRows] = await Promise.all([
    readSheetRows('Identity Links', IDENTITY_LINK_HEADERS.length),
    readSheetRows('Captains', CAPTAIN_HEADERS.length),
  ]);
  const links = rowsToObjects(IDENTITY_LINK_HEADERS, linkRows);
  const captains = captainRows.map(rowToCaptain);
  const captain = captains.find(
    (candidate) => candidate.airtable_record_id === captainRecordId
  );
  if (status === 'linked' && !captain) {
    throw new Error('The selected captain was not found');
  }

  const normalizedValue = normalizeIdentity(identityType, identityValue);
  if (!normalizedValue) throw new Error('Identity value is required');
  const now = new Date().toISOString();
  const existingIndex = links.findIndex((link) =>
    (link.source || 'zoom') === 'zoom'
    && link.identity_type === identityType
    && normalizeIdentity(identityType, link.identity_value) === normalizedValue
  );
  const existing = existingIndex >= 0 ? links[existingIndex] : null;
  const decision = {
    identity_link_id: existing?.identity_link_id
      || stableId('identity-decision', identityType, normalizedValue),
    captain_record_id: status === 'linked' ? captainRecordId : '',
    resident_id: status === 'linked' ? captain.resident_id || '' : '',
    source: 'zoom',
    identity_type: identityType,
    identity_value: normalizedValue,
    match_method: 'manual_review',
    confidence: 'certain',
    notes,
    created_at: existing?.created_at || now,
    updated_at: now,
    status,
  };

  if (existingIndex >= 0) links[existingIndex] = decision;
  else links.push(decision);

  await replaceSheetRows(
    'Identity Links',
    IDENTITY_LINK_HEADERS,
    objectsToRows(IDENTITY_LINK_HEADERS, links)
  );
  const rematchResult = rematch ? await rematchStoredZoomData() : null;
  return { decision, rematch: rematchResult, rematchPending: !rematch };
}

export async function saveSessionRule({
  topic,
  classification,
  expectedZone = '',
  notes = '',
  hostCaptainRecordId = '',
  rematch = false,
}) {
  if (!SESSION_CLASSIFICATIONS.has(classification)) {
    throw new Error('Unsupported session classification');
  }
  const topicKey = normalizeTopic(topic);
  if (!topicKey) throw new Error('Meeting topic is required');

  await ensureWorkbookSheets();
  const [ruleRows, captainRows] = await Promise.all([
    readSheetRows('Session Rules', SESSION_RULE_HEADERS.length),
    readSheetRows('Captains', CAPTAIN_HEADERS.length),
  ]);
  if (
    hostCaptainRecordId
    && !captainRows.map(rowToCaptain).some(
      (captain) => captain.airtable_record_id === hostCaptainRecordId
    )
  ) {
    throw new Error('The selected host captain was not found');
  }
  const rules = rowsToObjects(SESSION_RULE_HEADERS, ruleRows);
  const existingIndex = rules.findIndex((rule) => rule.topic_key === topicKey);
  const existing = existingIndex >= 0 ? rules[existingIndex] : null;
  const now = new Date().toISOString();
  const rule = {
    rule_id: existing?.rule_id || stableId('session-rule', topicKey),
    topic_key: topicKey,
    display_topic: topic,
    classification,
    expected_zone: expectedZone,
    notes,
    created_at: existing?.created_at || now,
    updated_at: now,
    host_captain_record_id: hostCaptainRecordId,
  };

  if (existingIndex >= 0) rules[existingIndex] = rule;
  else rules.push(rule);

  await replaceSheetRows(
    'Session Rules',
    SESSION_RULE_HEADERS,
    objectsToRows(SESSION_RULE_HEADERS, rules)
  );
  const rematchResult = rematch ? await rematchStoredZoomData() : null;
  return { rule, rematch: rematchResult, rematchPending: !rematch };
}

export async function saveSessionOverride({
  sessionId,
  classification,
  expectedZone = '',
  notes = '',
  hostCaptainRecordId = '',
  rematch = false,
}) {
  if (!sessionId) throw new Error('A session is required');
  if (!SESSION_CLASSIFICATIONS.has(classification)) {
    throw new Error('Unsupported session classification');
  }

  await ensureWorkbookSheets();
  const [overrideRows, captainRows] = await Promise.all([
    readSheetRows('Session Overrides', SESSION_OVERRIDE_HEADERS.length),
    readSheetRows('Captains', CAPTAIN_HEADERS.length),
  ]);
  if (
    hostCaptainRecordId
    && !captainRows.map(rowToCaptain).some(
      (captain) => captain.airtable_record_id === hostCaptainRecordId
    )
  ) {
    throw new Error('The selected host captain was not found');
  }

  const overrides = rowsToObjects(SESSION_OVERRIDE_HEADERS, overrideRows);
  const existingIndex = overrides.findIndex(
    (override) => override.session_id === sessionId
  );
  const existing = existingIndex >= 0 ? overrides[existingIndex] : null;
  const now = new Date().toISOString();
  const override = {
    override_id: existing?.override_id || stableId('session-override', sessionId),
    session_id: sessionId,
    classification,
    expected_zone: expectedZone,
    notes,
    host_captain_record_id: hostCaptainRecordId,
    created_at: existing?.created_at || now,
    updated_at: now,
  };

  if (existingIndex >= 0) overrides[existingIndex] = override;
  else overrides.push(override);

  await replaceSheetRows(
    'Session Overrides',
    SESSION_OVERRIDE_HEADERS,
    objectsToRows(SESSION_OVERRIDE_HEADERS, overrides)
  );
  const rematchResult = rematch ? await rematchStoredZoomData() : null;
  return { override, rematch: rematchResult, rematchPending: !rematch };
}
