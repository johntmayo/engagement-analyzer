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

export async function getHostUserId(token) {
  // GET /users lists account users - works with user:read:admin, no need for /users/me
  const data = await zoomFetch(token, '/users', { page_size: '1' });
  if (!data.users || data.users.length === 0) {
    throw new Error('No users found on this Zoom account.');
  }
  return data.users[0].id;
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