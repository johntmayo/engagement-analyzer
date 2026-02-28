// lib/zoom.js
// All Zoom API calls route through /api/zoom-proxy to avoid CORS

const DELAY_MS = 150;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function zoomFetch(token, path, params = {}) {
  const res = await fetch('/api/zoom-proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, path, params }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `API error ${res.status}`);
  return data;
}

export async function getToken() {
  const res = await fetch('/api/zoom-token', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Auth failed');
  return { token: data.access_token };
}

export async function getAllUserIds(token) {
  const data = await zoomFetch(token, '/users', { page_size: '10' });
  if (!data.users || data.users.length === 0) {
    throw new Error('No users found on this Zoom account.');
  }
  return data.users.map(u => u.id);
}

export function chunkDateRange(from, to) {
  const chunks = [];
  let cursor = new Date(from);
  const end = new Date(to);
  while (cursor < end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setMonth(chunkEnd.getMonth() + 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({
      from: cursor.toISOString().slice(0, 10),
      to: chunkEnd.toISOString().slice(0, 10),
    });
    cursor = new Date(chunkEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  return chunks;
}

export async function fetchMeetingsInRange(token, userId, from, to, onProgress) {
  const meetings = [];
  let nextPageToken = '';
  do {
    const params = { from, to, page_size: '300' };
    if (nextPageToken) params.next_page_token = nextPageToken;
    const data = await zoomFetch(token, `/report/users/${userId}/meetings`, params);
    meetings.push(...(data.meetings || []));
    nextPageToken = data.next_page_token || '';
    onProgress?.(`Found ${meetings.length} sessions so far…`);
  } while (nextPageToken);
  return meetings;
}

export async function fetchParticipants(token, meetingUuid) {
  // Zoom requires double-encoding of UUIDs containing / or //
  const encoded = meetingUuid.includes('/') || meetingUuid.startsWith('//')
    ? encodeURIComponent(encodeURIComponent(meetingUuid))
    : meetingUuid;

  const participants = [];
  let nextPageToken = '';
  do {
    const params = { page_size: '300' };
    if (nextPageToken) params.next_page_token = nextPageToken;
    try {
      const data = await zoomFetch(token, `/report/meetings/${encoded}/participants`, params);
      // Zoom API returns email as `user_email`; normalize to `email` for consistency with CSV data
      const normalized = (data.participants || []).map(p => ({
        ...p,
        email: (p.user_email || p.email || '').toLowerCase().trim() || null,
      }));
      participants.push(...normalized);
      nextPageToken = data.next_page_token || '';
    } catch {
      break; // meeting deleted or no data, skip
    }
  } while (nextPageToken);
  return participants;
}

// ─── UNIDENTIFIED PARTICIPANT DETECTION ───────────────────────────────────────
// Flags participants who joined with a phone number or generic device name
// instead of a real name. These are excluded from volunteer stats.

const DEVICE_PATTERN = /^(iphone|ipad|android|samsung|galaxy|pixel|huawei|oppo|xiaomi|oneplus|motorola|lg\b|zoom\s*user|user\s*\d*|unknown|guest\s*\d*|h\.323|sip\b)/i;
const PHONE_PATTERN = /^[\+]?[\d\s\-\(\)\.x]{6,}$/;

export function isUnidentified(p) {
  const name = (p.name || '').trim();
  if (name.length < 2) return true;
  if (PHONE_PATTERN.test(name)) return true;
  if (DEVICE_PATTERN.test(name)) return true;
  return false;
}

// ─── AGGREGATE ────────────────────────────────────────────────────────────────

export function aggregate(sessions) {
  const identifiedMap = {};
  const unidentifiedMap = {};
  const totalSessions = sessions.length;

  sessions.forEach((s) => {
    s.participants.forEach((p) => {
      const unid = isUnidentified(p);
      const map = unid ? unidentifiedMap : identifiedMap;
      const key = p.email || `__name__${p.name}`;
      if (!map[key]) {
        map[key] = {
          name: p.name,
          email: p.email || null,
          sessionsAttended: 0,
          totalDuration: 0,
          lastSeen: null,
          firstSeen: null,
        };
      }
      const v = map[key];
      v.sessionsAttended += 1;
      v.totalDuration += p.duration || 0;
      if (!v.lastSeen || s.date > v.lastSeen) v.lastSeen = s.date;
      if (!v.firstSeen || s.date < v.firstSeen) v.firstSeen = s.date;
    });
  });

  const toVolunteer = (v) => ({
    ...v,
    attendanceRate: v.sessionsAttended / totalSessions,
    avgDurationMin: Math.round(v.totalDuration / v.sessionsAttended / 60),
    tier: v.sessionsAttended / totalSessions >= 0.75
      ? 'high'
      : v.sessionsAttended / totalSessions >= 0.4
      ? 'mid'
      : 'low',
  });

  return {
    volunteers: Object.values(identifiedMap).map(toVolunteer),
    unidentified: Object.values(unidentifiedMap).map(toVolunteer),
  };
}

// ─── SESSION LIBRARY (localStorage) ──────────────────────────────────────────

const LS_KEY = 'altagether_library';

export function saveLibrary(sessions) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      sessions,
      savedAt: new Date().toISOString(),
    }));
    return true;
  } catch (e) {
    console.warn('localStorage save failed (data may be too large):', e);
    return false;
  }
}

export function loadLibrary() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearLibrary() {
  try { localStorage.removeItem(LS_KEY); } catch {}
}

// Merges two session arrays, deduplicating by meetingId (preferring API data over CSV).
export function mergeSessions(existing, incoming) {
  const map = new Map();

  const keyFor = (s) => {
    // meetingId from CSV may be a plain numeric string matching the API meeting ID.
    // Use it as a key so the same meeting from both sources deduplicates properly.
    if (s.meetingId && !/\.(csv|xlsx?)$/i.test(s.meetingId)) {
      return `id:${s.meetingId}`;
    }
    return `dt:${s.date}__${s.topic}`;
  };

  for (const s of existing) map.set(keyFor(s), s);
  for (const s of incoming) {
    const key = keyFor(s);
    const prev = map.get(key);
    // API data (no source or source='api') beats CSV data
    if (!prev || (s.source !== 'csv') || (prev.source === 'csv')) {
      map.set(key, s);
    }
  }

  return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));
}

// ─── CSV PARSING ──────────────────────────────────────────────────────────────

// Parse Zoom participant CSVs exported with "Export with meeting data" checked
export function parseHistoricalCSVs(files, onProgress) {
  return new Promise((resolve) => {
    const sessions = [];
    let remaining = files.length;
    let done = 0;

    if (remaining === 0) { resolve([]); return; }

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const text = e.target.result.replace(/^\uFEFF/, ''); // strip BOM
          const lines = text.split(/\r?\n/);

          // Row 0: meeting metadata headers
          // Row 1: meeting metadata values
          const metaVals = parseCSVRow(lines[1] || '');
          const topic = metaVals[0] || 'Unknown';
          const startRaw = metaVals[4] || '';
          // Parse "02/25/2025 06:59:56 PM" → "2025-02-25"
          const dateParts = startRaw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          const date = dateParts ? `${dateParts[3]}-${dateParts[1]}-${dateParts[2]}` : file.name.slice(-14, -4);
          const durationMin = parseInt(metaVals[3]) || 0;
          const meetingId = metaVals[1] || file.name;

          // Row 2: blank, Row 3: participant column headers, Row 4+: participants
          const participants = [];
          for (let i = 4; i < lines.length; i++) {
            const row = parseCSVRow(lines[i]);
            if (!row[0] || row[0].trim() === '') continue;
            const name = row[0].trim();
            const email = (row[1] || '').trim().toLowerCase() || null;
            const durationSec = (parseInt(row[2]) || 0) * 60; // CSV is minutes → seconds
            participants.push({ name, email, duration: durationSec });
          }

          sessions.push({ meetingId, topic, date, duration: durationMin, participants, source: 'csv' });
        } catch (err) {
          console.error('Failed to parse', file.name, err);
        }
        done++;
        onProgress?.(done, files.length);
        remaining--;
        if (remaining === 0) resolve(sessions);
      };
      reader.readAsText(file);
    });
  });
}

function parseCSVRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

// ─── CSV EXPORT ───────────────────────────────────────────────────────────────

export function exportCSV(volunteers, sessions) {
  const headers = ['Name', 'Email', 'Sessions Attended', 'Total Sessions', 'Attendance Rate', 'Avg Duration (min)', 'First Seen', 'Last Seen', 'Status'];
  const rows = volunteers.map((v) => [
    `"${v.name}"`,
    v.email || '',
    v.sessionsAttended,
    sessions.length,
    `${(v.attendanceRate * 100).toFixed(1)}%`,
    v.avgDurationMin,
    v.firstSeen || '',
    v.lastSeen,
    v.tier === 'high' ? 'Active' : v.tier === 'mid' ? 'Sporadic' : 'At Risk',
  ]);
  const csv = [headers, ...rows].map((r) => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `altagether-engagement-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

export { DELAY_MS };
