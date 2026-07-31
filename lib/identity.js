function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function additionalEmails(value) {
  return String(value || '')
    .split(/[\n,;]+/)
    .map(normalizeEmail)
    .filter(Boolean);
}

function addToIndex(index, value, captain) {
  if (!value) return;
  const matches = index.get(value) || [];
  if (!matches.some((match) => match.airtable_record_id === captain.airtable_record_id)) {
    matches.push(captain);
    index.set(value, matches);
  }
}

function addDecision(index, value, decision) {
  if (!value) return;
  const decisions = index.get(value) || [];
  decisions.push(decision);
  index.set(value, decisions);
}

export function buildCaptainIdentityIndex(
  captains,
  identityLinks = [],
  { sources = null } = {}
) {
  const byId = new Map();
  const byEmail = new Map();
  const byName = new Map();
  const manualEmail = new Map();
  const manualName = new Map();
  const allowedSources = sources
    ? new Set([...sources].map((source) => String(source).toLowerCase()))
    : null;

  captains.forEach((captain) => {
    byId.set(captain.airtable_record_id, captain);
    [
      captain.email,
      captain.dashboard_gmail,
      ...additionalEmails(captain.additional_email_addresses),
    ].map(normalizeEmail).filter(Boolean)
      .forEach((email) => addToIndex(byEmail, email, captain));
    addToIndex(byName, normalizeName(captain.full_name), captain);
  });

  identityLinks.forEach((link) => {
    const source = String(link.source || 'zoom').toLowerCase();
    if (allowedSources && !allowedSources.has(source)) return;
    const captain = byId.get(link.captain_record_id);
    const type = String(link.identity_type || '').toLowerCase();
    const value = type === 'email'
      ? normalizeEmail(link.identity_value)
      : normalizeName(link.identity_value);
    if (!value) return;
    const status = link.status || (captain ? 'linked' : 'needs_research');
    if (status === 'linked' && !captain) return;
    addDecision(type === 'email' ? manualEmail : manualName, value, {
      status,
      captain,
      link,
    });
  });

  return { byId, byEmail, byName, manualEmail, manualName };
}

/** Email-first matcher for non-Zoom sources (dashboard login, mailbox, etc.). */
export function matchIdentityByEmail(email, index, { name = '' } = {}) {
  return matchZoomParticipant({ email, name }, index);
}

export function matchZoomParticipant(participant, index) {
  const email = normalizeEmail(participant.email);
  const name = normalizeName(participant.name);
  const manualEmailMatches = email ? index.manualEmail.get(email) || [] : [];
  const manualMatches = manualEmailMatches.length
    ? manualEmailMatches
    : index.manualName.get(name) || [];

  if (manualMatches.length === 1) {
    const decision = manualMatches[0];
    if (decision.status === 'non_captain') {
      return {
        status: 'non_captain',
        captain: null,
        candidates: [],
        confidence: 'certain',
        method: 'manual_non_captain',
      };
    }
    if (decision.status === 'ignored') {
      return {
        status: 'ignored',
        captain: null,
        candidates: [],
        confidence: 'certain',
        method: 'manual_ignore',
      };
    }
    if (decision.status === 'needs_research') {
      return {
        status: 'review',
        captain: null,
        candidates: [],
        confidence: 'none',
        method: 'manual_needs_research',
      };
    }
    return {
      status: 'matched',
      captain: decision.captain,
      candidates: [decision.captain],
      confidence: 'certain',
      method: 'manual_identity_link',
    };
  }
  if (manualMatches.length > 1) {
    return {
      status: 'ambiguous',
      captain: null,
      candidates: manualMatches.map((decision) => decision.captain).filter(Boolean),
      confidence: 'low',
      method: 'conflicting_manual_links',
    };
  }

  const emailMatches = email ? index.byEmail.get(email) || [] : [];
  const nameMatches = name ? index.byName.get(name) || [] : [];

  if (emailMatches.length === 1) {
    return {
      status: 'matched',
      captain: emailMatches[0],
      candidates: emailMatches,
      confidence: 'high',
      method: 'unique_email',
    };
  }

  if (emailMatches.length > 1) {
    const nameWithinEmail = emailMatches.filter((captain) =>
      normalizeName(captain.full_name) === name
    );
    if (nameWithinEmail.length === 1) {
      return {
        status: 'matched',
        captain: nameWithinEmail[0],
        candidates: emailMatches,
        confidence: 'high',
        method: 'shared_email_exact_name',
      };
    }
    return {
      status: 'ambiguous',
      captain: null,
      candidates: emailMatches,
      confidence: 'low',
      method: 'shared_email',
    };
  }

  if (nameMatches.length === 1) {
    return {
      status: 'matched',
      captain: nameMatches[0],
      candidates: nameMatches,
      confidence: 'medium',
      method: email ? 'unrecognized_email_exact_name' : 'exact_name',
    };
  }

  if (nameMatches.length > 1) {
    return {
      status: 'ambiguous',
      captain: null,
      candidates: nameMatches,
      confidence: 'low',
      method: 'shared_exact_name',
    };
  }

  return {
    status: 'unmatched',
    captain: null,
    candidates: [],
    confidence: 'none',
    method: email ? 'unrecognized_email_and_name' : 'unrecognized_name',
  };
}
