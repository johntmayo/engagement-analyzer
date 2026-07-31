const AIRTABLE_API_BASE = 'https://api.airtable.com/v0';

export const AIRTABLE_FIELDS = [
  'Full Name',
  'resident_id',
  'Zones',
  'Address',
  'Email',
  'Additional Email Addresses',
  'Phone',
  'Date Trained',
  'Engagement Status',
  'First Name',
  'NOTES / BIO',
  'Last Organizer-Recorded Interaction',
  'Last Updated By',
  'Gmail For Dashboard Access',
  'Shirt Status',
  'Special Opportunity',
];

export const CAPTAIN_HEADERS = [
  'airtable_record_id',
  'resident_id',
  'full_name',
  'first_name',
  'zones',
  'address',
  'email',
  'additional_email_addresses',
  'dashboard_gmail',
  'phone',
  'date_trained',
  'engagement_status',
  'notes_bio',
  'last_organizer_recorded_interaction',
  'last_updated_by',
  'shirt_status',
  'special_opportunity',
  'airtable_created_time',
  'synced_at',
  'is_active',
];

export const DATA_QUALITY_HEADERS = [
  'issue_key',
  'type',
  'severity',
  'captain_record_id',
  'related_record_id',
  'message',
  'evidence',
  'confidence',
  'detected_at',
];

function requireAirtableConfig() {
  const config = {
    token: process.env.AIRTABLE_ACCESS_TOKEN,
    baseId: process.env.AIRTABLE_BASE_ID,
    tableName: process.env.AIRTABLE_TABLE_NAME || 'People',
    viewName: process.env.AIRTABLE_VIEW_NAME || 'Engagement Analyzer',
  };

  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length) {
    throw new Error(`Missing Airtable configuration: ${missing.join(', ')}`);
  }

  return config;
}

async function airtableRequest(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Airtable request failed (${response.status}): ${details}`);
  }

  return response.json();
}

async function fetchAirtableRecords({
  token,
  baseId,
  tableIdentifier,
  viewName,
  fields = [],
}) {
  const records = [];
  let offset;

  do {
    const url = new URL(
      `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(tableIdentifier)}`
    );
    if (viewName) url.searchParams.set('view', viewName);
    url.searchParams.set('pageSize', '100');
    fields.forEach((field) => url.searchParams.append('fields[]', field));
    if (offset) url.searchParams.set('offset', offset);

    const page = await airtableRequest(url, token);
    records.push(...(page.records || []));
    offset = page.offset;
  } while (offset);

  return records;
}

async function getAirtableSchema(token, baseId) {
  const url = new URL(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`);
  return airtableRequest(url, token);
}

export async function fetchAirtableCaptains() {
  const { token, baseId, tableName, viewName } = requireAirtableConfig();
  const [schema, records] = await Promise.all([
    getAirtableSchema(token, baseId),
    fetchAirtableRecords({
      token,
      baseId,
      tableIdentifier: tableName,
      viewName,
      fields: AIRTABLE_FIELDS,
    }),
  ]);

  const peopleTable = (schema.tables || []).find((table) => table.name === tableName);
  if (!peopleTable) {
    throw new Error(`Airtable table "${tableName}" was not found in the base schema.`);
  }

  const linkedFields = (peopleTable.fields || []).filter((field) =>
    AIRTABLE_FIELDS.includes(field.name)
    && field.type === 'multipleRecordLinks'
    && field.options?.linkedTableId
  );
  const linkedTableIds = [...new Set(
    linkedFields.map((field) => field.options.linkedTableId)
  )];
  const linkedValuesByTable = new Map();

  await Promise.all(linkedTableIds.map(async (linkedTableId) => {
    const linkedTable = schema.tables.find((table) => table.id === linkedTableId);
    const primaryField = linkedTable?.fields?.find(
      (field) => field.id === linkedTable.primaryFieldId
    );
    if (!linkedTable || !primaryField) return;

    const linkedRecords = await fetchAirtableRecords({
      token,
      baseId,
      tableIdentifier: linkedTable.id,
      fields: [primaryField.name],
    });
    linkedValuesByTable.set(linkedTableId, new Map(
      linkedRecords.map((record) => [
        record.id,
        serializeValue(record.fields?.[primaryField.name]) || record.id,
      ])
    ));
  }));

  return records.map((record) => {
    const fields = { ...(record.fields || {}) };
    linkedFields.forEach((field) => {
      const valueMap = linkedValuesByTable.get(field.options.linkedTableId);
      if (!valueMap || !Array.isArray(fields[field.name])) return;
      fields[field.name] = fields[field.name].map((recordId) =>
        valueMap.get(recordId) || recordId
      );
    });
    return { ...record, fields };
  });
}

function serializeValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue).filter(Boolean).join(' | ');
  }
  if (typeof value === 'object') {
    return value.name || value.email || value.id || JSON.stringify(value);
  }
  return String(value);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function parseAdditionalEmails(value) {
  const candidates = Array.isArray(value)
    ? value
    : String(value || '').split(/[\n,;]+/);

  return [...new Set(candidates.map(normalizeEmail).filter(Boolean))];
}

export function normalizeAirtableCaptain(record, syncedAt = new Date().toISOString()) {
  const fields = record.fields || {};
  const primaryEmail = normalizeEmail(fields.Email);
  const dashboardEmail = normalizeEmail(fields['Gmail For Dashboard Access']);
  const additionalEmails = parseAdditionalEmails(fields['Additional Email Addresses'])
    .filter((email) => email !== primaryEmail && email !== dashboardEmail);

  return {
    airtable_record_id: record.id,
    resident_id: serializeValue(fields.resident_id).trim(),
    full_name: serializeValue(fields['Full Name']).trim(),
    first_name: serializeValue(fields['First Name']).trim(),
    zones: serializeValue(fields.Zones),
    address: serializeValue(fields.Address),
    email: primaryEmail,
    additional_email_addresses: additionalEmails.join('\n'),
    dashboard_gmail: dashboardEmail,
    phone: serializeValue(fields.Phone),
    date_trained: serializeValue(fields['Date Trained']),
    engagement_status: serializeValue(fields['Engagement Status']),
    notes_bio: serializeValue(fields['NOTES / BIO']),
    last_organizer_recorded_interaction: serializeValue(
      fields['Last Organizer-Recorded Interaction']
    ),
    last_updated_by: serializeValue(fields['Last Updated By']),
    shirt_status: serializeValue(fields['Shirt Status']),
    special_opportunity: serializeValue(fields['Special Opportunity']),
    airtable_created_time: record.createdTime || '',
    synced_at: syncedAt,
    is_active: 'TRUE',
  };
}

export function captainToRow(captain) {
  return CAPTAIN_HEADERS.map((header) => captain[header] ?? '');
}

export function rowToCaptain(row) {
  return Object.fromEntries(CAPTAIN_HEADERS.map((header, index) => [header, row[index] ?? '']));
}

function normalizedName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function captainEmails(captain) {
  return [...new Set([
    captain.email,
    captain.dashboard_gmail,
    ...parseAdditionalEmails(captain.additional_email_addresses),
  ].map(normalizeEmail).filter(Boolean))];
}

function emailRoles(captain, email) {
  const normalized = normalizeEmail(email);
  const roles = [];
  if (normalizeEmail(captain.email) === normalized) roles.push('primary contact');
  if (normalizeEmail(captain.dashboard_gmail) === normalized) roles.push('dashboard login');
  if (parseAdditionalEmails(captain.additional_email_addresses).includes(normalized)) {
    roles.push('additional address');
  }
  return roles;
}

export function detectDataQualityIssues(captains, detectedAt = new Date().toISOString()) {
  const issues = [];
  const detectedDate = new Date(detectedAt);
  const addIssue = ({
    key,
    type,
    severity,
    captain,
    related = '',
    message,
    evidence,
    confidence,
  }) => {
    issues.push([
      key,
      type,
      severity,
      captain.airtable_record_id,
      related,
      message,
      evidence,
      confidence,
      detectedAt,
    ]);
  };

  captains.forEach((captain) => {
    if (!captain.resident_id) {
      addIssue({
        key: `missing-resident-id:${captain.airtable_record_id}`,
        type: 'missing_resident_id',
        severity: 'warning',
        captain,
        message: `${captain.full_name || 'Unnamed captain'} is missing a permanent resident_id.`,
        evidence: `Airtable record ${captain.airtable_record_id}`,
        confidence: 'certain',
      });
    }

    const interactionValue = captain.last_organizer_recorded_interaction;
    if (interactionValue) {
      const interactionDate = new Date(`${interactionValue}T00:00:00`);
      const year = interactionDate.getFullYear();
      const invalidDate = Number.isNaN(interactionDate.getTime())
        || year < 2020
        || interactionDate > detectedDate;

      if (invalidDate) {
        addIssue({
          key: `invalid-manual-interaction-date:${captain.airtable_record_id}`,
          type: 'invalid_manual_interaction_date',
          severity: 'error',
          captain,
          message: `${captain.full_name || 'This captain'} has a suspicious organizer-recorded interaction date.`,
          evidence: interactionValue,
          confidence: 'certain',
        });
      } else {
        const ageDays = Math.floor((detectedDate - interactionDate) / 86400000);
        if (ageDays > 180) {
          addIssue({
            key: `stale-manual-interaction:${captain.airtable_record_id}`,
            type: 'stale_manual_interaction',
            severity: 'review',
            captain,
            message: `No organizer-recorded interaction has been entered for ${captain.full_name || 'this captain'} in ${ageDays} days. This does not mean no interaction occurred.`,
            evidence: interactionValue,
            confidence: 'certain',
          });
        }
      }
    }
  });

  const indexes = [
    {
      type: 'duplicate_resident_id',
      severity: 'error',
      values: (captain) => captain.resident_id ? [captain.resident_id.toLowerCase()] : [],
      label: 'resident_id',
      confidence: 'certain',
    },
    {
      type: 'shared_email',
      severity: 'warning',
      values: captainEmails,
      label: 'email address',
      confidence: 'high',
    },
    {
      type: 'possible_duplicate_name',
      severity: 'review',
      values: (captain) => {
        const name = normalizedName(captain.full_name);
        return name ? [name] : [];
      },
      label: 'normalized full name',
      confidence: 'medium',
    },
  ];

  indexes.forEach((index) => {
    const byValue = new Map();
    captains.forEach((captain) => {
      index.values(captain).forEach((value) => {
        const matches = byValue.get(value) || [];
        matches.push(captain);
        byValue.set(value, matches);
      });
    });

    byValue.forEach((matches, value) => {
      if (matches.length < 2) return;
      for (let i = 0; i < matches.length; i += 1) {
        for (let j = i + 1; j < matches.length; j += 1) {
          const captain = matches[i];
          const related = matches[j];
          const pair = [captain.airtable_record_id, related.airtable_record_id].sort().join(':');
          let severity = index.severity;
          let confidence = index.confidence;
          let message = `${captain.full_name || captain.airtable_record_id} and ${related.full_name || related.airtable_record_id} share the same ${index.label}.`;
          let evidence = value;

          if (index.type === 'shared_email') {
            const captainRoles = emailRoles(captain, value);
            const relatedRoles = emailRoles(related, value);
            const dashboardOnly = [...captainRoles, ...relatedRoles]
              .every((role) => role === 'dashboard login');
            severity = dashboardOnly ? 'review' : 'warning';
            confidence = dashboardOnly ? 'medium' : 'high';
            message = `${captain.full_name || captain.airtable_record_id} (${captainRoles.join(', ')}) and ${related.full_name || related.airtable_record_id} (${relatedRoles.join(', ')}) share an email address.`;
            evidence = `${value} | ${captainRoles.join(', ')} ↔ ${relatedRoles.join(', ')}`;
          }

          addIssue({
            key: `${index.type}:${value}:${pair}`,
            type: index.type,
            severity,
            captain,
            related: related.airtable_record_id,
            message,
            evidence,
            confidence,
          });
        }
      }
    });
  });

  return issues;
}
