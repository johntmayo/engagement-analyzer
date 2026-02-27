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
  // GET /users lists all licensed users on the account
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
      participants.push(...(data.participants || []));
      nextPageToken = data.next_page_token || '';
    } catch {
      break; // meeting deleted or no data, skip
    }
  } while (nextPageToken);
  return participants;
}

export function aggregate(sessions) {
  const volunteers = {};
  const totalSessions = sessions.length;

  sessions.forEach((s) => {
    s.participants.forEach((p) => {
      const key = p.email || `__name__${p.name}`;
      if (!volunteers[key]) {
        volunteers[key] = {
          name: p.name,
          email: p.email || null,
          sessionsAttended: 0,
          totalDuration: 0,
          lastSeen: null,
        };
      }
      const v = volunteers[key];
      v.sessionsAttended += 1;
      v.totalDuration += p.duration || 0;
      if (!v.lastSeen || s.date > v.lastSeen) v.lastSeen = s.date;
    });
  });

  return Object.values(volunteers).map((v) => ({
    ...v,
    attendanceRate: v.sessionsAttended / totalSessions,
    avgDurationMin: Math.round(v.totalDuration / v.sessionsAttended / 60),
    tier: v.sessionsAttended / totalSessions >= 0.75
      ? 'high'
      : v.sessionsAttended / totalSessions >= 0.4
      ? 'mid'
      : 'low',
  }));
}

// Parse Zoom participant CSVs exported with "Export with meeting data" checked
export function parseHistoricalCSVs(files) {
  return new Promise((resolve) => {
    const sessions = [];
    let remaining = files.length;

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

          // Row 2: blank, Row 3: participant headers, Row 4+: participants
          const participants = [];
          for (let i = 4; i < lines.length; i++) {
            const row = parseCSVRow(lines[i]);
            if (!row[0] || row[0].trim() === '') continue;
            const name = row[0].trim();
            const email = (row[1] || '').trim().toLowerCase() || null;
            const durationSec = (parseInt(row[2]) || 0) * 60; // CSV is minutes, convert to seconds
            participants.push({ name, email, duration: durationSec });
          }

          sessions.push({ meetingId, topic, date, duration: durationMin, participants, source: 'csv' });
        } catch (err) {
          console.error('Failed to parse', file.name, err);
        }
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

export function exportCSV(volunteers, sessions) {
  const headers = ['Name', 'Email', 'Sessions Attended', 'Total Sessions', 'Attendance Rate', 'Avg Duration (min)', 'Last Seen', 'Status'];
  const rows = volunteers.map((v) => [
    `"${v.name}"`,
    v.email || '',
    v.sessionsAttended,
    sessions.length,
    `${(v.attendanceRate * 100).toFixed(1)}%`,
    v.avgDurationMin,
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