import { useState, useCallback, useMemo } from 'react';
import Head from 'next/head';
import {
  getToken, getAllUserIds, chunkDateRange,
  fetchMeetingsInRange, fetchParticipants,
  aggregate, exportCSV, parseHistoricalCSVs, sleep, DELAY_MS
} from '../lib/zoom';

// ─── SMALL COMPONENTS ─────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent = '#00c2a8' }) {
  return (
    <div style={{
      background: '#111c24',
      border: '1px solid #1e2f3d',
      borderRadius: 12,
      padding: '20px 24px',
      borderTop: `3px solid ${accent}`,
    }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: '#e8f4f0', fontFamily: "'DM Mono', monospace" }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: '#8fa3b1', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </div>
      {sub && <div style={{ fontSize: 11, color: '#556677', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Badge({ tier }) {
  const map = {
    high: { bg: '#00c2a822', color: '#00c2a8', label: 'Active' },
    mid:  { bg: '#f0b42922', color: '#f0b429', label: 'Sporadic' },
    low:  { bg: '#e0525222', color: '#e05252', label: 'At Risk' },
  };
  const { bg, color, label } = map[tier] || map.low;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      fontSize: 11, fontWeight: 600, background: bg, color,
      letterSpacing: '0.05em',
    }}>
      {label}
    </span>
  );
}

function SessionRow({ session, index }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: '1px solid #1a2630', animation: `fadeIn 0.3s ease ${index * 0.025}s both` }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', padding: '12px 20px',
          cursor: 'pointer', gap: 14, transition: 'background 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.background = '#111c24'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        <div style={{ width: 96, fontSize: 12, color: '#556677', fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>
          {session.date}
        </div>
        <div style={{ flex: 1, fontSize: 14, color: '#c8dce8' }}>{session.topic}</div>
        <div style={{ fontSize: 13, color: '#00c2a8', fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>
          {session.participants.length} attended
        </div>
        <div style={{ color: '#2a3d4d', fontSize: 11 }}>{open ? '▲' : '▼'}</div>
      </div>
      {open && (
        <div style={{ padding: '0 20px 14px 130px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {session.participants.map((p, i) => (
              <span key={i} style={{
                background: '#1a2e3a', borderRadius: 4,
                padding: '3px 9px', fontSize: 12, color: '#8fa3b1',
              }} title={p.email || 'No email'}>
                {p.name}
                <span style={{ color: '#2a3d4d', marginLeft: 5 }}>
                  {Math.round((p.duration || 0) / 60)}m
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── MAIN PAGE ─────────────────────────────────────────────────────────────────

export default function Home() {
  const today = new Date().toISOString().slice(0, 10);
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const [fromDate, setFromDate] = useState(threeMonthsAgo.toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(today);
  const [topicFilter, setTopicFilter] = useState('');

  const [csvFiles, setCsvFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [progress, setProgress] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [error, setError] = useState('');

  const [sessions, setSessions] = useState(null);
  const [volunteers, setVolunteers] = useState(null);

  const [tab, setTab] = useState('sessions');
  const [sortBy, setSortBy] = useState('rate');
  const [tierFilter, setTierFilter] = useState('all');
  const [search, setSearch] = useState('');

  const handleFetch = useCallback(async () => {
    setError('');
    setLoading(true);
    setProgress(0);
    setProgressTotal(0);
    setSessions(null);
    setVolunteers(null);

    try {
      setStatusMsg('Authenticating with Zoom…');
      const { token } = await getToken();

      setStatusMsg('Fetching user accounts…');
      const userIds = await getAllUserIds(token);

      const chunks = chunkDateRange(fromDate, toDate);
      setStatusMsg(`Scanning ${chunks.length} month window(s) across ${userIds.length} user(s)…`);

      const seenUuids = new Set();
      let allMeetings = [];
      for (const userId of userIds) {
        for (const chunk of chunks) {
          const meetings = await fetchMeetingsInRange(token, userId, chunk.from, chunk.to, setStatusMsg);
          for (const m of meetings) {
            const key = m.uuid || m.id;
            if (!seenUuids.has(key)) {
              seenUuids.add(key);
              allMeetings.push(m);
            }
          }
        }
      }

      if (topicFilter.trim()) {
        const lc = topicFilter.trim().toLowerCase();
        allMeetings = allMeetings.filter(m => m.topic?.toLowerCase().includes(lc));
      }

      if (allMeetings.length === 0) {
        setError('No meetings found. Try a wider date range or clear the topic filter.');
        setLoading(false);
        return;
      }

      setProgressTotal(allMeetings.length);
      setStatusMsg(`Fetching participants for ${allMeetings.length} sessions…`);

      const enriched = [];
      for (let i = 0; i < allMeetings.length; i++) {
        const m = allMeetings[i];
        setProgress(i + 1);
        setStatusMsg(`Session ${i + 1} of ${allMeetings.length}: "${m.topic}"…`);
        const participants = await fetchParticipants(token, m.uuid || m.id);
        enriched.push({
          meetingId: m.id,
          topic: m.topic || '(Untitled)',
          date: (m.start_time || '').slice(0, 10),
          duration: m.duration,
          participants,
        });
        if (i < allMeetings.length - 1) await sleep(DELAY_MS);
      }

      const vol = aggregate(enriched);

      // Merge historical CSV sessions if any were uploaded
      let allSessions = enriched;
      if (csvFiles.length > 0) {
        setStatusMsg('Parsing historical CSV files…');
        const historicalSessions = await parseHistoricalCSVs(csvFiles);
        // Deduplicate: if a session date+topic already exists from API, prefer API version
        const apiKeys = new Set(enriched.map(s => `${s.date}__${s.topic}`));
        const newHistorical = historicalSessions.filter(s => !apiKeys.has(`${s.date}__${s.topic}`));
        allSessions = [...enriched, ...newHistorical].sort((a, b) => b.date.localeCompare(a.date));
        setStatusMsg('');
      }

      const volFinal = aggregate(allSessions);
      setSessions(allSessions);
      setVolunteers(volFinal.sort((a, b) => b.attendanceRate - a.attendanceRate));
      setStatusMsg('');
    } catch (e) {
      setError(e.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, topicFilter, csvFiles]);

  const filteredVolunteers = useMemo(() => {
    if (!volunteers) return [];
    return volunteers
      .filter(v => tierFilter === 'all' || v.tier === tierFilter)
      .filter(v => !search ||
        v.name.toLowerCase().includes(search.toLowerCase()) ||
        (v.email || '').toLowerCase().includes(search.toLowerCase())
      )
      .sort((a, b) => {
        if (sortBy === 'rate') return b.attendanceRate - a.attendanceRate;
        if (sortBy === 'recent') return (b.lastSeen || '').localeCompare(a.lastSeen || '');
        if (sortBy === 'name') return a.name.localeCompare(b.name);
        return 0;
      });
  }, [volunteers, tierFilter, search, sortBy]);

  const stats = useMemo(() => {
    if (!sessions || !volunteers) return null;
    return {
      totalSessions: sessions.length,
      totalUnique: volunteers.length,
      avgRate: volunteers.reduce((s, v) => s + v.attendanceRate, 0) / volunteers.length,
      highCount: volunteers.filter(v => v.tier === 'high').length,
      atRisk: volunteers.filter(v => v.tier === 'low').length,
    };
  }, [sessions, volunteers]);

  const pct = progressTotal ? Math.round((progress / progressTotal) * 100) : null;

  // ── STYLES ──────────────────────────────────────────────────────────────────
  const inputStyle = {
    width: '100%',
    background: '#0a1520',
    border: '1px solid #1e3040',
    borderRadius: 8,
    padding: '10px 13px',
    color: '#c8dce8',
    fontSize: 13,
    transition: 'border-color 0.15s',
    colorScheme: 'dark',
  };

  const labelStyle = {
    fontSize: 11, color: '#8fa3b1', display: 'block',
    marginBottom: 6, letterSpacing: '0.05em', textTransform: 'uppercase',
  };

  return (
    <>
      <Head>
        <title>Volunteer Engagement Analyzer · Keep Altadena Together</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div style={{ minHeight: '100vh', background: '#0a1520', paddingBottom: 80 }}>

        {/* Header */}
        <div style={{
          borderBottom: '1px solid #1a2e3a', padding: '18px 40px',
          display: 'flex', alignItems: 'center', gap: 14,
          background: '#0d1e2b', position: 'sticky', top: 0, zIndex: 10,
        }}>
          <div style={{
            width: 34, height: 34, borderRadius: 8,
            background: 'linear-gradient(135deg, #00c2a8, #0077b6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
          }}>
            📡
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, color: '#e8f4f0' }}>
              Volunteer Engagement Analyzer
            </div>
            <div style={{ fontSize: 11, color: '#556677' }}>
              Keep Altadena Together · Zoom Reports
            </div>
          </div>
        </div>

        <div style={{ maxWidth: 1140, margin: '0 auto', padding: '32px 24px' }}>

          {/* Setup Panel */}
          <div style={{
            background: '#0d1e2b', border: '1px solid #1a2e3a',
            borderRadius: 16, padding: '28px 32px', marginBottom: 28,
          }}>
            <div style={{ fontSize: 11, color: '#556677', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 20 }}>
              Date Range & Filters
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr auto', gap: 16, alignItems: 'end' }}>
              <div>
                <label style={labelStyle}>From</label>
                <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
                  style={inputStyle}
                  onFocus={e => e.target.style.borderColor = '#00c2a8'}
                  onBlur={e => e.target.style.borderColor = '#1e3040'} />
              </div>
              <div>
                <label style={labelStyle}>To</label>
                <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
                  style={inputStyle}
                  onFocus={e => e.target.style.borderColor = '#00c2a8'}
                  onBlur={e => e.target.style.borderColor = '#1e3040'} />
              </div>
              <div>
                <label style={labelStyle}>Topic Filter <span style={{ color: '#2a3d4d' }}>(optional — filters by meeting name)</span></label>
                <input type="text" value={topicFilter} onChange={e => setTopicFilter(e.target.value)}
                  placeholder="e.g. Captain Sync, Zone Meeting…"
                  style={inputStyle}
                  onFocus={e => e.target.style.borderColor = '#00c2a8'}
                  onBlur={e => e.target.style.borderColor = '#1e3040'} />
              </div>
              <button
                onClick={handleFetch}
                disabled={loading}
                style={{
                  background: loading ? '#1a2e3a' : 'linear-gradient(135deg, #00c2a8, #0077b6)',
                  color: loading ? '#556677' : '#fff',
                  border: 'none', borderRadius: 8,
                  padding: '10px 28px', fontSize: 13, fontWeight: 600,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap', letterSpacing: '0.03em',
                  transition: 'opacity 0.2s',
                }}
              >
                {loading
                  ? <span style={{ animation: 'pulse 1.5s infinite', display: 'inline-block' }}>Fetching…</span>
                  : 'Pull Data →'}
              </button>
            </div>

            {/* Historical CSV Upload */}
            <div style={{ marginTop: 20, paddingTop: 20, borderTop: '1px solid #1a2e3a' }}>
              <div style={{ fontSize: 11, color: '#556677', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10 }}>
                Historical Data <span style={{ color: '#2a3d4d' }}>(optional — upload Zoom participant CSVs for dates before API range)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <label style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  background: '#0a1520', border: '1px dashed #1e3040',
                  borderRadius: 8, padding: '9px 16px', cursor: 'pointer',
                  fontSize: 12, color: '#8fa3b1', transition: 'border-color 0.15s',
                }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = '#00c2a8'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = '#1e3040'}
                >
                  <span style={{ fontSize: 16 }}>📂</span>
                  {csvFiles.length === 0 ? 'Upload participant CSVs…' : `${csvFiles.length} file${csvFiles.length !== 1 ? 's' : ''} selected`}
                  <input
                    type="file"
                    accept=".csv"
                    multiple
                    style={{ display: 'none' }}
                    onChange={e => setCsvFiles(Array.from(e.target.files))}
                  />
                </label>
                {csvFiles.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, color: '#556677' }}>
                      {csvFiles.map(f => f.name).join(', ').slice(0, 80)}{csvFiles.map(f => f.name).join(', ').length > 80 ? '…' : ''}
                    </div>
                    <button
                      onClick={() => setCsvFiles([])}
                      style={{ background: 'none', border: 'none', color: '#e05252', cursor: 'pointer', fontSize: 12 }}
                    >✕ Clear</button>
                  </>
                )}
              </div>
              {csvFiles.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#2a4d3a' }}>
                  ✓ These will be merged with live API data when you click Pull Data. Sessions already in the API range won't be duplicated.
                </div>
              )}
            </div>
            {loading && (
              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 12, color: '#556677', marginBottom: 7 }}>{statusMsg}</div>
                {pct !== null && (
                  <div style={{ background: '#0a1520', borderRadius: 4, height: 5, overflow: 'hidden' }}>
                    <div style={{
                      width: `${pct}%`, height: '100%',
                      background: 'linear-gradient(90deg, #00c2a8, #0077b6)',
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                )}
              </div>
            )}

            {error && (
              <div style={{
                marginTop: 16, padding: '12px 16px',
                background: '#1e0f0f', border: '1px solid #4a1f1f',
                borderRadius: 8, color: '#e05252', fontSize: 13,
              }}>
                ⚠ {error}
              </div>
            )}
          </div>

          {/* Results */}
          {stats && (
            <div style={{ animation: 'fadeIn 0.4s ease' }}>

              {/* Stats */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 24 }}>
                <StatCard label="Total Sessions" value={stats.totalSessions} accent="#0077b6" />
                <StatCard label="Unique Participants" value={stats.totalUnique} accent="#00c2a8" />
                <StatCard label="Avg Attendance Rate" value={`${(stats.avgRate * 100).toFixed(0)}%`} accent="#f0b429" />
                <StatCard label="Highly Engaged" value={stats.highCount} sub="≥75% attendance" accent="#00c2a8" />
                <StatCard label="At Risk" value={stats.atRisk} sub="<40% attendance" accent="#e05252" />
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', borderBottom: '1px solid #1a2e3a', marginBottom: 0 }}>
                {['sessions', 'volunteers'].map(t => (
                  <button key={t} onClick={() => setTab(t)} style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    borderBottom: tab === t ? '2px solid #00c2a8' : '2px solid transparent',
                    color: tab === t ? '#00c2a8' : '#556677',
                    padding: '10px 22px', fontSize: 13, fontWeight: 600,
                    textTransform: 'capitalize', letterSpacing: '0.05em',
                    marginBottom: -1, transition: 'color 0.15s',
                  }}>
                    {t === 'sessions'
                      ? `Sessions (${sessions.length})`
                      : `Volunteers (${volunteers.length})`}
                  </button>
                ))}
              </div>

              {/* Sessions Tab */}
              {tab === 'sessions' && (
                <div style={{
                  background: '#0d1e2b', border: '1px solid #1a2e3a',
                  borderTop: 'none', borderRadius: '0 0 12px 12px', overflow: 'hidden',
                }}>
                  {sessions.map((s, i) => <SessionRow key={s.meetingId + i} session={s} index={i} />)}
                </div>
              )}

              {/* Volunteers Tab */}
              {tab === 'volunteers' && (
                <div style={{
                  background: '#0d1e2b', border: '1px solid #1a2e3a',
                  borderTop: 'none', borderRadius: '0 0 12px 12px', overflow: 'hidden',
                }}>
                  {/* Controls */}
                  <div style={{
                    display: 'flex', gap: 10, padding: '14px 20px',
                    borderBottom: '1px solid #1a2e3a', alignItems: 'center', flexWrap: 'wrap',
                  }}>
                    <input
                      placeholder="Search name or email…"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      style={{
                        background: '#0a1520', border: '1px solid #1e3040',
                        borderRadius: 6, padding: '7px 12px', color: '#c8dce8',
                        fontSize: 12, width: 220,
                      }}
                    />
                    {[
                      { val: 'all', label: 'All tiers' },
                      { val: 'high', label: 'Active' },
                      { val: 'mid', label: 'Sporadic' },
                      { val: 'low', label: 'At Risk' },
                    ].map(({ val, label }) => (
                      <button key={val} onClick={() => setTierFilter(val)} style={{
                        background: tierFilter === val ? '#1a3a2a' : '#0a1520',
                        border: `1px solid ${tierFilter === val ? '#00c2a8' : '#1e3040'}`,
                        color: tierFilter === val ? '#00c2a8' : '#556677',
                        borderRadius: 6, padding: '6px 12px', fontSize: 12,
                        cursor: 'pointer', transition: 'all 0.15s',
                      }}>
                        {label}
                      </button>
                    ))}
                    <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{
                      background: '#0a1520', border: '1px solid #1e3040',
                      borderRadius: 6, padding: '7px 12px', color: '#c8dce8',
                      fontSize: 12, cursor: 'pointer',
                    }}>
                      <option value="rate">Sort: Attendance Rate</option>
                      <option value="recent">Sort: Most Recent</option>
                      <option value="name">Sort: Name A–Z</option>
                    </select>
                    <button
                      onClick={() => exportCSV(filteredVolunteers, sessions)}
                      style={{
                        marginLeft: 'auto', background: '#0a1520',
                        border: '1px solid #1e3040', borderRadius: 6,
                        padding: '7px 14px', color: '#00c2a8',
                        fontSize: 12, cursor: 'pointer', fontWeight: 600,
                      }}
                    >
                      ↓ Export CSV
                    </button>
                  </div>

                  {/* Table Header */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 1.8fr 90px 90px 90px 100px 80px',
                    padding: '8px 20px', fontSize: 10, color: '#2a3d4d',
                    textTransform: 'uppercase', letterSpacing: '0.08em',
                    borderBottom: '1px solid #1a2e3a',
                  }}>
                    <div>Name</div>
                    <div>Email</div>
                    <div style={{ textAlign: 'right' }}>Attended</div>
                    <div style={{ textAlign: 'right' }}>Rate</div>
                    <div style={{ textAlign: 'right' }}>Avg (min)</div>
                    <div style={{ textAlign: 'right' }}>Last Seen</div>
                    <div style={{ textAlign: 'center' }}>Status</div>
                  </div>

                  {/* Rows */}
                  {filteredVolunteers.map((v, i) => (
                    <div key={v.email || v.name + i} style={{
                      display: 'grid',
                      gridTemplateColumns: '2fr 1.8fr 90px 90px 90px 100px 80px',
                      padding: '10px 20px', borderBottom: '1px solid #0d1822',
                      fontSize: 13, transition: 'background 0.1s',
                      animation: `fadeIn 0.2s ease ${i * 0.015}s both`,
                    }}
                      onMouseEnter={e => e.currentTarget.style.background = '#111c24'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <div style={{ color: '#c8dce8', fontWeight: 500 }}>{v.name}</div>
                      <div style={{ color: '#3a5060', fontSize: 12 }}>
                        {v.email || <em style={{ color: '#1e2e3a' }}>no email</em>}
                      </div>
                      <div style={{ textAlign: 'right', color: '#556677', fontFamily: "'DM Mono', monospace" }}>
                        {v.sessionsAttended}/{sessions.length}
                      </div>
                      <div style={{
                        textAlign: 'right', fontFamily: "'DM Mono', monospace", fontWeight: 600,
                        color: v.tier === 'high' ? '#00c2a8' : v.tier === 'mid' ? '#f0b429' : '#e05252',
                      }}>
                        {(v.attendanceRate * 100).toFixed(0)}%
                      </div>
                      <div style={{ textAlign: 'right', color: '#556677', fontSize: 12, fontFamily: "'DM Mono', monospace" }}>
                        {v.avgDurationMin}m
                      </div>
                      <div style={{ textAlign: 'right', color: '#556677', fontSize: 12, fontFamily: "'DM Mono', monospace" }}>
                        {v.lastSeen}
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <Badge tier={v.tier} />
                      </div>
                    </div>
                  ))}

                  {filteredVolunteers.length === 0 && (
                    <div style={{ padding: 40, textAlign: 'center', color: '#2a3d4d', fontSize: 13 }}>
                      No volunteers match this filter.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}