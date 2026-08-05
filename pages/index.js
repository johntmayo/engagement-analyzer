import { useState, useCallback, useMemo, useEffect } from 'react';
import Head from 'next/head';
import {
  getToken, getAllUsers, chunkDateRange,
  fetchMeetingsInRange, fetchParticipants,
  aggregate, exportCSV, parseHistoricalCSVs, sleep, DELAY_MS,
  saveLibrary, loadLibrary, clearLibrary, mergeSessions, storeZoomSessions,
} from '../lib/zoom';

const MEETING_CLASSIFICATIONS = [
  ['unclassified', 'Unclassified'],
  ['captain', 'Captain meeting'],
  ['working_group', 'Working group (optional)'],
  ['captain_support', 'Captain support / coaching'],
  ['onboarding', 'Onboarding'],
  ['community', 'Community / neighborhood'],
  ['internal', 'Internal / staff'],
  ['test_exclude', 'Test or exclude'],
];

// ─── SMALL COMPONENTS ─────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent = '#00c2a8' }) {
  return (
    <div style={{
      background: '#111c24', border: '1px solid #1e2f3d',
      borderRadius: 12, padding: '20px 24px', borderTop: `3px solid ${accent}`,
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
    high: { bg: '#00c2a822', color: '#00c2a8', label: 'Frequent' },
    mid:  { bg: '#f0b42922', color: '#f0b429', label: 'Occasional' },
    low:  { bg: '#e0525222', color: '#e05252', label: 'Infrequent' },
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
  const srcBadge = session.source === 'csv'
    ? <span style={{ fontSize: 9, color: '#2a4d3a', border: '1px solid #1a3d2a', borderRadius: 3, padding: '1px 5px', marginLeft: 6 }}>CSV</span>
    : null;
  return (
    <div style={{ borderBottom: '1px solid #1a2630', animation: `fadeIn 0.3s ease ${index * 0.02}s both` }}>
      <div
        onClick={() => setOpen(!open)}
        style={{ display: 'flex', alignItems: 'center', padding: '12px 20px', cursor: 'pointer', gap: 14, transition: 'background 0.15s' }}
        onMouseEnter={e => e.currentTarget.style.background = '#111c24'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        <div style={{ width: 96, fontSize: 12, color: '#556677', fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>
          {session.date}
        </div>
        <div style={{ flex: 1, fontSize: 14, color: '#c8dce8' }}>
          {session.topic}{srcBadge}
        </div>
        <div style={{ fontSize: 12, color: '#556677', fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>
          {session.duration}m
        </div>
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

const RISK_LABELS = {
  at_risk: 'At risk',
  needs_attention: 'Needs attention',
  recently_active: 'Recently active',
};

const TREND_LABELS = {
  increasing: '↑ Increasing',
  steady: '→ Steady',
  decreasing: '↓ Decreasing',
  no_recent_activity: '— No recent activity',
};

function formatActivityDate(value) {
  if (!value) return 'No observed activity';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function relativeActivityDate(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return 'Not observed';
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86400000));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 56) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 730) {
    const months = Math.max(1, Math.round(days / 30));
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function KeyEngagementMarkers({ captain }) {
  const markers = [
    {
      key: 'dashboard',
      source: 'Dashboard',
      label: 'Last dashboard login',
      value: captain.dashboard?.lastSeenAt,
      detail: captain.dashboard?.loginEmail
        ? `Login: ${captain.dashboard.loginEmail}`
        : 'No matched Dashboard account activity',
    },
    {
      key: 'zoom',
      source: 'Zoom',
      label: 'Last meeting attended',
      value: captain.zoom?.lastSeen,
      detail: captain.zoom?.lastSeen
        ? 'Most recent matched Zoom attendance'
        : 'No matched meeting attendance',
    },
    {
      key: 'gmail',
      source: 'Gmail',
      label: 'Last email sent to us',
      value: captain.mailbox?.lastInboundAt,
      detail: captain.mailbox?.lastInboundAt
        ? `From ${captain.mailbox.lastInboundSender} to ${captain.mailbox.lastInboundMailbox}`
        : 'No matched inbound email',
    },
    {
      key: 'airtable',
      source: 'Airtable',
      label: 'Last organizer interaction',
      value: captain.last_organizer_recorded_interaction,
      detail: captain.last_organizer_recorded_interaction
        ? 'Organizer-maintained interaction date'
        : 'No organizer interaction recorded',
    },
  ];

  return (
    <section className="key-engagement-markers">
      <header>
        <div>
          <span>Key engagement markers</span>
          <h3>Most recent contact and participation</h3>
        </div>
        <p>Missing activity in one channel is not a negative signal.</p>
      </header>
      <div className="marker-grid">
        {markers.map((marker) => (
          <article
            className={`engagement-marker ${marker.key}${marker.value ? '' : ' empty'}`}
            key={marker.key}
          >
            <div className="marker-source">
              <i />
              {marker.source}
            </div>
            <h4>{marker.label}</h4>
            <strong>{relativeActivityDate(marker.value)}</strong>
            <time dateTime={marker.value || undefined}>
              {marker.value ? formatActivityDate(marker.value) : 'No activity observed'}
            </time>
            <small>{marker.detail}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function scoreWeekSlots(engagement) {
  const byWeek = new Map(
    (engagement?.weeks || []).map((week) => [week.weekStart, week])
  );
  const now = new Date();
  const day = now.getUTCDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  now.setUTCHours(0, 0, 0, 0);
  now.setUTCDate(now.getUTCDate() - daysSinceMonday);
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - (11 - index) * 7);
    const key = date.toISOString().slice(0, 10);
    return byWeek.get(key) || {
      weekStart: key,
      points: 0,
      eventCount: 0,
      sources: [],
    };
  });
}

function EngagementScorePanel({ engagement }) {
  if (!engagement) return null;
  const slots = scoreWeekSlots(engagement);
  return (
    <section className="engagement-score-panel">
      <div className="score-panel-heading">
        <div>
          <span className="score-kicker">Rolling 12-week signal</span>
          <div className="score-number-line">
            <strong>{engagement.points}</strong>
            <span>engagement points</span>
          </div>
          <p>
            {engagement.activeWeeks} active week{engagement.activeWeeks === 1 ? '' : 's'}
            {engagement.leadershipWeeks
              ? ` · ${engagement.leadershipWeeks} leadership week${engagement.leadershipWeeks === 1 ? '' : 's'}`
              : ''}
          </p>
        </div>
        <div className="score-status-stack">
          <span className={`engagement-risk ${engagement.risk}`}>
            {RISK_LABELS[engagement.risk] || engagement.risk}
          </span>
          <span className={`engagement-trend ${engagement.trend.direction}`}>
            {TREND_LABELS[engagement.trend.direction] || engagement.trend.direction}
          </span>
        </div>
      </div>

      <div className="score-week-strip" aria-label="Activity during the last 12 weeks">
        {slots.map((week, index) => (
          <div
            className={`score-week points-${week.points}`}
            key={week.weekStart}
            title={`${formatActivityDate(week.weekStart)}: ${week.points} point${week.points === 1 ? '' : 's'}, ${week.eventCount} event${week.eventCount === 1 ? '' : 's'}`}
          >
            <span>{index === 11 ? 'Now' : index === 0 ? '12w' : ''}</span>
            <i />
          </div>
        ))}
      </div>

      <details className="score-ledger">
        <summary>Why {engagement.points} point{engagement.points === 1 ? '' : 's'}?</summary>
        {engagement.weeks.length ? engagement.weeks.map((week) => (
          <article className="score-ledger-week" key={week.weekStart}>
            <header>
              <div>
                <strong>Week of {formatActivityDate(week.weekStart)}</strong>
                <span>{week.sources.join(' + ')}</span>
              </div>
              <b>{week.points} pt{week.points === 1 ? '' : 's'}</b>
            </header>
            <div className="score-event-list">
              {week.events.map((event, index) => (
                <div className="score-event" key={`${event.occurredAt}-${event.kind}-${index}`}>
                  <span className={`score-source ${event.source}`}>{event.source}</span>
                  <div>
                    <strong>{event.label}</strong>
                    {event.detail && <span>{event.detail}</span>}
                    <small>{event.reason}</small>
                  </div>
                </div>
              ))}
              {week.hiddenEventCount > 0 && (
                <small className="score-hidden-events">
                  +{week.hiddenEventCount} more event{week.hiddenEventCount === 1 ? '' : 's'} that week
                </small>
              )}
            </div>
          </article>
        )) : (
          <p className="score-empty">No verified activity in the current 12-week window.</p>
        )}
      </details>
    </section>
  );
}

function CaptainDirectory() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncingDashboard, setSyncingDashboard] = useState(false);
  const [syncingGmail, setSyncingGmail] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [zone, setZone] = useState('all');
  const [riskFilter, setRiskFilter] = useState('all');
  const [sortBy, setSortBy] = useState('risk');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  const loadRoster = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/captains');
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Captain roster could not be loaded.');
      setData(body);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRoster();
  }, [loadRoster]);

  useEffect(() => {
    const refresh = () => loadRoster();
    window.addEventListener('engagement-data-updated', refresh);
    return () => window.removeEventListener('engagement-data-updated', refresh);
  }, [loadRoster]);

  const syncRoster = async () => {
    setSyncing(true);
    setError('');
    try {
      const response = await fetch('/api/sync-airtable', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Airtable sync failed.');
      await loadRoster();
      window.dispatchEvent(new Event('engagement-data-updated'));
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  };

  const syncDashboard = async () => {
    setSyncingDashboard(true);
    setError('');
    try {
      const response = await fetch('/api/sync-dashboard-access', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Dashboard access sync failed.');
      await loadRoster();
      window.dispatchEvent(new Event('engagement-data-updated'));
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncingDashboard(false);
    }
  };

  const syncGmail = async () => {
    setSyncingGmail(true);
    setError('');
    try {
      const response = await fetch('/api/sync-gmail', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Gmail sync failed.');
      await loadRoster();
      window.dispatchEvent(new Event('engagement-data-updated'));
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncingGmail(false);
    }
  };

  const issuesByCaptain = useMemo(() => {
    const index = new Map();
    for (const issue of data?.issues || []) {
      for (const id of [issue.captain_record_id, issue.related_record_id].filter(Boolean)) {
        const current = index.get(id) || [];
        current.push(issue);
        index.set(id, current);
      }
    }
    return index;
  }, [data]);

  const zones = useMemo(() => {
    const values = new Set();
    for (const captain of data?.captains || []) {
      String(captain.zones || '').split('|').map(z => z.trim()).filter(Boolean)
        .forEach(z => values.add(z));
    }
    return [...values].sort();
  }, [data]);

  const filteredCaptains = useMemo(() => {
    const term = search.trim().toLowerCase();
    const riskOrder = { at_risk: 0, needs_attention: 1, recently_active: 2 };
    return (data?.captains || []).filter(captain => {
      const matchesSearch = !term || [
        captain.full_name,
        captain.email,
        captain.dashboard_gmail,
        captain.phone,
        captain.address,
        captain.zones,
      ].some(value => String(value || '').toLowerCase().includes(term));
      const matchesZone = zone === 'all' || String(captain.zones || '')
        .split('|').map(value => value.trim()).includes(zone);
      const matchesRisk = riskFilter === 'all'
        || captain.engagement?.risk === riskFilter;
      const matchesReview = !reviewOnly || issuesByCaptain.has(captain.airtable_record_id);
      return matchesSearch && matchesZone && matchesRisk && matchesReview;
    }).sort((a, b) => {
      if (sortBy === 'points') {
        return (b.engagement?.points || 0) - (a.engagement?.points || 0)
          || String(a.full_name).localeCompare(String(b.full_name));
      }
      if (sortBy === 'trend') {
        const trendOrder = {
          decreasing: 0,
          no_recent_activity: 1,
          steady: 2,
          increasing: 3,
        };
        return (trendOrder[a.engagement?.trend?.direction] ?? 4)
          - (trendOrder[b.engagement?.trend?.direction] ?? 4)
          || String(a.full_name).localeCompare(String(b.full_name));
      }
      if (sortBy === 'name') {
        return String(a.full_name).localeCompare(String(b.full_name));
      }
      return (riskOrder[a.engagement?.risk] ?? 3)
        - (riskOrder[b.engagement?.risk] ?? 3)
        || (a.engagement?.points || 0) - (b.engagement?.points || 0)
        || String(a.full_name).localeCompare(String(b.full_name));
    });
  }, [
    data,
    issuesByCaptain,
    reviewOnly,
    riskFilter,
    search,
    sortBy,
    zone,
  ]);

  const latestSync = data?.latestSync?.synced_at
    ? new Date(data.latestSync.synced_at).toLocaleString()
    : 'Not synchronized';

  if (loading && !data) {
    return (
      <div className="captain-loading">
        <div className="captain-loading-line" />
        Reading the captain roster from Google Sheets…
      </div>
    );
  }

  return (
    <section className="captain-directory">
      <div className="captain-directory-heading">
        <div>
          <div className="section-kicker">Canonical roster</div>
          <h2>Neighborhood Captains</h2>
          <p>
            Airtable roster plus transparent Zoom, Zone Dashboard, and mailbox signals.
            Identity merges stay manual.
          </p>
        </div>
        <div className="roster-sync">
          <span>Airtable {latestSync}</span>
          {data?.latestZoomSync && (
            <span>
              Zoom: {data.summary.zoomSessions} sessions · {data.summary.zoomReviews} identity reviews
            </span>
          )}
          {data?.latestDashboardSync && (
            <span>
              Dashboard: {data.summary.dashboardMatched || 0} matched · {data.summary.dashboardReviews || 0} reviews
            </span>
          )}
          {data?.latestGmailSync && (
            <span>
              Gmail: {data.summary.emailMatched || 0} matched events
            </span>
          )}
          <button
            onClick={syncRoster}
            disabled={syncing || syncingDashboard || syncingGmail}
          >
            {syncing ? 'Synchronizing…' : 'Sync Airtable'}
          </button>
          <button
            onClick={syncDashboard}
            disabled={syncing || syncingDashboard || syncingGmail}
          >
            {syncingDashboard ? 'Syncing dashboard…' : 'Sync Dashboard Access'}
          </button>
          <button
            onClick={syncGmail}
            disabled={syncing || syncingDashboard || syncingGmail}
          >
            {syncingGmail ? 'Syncing Gmail…' : 'Sync Gmail'}
          </button>
        </div>
      </div>

      {error && <div className="captain-error">{error}</div>}

      {data && (
        <>
          <div className="roster-stats">
            <StatCard label="Current Captains" value={data.summary.captains} accent="#00c2a8" />
            <StatCard
              label="At Risk"
              value={data.summary.atRisk || 0}
              sub="No active weeks in the last 8"
              accent="#e05252"
            />
            <StatCard
              label="Needs Attention"
              value={data.summary.needsAttention || 0}
              sub="One active week in the last 8"
              accent="#f0b429"
            />
            <StatCard
              label="Recently Active"
              value={data.summary.recentlyActive || 0}
              sub="Two or more active weeks"
              accent="#00c2a8"
            />
            <StatCard
              label="Trending Down"
              value={data.summary.trendingDown || 0}
              sub="Latest 4 weeks vs prior 4"
              accent="#d17856"
            />
            <StatCard
              label="Average Points"
              value={(data.summary.engagementPoints / Math.max(data.summary.captains, 1)).toFixed(1)}
              sub="Rolling 12-week window"
              accent="#4d8cc9"
            />
          </div>

          <div className="captain-roster-shell">
            <div className="captain-controls">
              <input
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search names, emails, phones, or addresses"
              />
              <select value={zone} onChange={event => setZone(event.target.value)}>
                <option value="all">Every zone</option>
                {zones.map(value => <option key={value} value={value}>{value}</option>)}
              </select>
              <select
                value={riskFilter}
                onChange={event => setRiskFilter(event.target.value)}
              >
                <option value="all">Every engagement status</option>
                <option value="at_risk">At risk</option>
                <option value="needs_attention">Needs attention</option>
                <option value="recently_active">Recently active</option>
              </select>
              <select value={sortBy} onChange={event => setSortBy(event.target.value)}>
                <option value="risk">Sort: highest risk</option>
                <option value="points">Sort: most points</option>
                <option value="trend">Sort: declining first</option>
                <option value="name">Sort: name</option>
              </select>
              <button
                className={reviewOnly ? 'review-toggle active' : 'review-toggle'}
                onClick={() => setReviewOnly(value => !value)}
              >
                Needs review
                <span>{data.summary.missingResidentIds + data.summary.reviewFlags}</span>
              </button>
              <div className="captain-result-count">
                {filteredCaptains.length} of {data.summary.captains}
              </div>
            </div>

            <div className="captain-table-header">
              <span>Captain</span>
              <span>Zone</span>
              <span>Points</span>
              <span>Status</span>
              <span>Trend</span>
              <span>Last activity</span>
              <span>Data health</span>
            </div>

            {filteredCaptains.map((captain, index) => {
              const captainIssues = issuesByCaptain.get(captain.airtable_record_id) || [];
              const expanded = expandedId === captain.airtable_record_id;
              return (
                <div
                  className={expanded ? 'captain-record expanded' : 'captain-record'}
                  key={captain.airtable_record_id}
                  style={{ animationDelay: `${Math.min(index, 20) * 0.018}s` }}
                >
                  <button
                    className="captain-record-summary"
                    onClick={() => setExpandedId(expanded ? null : captain.airtable_record_id)}
                    aria-expanded={expanded}
                  >
                    <span className="captain-name-cell">
                      <strong>{captain.full_name || 'Unnamed captain'}</strong>
                      <small>{captain.email || captain.dashboard_gmail || 'No email recorded'}</small>
                    </span>
                    <span>{captain.zones || 'Unassigned'}</span>
                    <span className="score-cell">
                      <strong>{captain.engagement?.points || 0}</strong>
                      <small>{captain.engagement?.activeWeeks || 0} active weeks</small>
                    </span>
                    <span>
                      <span className={`engagement-risk ${captain.engagement?.risk || 'at_risk'}`}>
                        {RISK_LABELS[captain.engagement?.risk] || 'At risk'}
                      </span>
                    </span>
                    <span className={`engagement-trend ${captain.engagement?.trend?.direction || 'no_recent_activity'}`}>
                      {TREND_LABELS[captain.engagement?.trend?.direction] || '— No recent activity'}
                    </span>
                    <span className="mono-cell">
                      {formatActivityDate(captain.engagement?.lastActivityAt)}
                    </span>
                    <span>
                      {captainIssues.length
                        ? <span className="review-badge">{captainIssues.length} to review</span>
                        : <span className="clean-badge">Complete</span>}
                    </span>
                  </button>

                  {expanded && (
                    <div className="captain-record-detail">
                      <KeyEngagementMarkers captain={captain} />
                      <EngagementScorePanel engagement={captain.engagement} />
                      <div className="captain-facts">
                        <h4 className="supporting-details-title">
                          Supporting details
                          <small>Identity, logistics, and secondary activity context</small>
                        </h4>
                        {[
                          ['Resident ID', captain.resident_id || 'Missing'],
                          ['Address', captain.address || 'Not recorded'],
                          ['Phone', captain.phone || 'Not recorded'],
                          ['Dashboard Gmail', captain.dashboard_gmail || 'Not recorded'],
                          ['Additional emails', captain.additional_email_addresses || 'None'],
                          ['Date trained', captain.date_trained || 'Not recorded'],
                          ['Captain meetings attended', captain.zoom?.captainMeetingsAttended || 'None yet'],
                          [
                            'Eligible captain-meeting attendance',
                            captain.zoom?.captainMeetingAttendanceRate == null
                              ? 'No eligible sessions'
                              : `${captain.zoom.eligibleCaptainMeetingsAttended}/${captain.zoom.eligibleCaptainMeetings} (${Math.round(captain.zoom.captainMeetingAttendanceRate * 100)}%)`,
                          ],
                          ['Working-group participation', captain.zoom?.workingGroupParticipations || 'None yet'],
                          ['Captain-support interactions', captain.zoom?.captainSupportInteractions || 'None yet'],
                          ['Onboarding milestone', captain.zoom?.onboardingMilestone || 'Not observed'],
                          ['Community meetings hosted', captain.zoom?.communitySessionsHosted || 'None yet'],
                          ['Other meetings hosted', captain.zoom?.otherSessionsHosted || 'None yet'],
                          ['Last meeting hosted', captain.zoom?.lastHosted || 'Not observed'],
                          ['Mailbox interactions', captain.mailbox
                            ? `${captain.mailbox.total} (${captain.mailbox.inbound} in / ${captain.mailbox.outbound} out)`
                            : 'Not observed'],
                          ['Last updated by', captain.last_updated_by || 'Not recorded'],
                          ['Shirt status', captain.shirt_status || 'Not recorded'],
                          ['Special opportunity', captain.special_opportunity || 'None'],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <label>{label}</label>
                            <span>{value}</span>
                          </div>
                        ))}
                      </div>

                      {captain.signals?.length > 0 && (
                        <details className="signal-evidence">
                          <summary>Why these signals appear</summary>
                          {captain.signals.map(signal => (
                            <div key={signal.key}>
                              <strong>{signal.label}: {signal.value}</strong>
                              <span>{signal.reason}</span>
                              <small>Source: {signal.source}</small>
                            </div>
                          ))}
                        </details>
                      )}

                      {(captain.notes_bio || captainIssues.length > 0) && (
                        <div className="captain-context">
                          {captain.notes_bio && (
                            <div>
                              <label>Organizer notes / bio</label>
                              <p>{captain.notes_bio}</p>
                            </div>
                          )}
                          {captainIssues.length > 0 && (
                            <div>
                              <label>Needs review</label>
                              <ul>
                                {captainIssues.map(issue => (
                                  <li key={issue.issue_key}>
                                    <strong>{issue.confidence} confidence</strong>
                                    {issue.message}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {filteredCaptains.length === 0 && (
              <div className="captain-empty">No captain records match these filters.</div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function IdentityReviewRow({ item, captains, busy, onDecision }) {
  const [captainId, setCaptainId] = useState(
    item.suggestions?.[0]?.captainRecordId || ''
  );

  return (
    <article className="identity-review-row">
      <div className="identity-review-main">
        <div className="identity-review-title">
          <strong>{item.displayName}</strong>
          {item.email && <span>{item.email}</span>}
        </div>
        <div className="identity-review-meta">
          <span>{item.appearances} appearance{item.appearances !== 1 ? 's' : ''}</span>
          <span>{item.sessions} session{item.sessions !== 1 ? 's' : ''}</span>
          <span>{item.firstSeen}{item.lastSeen !== item.firstSeen ? ` – ${item.lastSeen}` : ''}</span>
        </div>
        <div className="identity-review-topics">
          {item.topics.map(topic => <span key={topic}>{topic}</span>)}
        </div>
        <div className="identity-review-reason">{item.reasons.join(' · ')}</div>
        {item.suggestions?.length > 0 && (
          <div className="identity-suggestions">
            Suggested: {item.suggestions.map(suggestion =>
              `${suggestion.name} (${suggestion.score}% name match)`
            ).join(' · ')}
          </div>
        )}
      </div>
      <div className="identity-review-actions">
        <label>Link to a captain</label>
        <select value={captainId} onChange={event => setCaptainId(event.target.value)}>
          <option value="">Choose a captain…</option>
          {captains.map(captain => (
            <option key={captain.airtableRecordId} value={captain.airtableRecordId}>
              {captain.name}{captain.zone ? ` · ${captain.zone}` : ''}
            </option>
          ))}
        </select>
        <button
          className="primary-review-action"
          disabled={busy || !captainId}
          onClick={() => onDecision(item, 'linked', captainId)}
        >
          Link identity
        </button>
        <div className="secondary-review-actions">
          <button disabled={busy} onClick={() => onDecision(item, 'non_captain')}>
            Not a captain
          </button>
          <button disabled={busy} onClick={() => onDecision(item, 'ignored')}>
            Ignore
          </button>
          <button disabled={busy} onClick={() => onDecision(item, 'needs_research')}>
            Research later
          </button>
        </div>
      </div>
    </article>
  );
}

function SessionOverrideRow({ session, captains, busy, onSave }) {
  const [classification, setClassification] = useState(session.classification);
  const [expectedZone, setExpectedZone] = useState(session.expectedZone || '');
  const [hostCaptainId, setHostCaptainId] = useState(
    session.hostCaptainRecordId || ''
  );
  useEffect(() => {
    setClassification(session.classification);
    setExpectedZone(session.expectedZone || '');
    setHostCaptainId(session.hostCaptainRecordId || '');
  }, [session]);

  return (
    <div className="session-override-row">
      <div className="session-override-summary">
        <strong>{session.date || 'Undated session'}</strong>
        <span>{session.durationMinutes} min</span>
        <span>{session.attendanceRecords} attendance records</span>
        <span className={`meeting-type ${session.classification}`}>
          {session.classification.replaceAll('_', ' ')}
        </span>
        <small>
          {session.classificationSource === 'session_override'
            ? 'Session override'
            : 'Inherits series default'}
        </small>
      </div>
      <div className="session-override-actions">
        <select
          value={classification}
          onChange={event => setClassification(event.target.value)}
        >
          {MEETING_CLASSIFICATIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <input
          value={expectedZone}
          onChange={event => setExpectedZone(event.target.value)}
          placeholder="Zone override (optional)"
        />
        <select
          value={hostCaptainId}
          onChange={event => setHostCaptainId(event.target.value)}
        >
          <option value="">Inherit series host / use Zoom identity</option>
          {captains.map(captain => (
            <option key={captain.airtableRecordId} value={captain.airtableRecordId}>
              Hosted by {captain.name}{captain.zone ? ` · ${captain.zone}` : ''}
            </option>
          ))}
        </select>
        <button
          disabled={busy}
          onClick={() => onSave(
            session,
            classification,
            expectedZone,
            hostCaptainId
          )}
        >
          {busy ? 'Saving…' : 'Save session override'}
        </button>
      </div>
    </div>
  );
}

function MeetingReviewRow({
  meeting,
  captains,
  busy,
  busyKey,
  onSave,
  onSaveOverride,
}) {
  const [classification, setClassification] = useState(meeting.classification);
  const [expectedZone, setExpectedZone] = useState(meeting.expectedZone || '');
  const [hostCaptainId, setHostCaptainId] = useState(
    meeting.hostCaptainRecordId || ''
  );
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setClassification(meeting.classification);
    setExpectedZone(meeting.expectedZone || '');
    setHostCaptainId(meeting.hostCaptainRecordId || '');
  }, [meeting]);
  const changed = classification !== meeting.classification
    || expectedZone !== (meeting.expectedZone || '')
    || hostCaptainId !== (meeting.hostCaptainRecordId || '');

  return (
    <article className="meeting-review-row">
      <div className="meeting-review-main">
        <div className="meeting-review-title">
          <strong>{meeting.topic}</strong>
          <span className={`meeting-type ${meeting.classification}`}>
            {meeting.classification.replaceAll('_', ' ')}
          </span>
          {meeting.mixedClassifications && (
            <span className="mixed-classification">Mixed sessions</span>
          )}
        </div>
        <div className="meeting-review-meta">
          <span>{meeting.sessions} session{meeting.sessions !== 1 ? 's' : ''}</span>
          <span>{meeting.attendanceRecords} attendance records</span>
          <span>{meeting.matchedCaptains} matched captains</span>
          <span>{meeting.unmatched} unresolved</span>
        </div>
        {(meeting.hostNames.length > 0 || meeting.hostCaptains.length > 0) && (
          <div className="meeting-host-line">
            Host observed: {meeting.hostCaptains.length
              ? meeting.hostCaptains.join(', ')
              : meeting.hostNames.join(', ')}
            {meeting.hostCaptains.length > 0 && (
              <strong> · captain hosting credit available</strong>
            )}
          </div>
        )}
      </div>
      <div className="meeting-review-actions">
        <select
          value={classification}
          onChange={event => setClassification(event.target.value)}
        >
          {MEETING_CLASSIFICATIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <input
          value={expectedZone}
          onChange={event => setExpectedZone(event.target.value)}
          placeholder="Zone (optional)"
        />
        <select
          className="host-captain-select"
          value={hostCaptainId}
          onChange={event => setHostCaptainId(event.target.value)}
        >
          <option value="">Host captain unknown / shared account</option>
          {captains.map(captain => (
            <option key={captain.airtableRecordId} value={captain.airtableRecordId}>
              Hosted by {captain.name}{captain.zone ? ` · ${captain.zone}` : ''}
            </option>
          ))}
        </select>
        <button
          disabled={busy || !changed}
          onClick={() => onSave(
            meeting,
            classification,
            expectedZone,
            hostCaptainId
          )}
        >
          {busy ? 'Saving…' : 'Save classification'}
        </button>
        <button
          className="expand-sessions-button"
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? 'Hide dated sessions' : `Review ${meeting.sessions} dated sessions`}
        </button>
      </div>
      {expanded && (
        <div className="session-override-list">
          <div className="session-override-explainer">
            Session settings override the series default. Use this for personal rooms
            or any series whose purpose changes by date.
          </div>
          {meeting.sessionItems.map(session => (
            <SessionOverrideRow
              key={session.sessionId}
              session={session}
              captains={captains}
              busy={busyKey === `session:${session.sessionId}`}
              onSave={onSaveOverride}
            />
          ))}
        </div>
      )}
    </article>
  );
}

function ReviewWorkspace() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('identities');
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');
  const [pendingRematchCount, setPendingRematchCount] = useState(0);

  const loadReviewData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/review-data');
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Review data could not be loaded.');
      setData(body);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadReviewData();
  }, [loadReviewData]);

  const saveDecision = async (payload, key, { onSaved } = {}) => {
    setBusyKey(key);
    setError('');
    try {
      const response = await fetch('/api/review-decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Decision could not be saved.');
      if (typeof onSaved === 'function') onSaved(body);
      if (body.rematchPending) {
        setPendingRematchCount(count => count + 1);
      } else {
        await loadReviewData();
        window.dispatchEvent(new Event('engagement-data-updated'));
      }
      return body;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusyKey('');
    }
  };

  const decideIdentity = (item, status, captainRecordId = '') => saveDecision({
    decisionType: 'identity',
    identityType: item.identityType,
    identityValue: item.identityValue,
    status,
    captainRecordId,
  }, item.key, {
    onSaved: () => {
      setData(current => {
        if (!current) return current;
        const identities = current.identities.filter(entry => entry.key !== item.key);
        return {
          ...current,
          identities,
          summary: {
            ...current.summary,
            identitiesToReview: identities.length,
          },
        };
      });
    },
  });

  const saveMeeting = (
    meeting,
    classification,
    expectedZone,
    hostCaptainRecordId
  ) => saveDecision({
    decisionType: 'session',
    topic: meeting.topic,
    classification,
    expectedZone,
    hostCaptainRecordId,
  }, meeting.topicKey, {
    onSaved: () => {
      setData(current => {
        if (!current) return current;
        return {
          ...current,
          meetings: current.meetings.map(entry => (
            entry.topicKey === meeting.topicKey
              ? {
                ...entry,
                classification,
                expectedZone,
                hostCaptainRecordId,
              }
              : entry
          )),
          summary: {
            ...current.summary,
            unclassifiedMeetings: current.meetings.filter(entry => {
              const next = entry.topicKey === meeting.topicKey
                ? classification
                : entry.classification;
              return next === 'unclassified';
            }).length,
          },
        };
      });
    },
  });

  const saveSessionOverride = (
    session,
    classification,
    expectedZone,
    hostCaptainRecordId
  ) => saveDecision({
    decisionType: 'session_override',
    sessionId: session.sessionId,
    classification,
    expectedZone,
    hostCaptainRecordId,
  }, `session:${session.sessionId}`, {
    onSaved: () => {
      setData(current => {
        if (!current) return current;
        return {
          ...current,
          meetings: current.meetings.map(meeting => ({
            ...meeting,
            sessionItems: meeting.sessionItems.map(item => (
              item.sessionId === session.sessionId
                ? {
                  ...item,
                  classification,
                  expectedZone,
                  hostCaptainRecordId,
                  classificationSource: 'session_override',
                }
                : item
            )),
            mixedClassifications: new Set(
              meeting.sessionItems.map(item => (
                item.sessionId === session.sessionId ? classification : item.classification
              ))
            ).size > 1,
          })),
        };
      });
    },
  });

  const rematchAll = async () => {
    setBusyKey('rematch-all');
    setError('');
    try {
      const response = await fetch('/api/rematch-zoom', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Rematch failed.');
      setPendingRematchCount(0);
      await loadReviewData();
      window.dispatchEvent(new Event('engagement-data-updated'));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyKey('');
    }
  };

  if (loading && !data) {
    return <div className="review-loading">Preparing the identity review workspace…</div>;
  }

  return (
    <section className="review-workspace">
      <div className="review-workspace-heading">
        <div>
          <div className="section-kicker">Human-in-the-loop intelligence</div>
          <h2>Review & Classification</h2>
          <p>
            Resolve Zoom identities quickly — decisions save immediately. When you are done
            with a batch, rematch once to apply them across stored attendance history.
          </p>
        </div>
        <button
          className={pendingRematchCount > 0 ? 'rematch-button rematch-button-pending' : 'rematch-button'}
          disabled={busyKey === 'rematch-all'}
          onClick={rematchAll}
        >
          {busyKey === 'rematch-all'
            ? 'Rematching…'
            : pendingRematchCount > 0
              ? `Rematch now (${pendingRematchCount} saved)`
              : 'Rematch stored Zoom data'}
        </button>
      </div>

      {error && <div className="captain-error">{error}</div>}
      {pendingRematchCount > 0 && !error && (
        <div className="rematch-pending-banner">
          {pendingRematchCount} decision{pendingRematchCount === 1 ? '' : 's'} saved.
          Keep reviewing, then click <strong>Rematch now</strong> once to update matches
          and captain signals without hitting Google Sheets rate limits.
        </div>
      )}

      {data && (
        <>
          <div className="review-summary-strip">
            <div><strong>{data.identities.length}</strong><span>unique identities</span></div>
            <div><strong>{data.summary.reviewOccurrences}</strong><span>review occurrences</span></div>
            <div><strong>{data.summary.unclassifiedMeetings}</strong><span>meeting types unclassified</span></div>
            <div><strong>{data.summary.matchedHosts}</strong><span>captain hosts matched</span></div>
            <div><strong>{data.summary.onboardingProspects}</strong><span>onboarding prospects preserved</span></div>
          </div>

          <div className="review-tabs">
            <button
              className={tab === 'identities' ? 'active' : ''}
              onClick={() => setTab('identities')}
            >
              People to identify <span>{data.identities.length}</span>
            </button>
            <button
              className={tab === 'meetings' ? 'active' : ''}
              onClick={() => setTab('meetings')}
            >
              Meeting types <span>{data.meetings.length}</span>
            </button>
          </div>

          <div className="review-list">
            {tab === 'identities' && data.identities.map(item => (
              <IdentityReviewRow
                key={item.key}
                item={item}
                captains={data.captains}
                busy={busyKey === item.key}
                onDecision={decideIdentity}
              />
            ))}
            {tab === 'meetings' && data.meetings.map(meeting => (
              <MeetingReviewRow
                key={meeting.topicKey}
                meeting={meeting}
                captains={data.captains}
                busy={busyKey === meeting.topicKey}
                busyKey={busyKey}
                onSave={saveMeeting}
                onSaveOverride={saveSessionOverride}
              />
            ))}
            {tab === 'identities' && data.onboardingProspects?.length > 0 && (
              <div className="onboarding-prospects">
                <h3>Prospective captains observed in onboarding</h3>
                <p>
                  These identities remain linked to their historical onboarding sessions
                  and will rematch automatically if they later enter the Airtable roster.
                </p>
                {data.onboardingProspects.map(prospect => (
                  <div key={prospect.key}>
                    <strong>{prospect.name}</strong>
                    <span>{prospect.email || 'No email'}</span>
                    <span>{prospect.sessions} session{prospect.sessions !== 1 ? 's' : ''}</span>
                    <span>{prospect.firstSeen}{prospect.lastSeen !== prospect.firstSeen ? ` – ${prospect.lastSeen}` : ''}</span>
                  </div>
                ))}
              </div>
            )}
            {tab === 'identities' && data.identities.length === 0 && (
              <div className="review-empty">Every pending Zoom identity has been resolved.</div>
            )}
            {tab === 'meetings' && data.meetings.length === 0 && (
              <div className="review-empty">No stored Zoom meetings are available yet.</div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// ─── TRENDS COMPONENTS ────────────────────────────────────────────────────────

function BarChart({ data, valueKey, color, height = 120, labelEvery }) {
  if (!data.length) return null;
  const max = Math.max(...data.map(d => d[valueKey]), 1);
  const W = 800, H = height;
  const slotW = (W - 20) / data.length;
  const barW = Math.max(4, slotW - 3);
  const every = labelEvery ?? Math.max(1, Math.ceil(data.length / 12));

  return (
    <svg viewBox={`0 0 ${W} ${H + 28}`} style={{ width: '100%', display: 'block' }}>
      {data.map((d, i) => {
        const barH = Math.max(1, Math.round((d[valueKey] / max) * H));
        const x = 10 + i * slotW;
        const y = H - barH;
        return (
          <g key={i}>
            <rect x={x} y={y} width={barW} height={barH} fill={color} rx={2} opacity={0.8}>
              <title>{d.month}: {d[valueKey]}</title>
            </rect>
            {i % every === 0 && (
              <text x={x + barW / 2} y={H + 18} textAnchor="middle" fill="#446677" fontSize={9}>
                {d.month}
              </text>
            )}
          </g>
        );
      })}
      {/* Y-axis max label */}
      <text x={4} y={12} fill="#2a4060" fontSize={9}>{max}</text>
    </svg>
  );
}

function TrendsTab({ sessions, volunteers }) {
  const today = new Date().toISOString().slice(0, 10);

  const monthly = useMemo(() => {
    const m = {};
    for (const s of sessions) {
      const key = s.date.slice(0, 7);
      if (!m[key]) m[key] = [];
      m[key].push(s);
    }
    return Object.entries(m)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, ss]) => ({
        month,
        sessions: ss.length,
        avgAttendees: Math.round(ss.reduce((sum, s) => sum + s.participants.length, 0) / ss.length),
        uniqueAttendees: new Set(ss.flatMap(s => s.participants.map(p => p.email || `__${p.name}`))).size,
      }));
  }, [sessions]);

  const insights = useMemo(() => {
    if (!volunteers.length) return null;
    const days = (dateStr) => Math.floor((new Date(today) - new Date(dateStr)) / 86400000);

    const absent60 = volunteers.filter(v => v.tier !== 'low' && days(v.lastSeen) > 60)
      .sort((a, b) => days(b.lastSeen) - days(a.lastSeen));

    const newFaces = volunteers.filter(v => days(v.firstSeen) <= 60)
      .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));

    const stars = volunteers.filter(v => v.tier === 'high')
      .sort((a, b) => b.sessionsAttended - a.sessionsAttended)
      .slice(0, 8);

    // Trend: last 2 full months
    const last2 = monthly.slice(-2);
    const trendDir = last2.length < 2 ? null
      : last2[1].avgAttendees > last2[0].avgAttendees ? 'up'
      : last2[1].avgAttendees < last2[0].avgAttendees ? 'down'
      : 'flat';
    const trendDelta = last2.length === 2
      ? last2[1].avgAttendees - last2[0].avgAttendees
      : 0;

    return { absent60, newFaces, stars, trendDir, trendDelta, last2 };
  }, [volunteers, monthly, today]);

  const card = (title, children) => (
    <div style={{
      background: '#0d1e2b', border: '1px solid #1a2e3a',
      borderRadius: 12, padding: '20px 24px', marginBottom: 16,
    }}>
      <div style={{ fontSize: 11, color: '#556677', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14 }}>
        {title}
      </div>
      {children}
    </div>
  );

  return (
    <div style={{ paddingTop: 24 }}>

      {/* Trend summary line */}
      {insights?.trendDir && (
        <div style={{
          background: '#0d1e2b', border: '1px solid #1a2e3a', borderRadius: 12,
          padding: '16px 24px', marginBottom: 16, display: 'flex', gap: 32, alignItems: 'center',
        }}>
          <div>
            <div style={{ fontSize: 11, color: '#556677', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
              Avg Attendance Trend
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{
                fontSize: 26, fontWeight: 700, fontFamily: "'DM Mono', monospace",
                color: insights.trendDir === 'up' ? '#00c2a8' : insights.trendDir === 'down' ? '#e05252' : '#f0b429',
              }}>
                {insights.trendDir === 'up' ? '↑' : insights.trendDir === 'down' ? '↓' : '→'} {Math.abs(insights.trendDelta)}
              </span>
              <span style={{ fontSize: 13, color: '#556677' }}>
                {insights.trendDir === 'up' ? 'more' : insights.trendDir === 'down' ? 'fewer' : 'same'} avg attendees vs prior month
                {insights.last2.length === 2 && ` (${insights.last2[0].month} → ${insights.last2[1].month})`}
              </span>
            </div>
          </div>
          <div style={{ fontSize: 13, color: '#2a3d4d' }}>
            Based on last 2 complete months
          </div>
        </div>
      )}

      {/* Sessions per month chart */}
      {card('Sessions per Month', (
        <>
          <BarChart data={monthly} valueKey="sessions" color="#0077b6" height={110} />
          <div style={{ fontSize: 11, color: '#2a3d4d', marginTop: 6 }}>
            {monthly.length} months of data · {sessions.length} total sessions
          </div>
        </>
      ))}

      {/* Avg attendees per month */}
      {card('Avg Attendees per Session', (
        <>
          <BarChart data={monthly} valueKey="avgAttendees" color="#00c2a8" height={110} />
          <div style={{ fontSize: 11, color: '#2a3d4d', marginTop: 6 }}>
            Unique attendees per session, averaged by month
          </div>
        </>
      ))}

      {/* Unique participants per month */}
      {card('Unique Participants per Month', (
        <>
          <BarChart data={monthly} valueKey="uniqueAttendees" color="#7c5cbf" height={110} />
          <div style={{ fontSize: 11, color: '#2a3d4d', marginTop: 6 }}>
            Distinct people who appeared at least once that month
          </div>
        </>
      ))}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

        {/* Stars */}
        {card('Most Consistent Zoom Identities', (
          <>
            {insights?.stars.map((v, i) => (
              <div key={v.email || v.name} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '7px 0', borderBottom: '1px solid #0d1822',
              }}>
                <div>
                  <div style={{ fontSize: 13, color: '#c8dce8' }}>{v.name}</div>
                  <div style={{ fontSize: 11, color: '#2a3d4d' }}>{v.email || 'no email'}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 13, color: '#00c2a8', fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>
                    {(v.attendanceRate * 100).toFixed(0)}%
                  </div>
                  <div style={{ fontSize: 11, color: '#556677' }}>{v.sessionsAttended} sessions</div>
                </div>
              </div>
            ))}
            {!insights?.stars.length && <div style={{ color: '#2a3d4d', fontSize: 13 }}>No highly frequent Zoom identities yet.</div>}
          </>
        ))}

        {/* Recently absent */}
        {card('Previously Frequent, Now 60+ Days Absent', (
          <>
            {insights?.absent60.length === 0 && (
              <div style={{ color: '#00c2a8', fontSize: 13 }}>No previously frequent identities are currently absent.</div>
            )}
            {insights?.absent60.map((v) => {
              const daysGone = Math.floor((new Date(today) - new Date(v.lastSeen)) / 86400000);
              return (
                <div key={v.email || v.name} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '7px 0', borderBottom: '1px solid #0d1822',
                }}>
                  <div>
                    <div style={{ fontSize: 13, color: '#c8dce8' }}>{v.name}</div>
                    <div style={{ fontSize: 11, color: '#2a3d4d' }}>{v.email || 'no email'}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 12, color: '#e05252', fontFamily: "'DM Mono', monospace" }}>
                      {daysGone}d ago
                    </div>
                    <div style={{ fontSize: 11, color: '#556677' }}>was {v.tier === 'mid' ? 'Occasional' : 'Frequent'}</div>
                  </div>
                </div>
              );
            })}
          </>
        ))}

        {/* New faces */}
        {card('New Faces (last 60 days)', (
          <>
            {insights?.newFaces.length === 0 && (
              <div style={{ color: '#2a3d4d', fontSize: 13 }}>No new Zoom identities in the last 60 days.</div>
            )}
            {insights?.newFaces.map((v) => (
              <div key={v.email || v.name} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '7px 0', borderBottom: '1px solid #0d1822',
              }}>
                <div>
                  <div style={{ fontSize: 13, color: '#c8dce8' }}>{v.name}</div>
                  <div style={{ fontSize: 11, color: '#2a3d4d' }}>{v.email || 'no email'}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 12, color: '#f0b429', fontFamily: "'DM Mono', monospace" }}>
                    first: {v.firstSeen}
                  </div>
                  <div style={{ fontSize: 11, color: '#556677' }}>{v.sessionsAttended} session{v.sessionsAttended !== 1 ? 's' : ''}</div>
                </div>
              </div>
            ))}
          </>
        ))}

      </div>
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
  const [csvProgress, setCsvProgress] = useState(null); // { done, total }
  const [importingCSVs, setImportingCSVs] = useState(false);

  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [progress, setProgress] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [error, setError] = useState('');

  const [sessions, setSessions] = useState(null);
  const [volunteers, setVolunteers] = useState(null);
  const [unidentified, setUnidentified] = useState(null);
  const [libraryMeta, setLibraryMeta] = useState(null); // { savedAt, sessionCount, dateRange }

  const [tab, setTab] = useState('sessions');
  const [sortBy, setSortBy] = useState('rate');
  const [tierFilter, setTierFilter] = useState('all');
  const [search, setSearch] = useState('');

  // Load from localStorage on first mount
  useEffect(() => {
    const saved = loadLibrary();
    if (saved?.sessions?.length > 0) {
      const { volunteers: v, unidentified: u } = aggregate(saved.sessions);
      const sorted = v.sort((a, b) => b.attendanceRate - a.attendanceRate);
      setSessions(saved.sessions);
      setVolunteers(sorted);
      setUnidentified(u);
      const dates = saved.sessions.map(s => s.date).sort();
      setLibraryMeta({
        savedAt: saved.savedAt,
        sessionCount: saved.sessions.length,
        dateRange: `${dates[0]} → ${dates[dates.length - 1]}`,
      });
    }
  }, []);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const applyAndSave = (allSessions) => {
    const merged = sessions ? mergeSessions(sessions, allSessions) : allSessions;
    const { volunteers: v, unidentified: u } = aggregate(merged);
    const sorted = v.sort((a, b) => b.attendanceRate - a.attendanceRate);
    setSessions(merged);
    setVolunteers(sorted);
    setUnidentified(u);
    saveLibrary(merged);
    const dates = merged.map(s => s.date).sort();
    setLibraryMeta({
      savedAt: new Date().toISOString(),
      sessionCount: merged.length,
      dateRange: `${dates[0]} → ${dates[dates.length - 1]}`,
    });
    return merged;
  };

  // ── Pull live API data ───────────────────────────────────────────────────────

  const handleFetch = useCallback(async () => {
    setError('');
    setLoading(true);
    setProgress(0);
    setProgressTotal(0);

    try {
      setStatusMsg('Authenticating with Zoom…');
      const { token } = await getToken();

      setStatusMsg('Fetching user accounts…');
      const zoomUsers = await getAllUsers(token);

      const chunks = chunkDateRange(fromDate, toDate);
      setStatusMsg(`Scanning ${chunks.length} month window(s) across ${zoomUsers.length} user(s)…`);

      const seenUuids = new Set();
      let allMeetings = [];
      for (const zoomUser of zoomUsers) {
        for (const chunk of chunks) {
          const meetings = await fetchMeetingsInRange(
            token,
            zoomUser.id,
            chunk.from,
            chunk.to,
            setStatusMsg
          );
          for (const m of meetings) {
            const key = m.uuid || m.id;
            if (!seenUuids.has(key)) {
              seenUuids.add(key);
              allMeetings.push({ ...m, _hostUser: zoomUser });
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
          hostId: m.host_id || m._hostUser?.id || '',
          hostName: m.host_name
            || m._hostUser?.display_name
            || [m._hostUser?.first_name, m._hostUser?.last_name].filter(Boolean).join(' '),
          hostEmail: m.host_email || m._hostUser?.email || '',
          source: 'api',
        });
        if (i < allMeetings.length - 1) await sleep(DELAY_MS);
      }

      const merged = applyAndSave(enriched);
      setStatusMsg('Matching captains and saving attendance to Google Sheets…');
      const sheetResult = await storeZoomSessions(merged);
      setStatusMsg(
        `Saved ${sheetResult.attendanceRecords} attendance records; ${sheetResult.reviewsNeeded} need identity review.`
      );
    } catch (e) {
      setError(e.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, topicFilter, sessions]);

  // ── Import CSVs to library ───────────────────────────────────────────────────

  const handleImportCSVs = useCallback(async () => {
    if (!csvFiles.length) return;
    setImportingCSVs(true);
    setCsvProgress({ done: 0, total: csvFiles.length });
    setError('');
    try {
      const parsed = await parseHistoricalCSVs(csvFiles, (done, total) => {
        setCsvProgress({ done, total });
      });
      if (parsed.length === 0) {
        setError('No sessions parsed from the uploaded files. Check the file format.');
        return;
      }
      const merged = applyAndSave(parsed);
      await storeZoomSessions(merged);
      setCsvFiles([]);
    } catch (e) {
      setError(e.message || 'CSV import failed.');
    } finally {
      setImportingCSVs(false);
      setCsvProgress(null);
    }
  }, [csvFiles, sessions]);

  // ── Filtered / sorted volunteer list ────────────────────────────────────────

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
      avgRate: volunteers.reduce((s, v) => s + v.attendanceRate, 0) / (volunteers.length || 1),
      highCount: volunteers.filter(v => v.tier === 'high').length,
      atRisk: volunteers.filter(v => v.tier === 'low').length,
      unidCount: unidentified?.length || 0,
    };
  }, [sessions, volunteers, unidentified]);

  const pct = progressTotal ? Math.round((progress / progressTotal) * 100) : null;

  // ── STYLES ──────────────────────────────────────────────────────────────────
  const inputStyle = {
    width: '100%', background: '#0a1520', border: '1px solid #1e3040',
    borderRadius: 8, padding: '10px 13px', color: '#c8dce8', fontSize: 13,
    transition: 'border-color 0.15s', colorScheme: 'dark',
  };
  const labelStyle = {
    fontSize: 11, color: '#8fa3b1', display: 'block',
    marginBottom: 6, letterSpacing: '0.05em', textTransform: 'uppercase',
  };

  const TABS = ['sessions', 'volunteers', 'trends'];

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
              Keep Altadena Together · Captain Intelligence
            </div>
          </div>

          {/* Library status in header */}
          {libraryMeta && (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, color: '#00c2a8' }}>
                  Library: {libraryMeta.sessionCount} sessions saved
                </div>
                <div style={{ fontSize: 10, color: '#2a4d3a' }}>
                  {libraryMeta.dateRange}
                </div>
              </div>
              <button
                onClick={() => {
                  if (confirm('Clear all saved data from this browser? This cannot be undone.')) {
                    clearLibrary();
                    setSessions(null);
                    setVolunteers(null);
                    setUnidentified(null);
                    setLibraryMeta(null);
                  }
                }}
                style={{
                  background: 'none', border: '1px solid #2a1a1a', borderRadius: 6,
                  padding: '4px 10px', color: '#553333', fontSize: 11, cursor: 'pointer',
                }}
              >
                Clear Library
              </button>
            </div>
          )}
        </div>

        <div style={{ maxWidth: 1140, margin: '0 auto', padding: '32px 24px' }}>

          <CaptainDirectory />

          <ReviewWorkspace />

          {/* Setup Panel */}
          <div style={{
            background: '#0d1e2b', border: '1px solid #1a2e3a',
            borderRadius: 16, padding: '28px 32px', marginBottom: 28,
          }}>

            {/* Live API pull */}
            <div style={{ fontSize: 11, color: '#556677', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 20 }}>
              Zoom Ingestion & Raw Diagnostics
              <span style={{ color: '#2f4654', textTransform: 'none', letterSpacing: 0, marginLeft: 8 }}>
                — identity frequencies below are not official captain engagement ratings
              </span>
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
                <label style={labelStyle}>Topic Filter <span style={{ color: '#2a3d4d' }}>(optional — partial match)</span></label>
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
                  color: loading ? '#556677' : '#fff', border: 'none', borderRadius: 8,
                  padding: '10px 28px', fontSize: 13, fontWeight: 600,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap', letterSpacing: '0.03em', transition: 'opacity 0.2s',
                }}
              >
                {loading
                  ? <span style={{ animation: 'pulse 1.5s infinite', display: 'inline-block' }}>Fetching…</span>
                  : 'Pull Data →'}
              </button>
            </div>

            {/* Progress bar for API fetch */}
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

            {/* Historical CSV Import — separate from API pull */}
            <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid #1a2e3a' }}>
              <div style={{ fontSize: 11, color: '#556677', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10 }}>
                Import Historical CSVs to Library
                <span style={{ color: '#2a3d4d', textTransform: 'none', letterSpacing: 0, marginLeft: 8 }}>
                  — merge into saved library without re-fetching API
                </span>
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
                  📂
                  {csvFiles.length === 0
                    ? 'Select participant CSVs…'
                    : `${csvFiles.length} file${csvFiles.length !== 1 ? 's' : ''} selected`}
                  <input type="file" accept=".csv" multiple style={{ display: 'none' }}
                    onChange={e => setCsvFiles(Array.from(e.target.files))} />
                </label>

                {csvFiles.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, color: '#556677', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {csvFiles.map(f => f.name).join(', ')}
                    </div>
                    <button
                      onClick={handleImportCSVs}
                      disabled={importingCSVs}
                      style={{
                        background: importingCSVs ? '#1a2e3a' : '#0a2a1a',
                        border: '1px solid #00c2a855', borderRadius: 8,
                        padding: '9px 20px', color: importingCSVs ? '#556677' : '#00c2a8',
                        fontSize: 12, fontWeight: 600, cursor: importingCSVs ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {importingCSVs
                        ? csvProgress ? `Parsing ${csvProgress.done}/${csvProgress.total}…` : 'Parsing…'
                        : `Import ${csvFiles.length} file${csvFiles.length !== 1 ? 's' : ''} →`}
                    </button>
                    <button
                      onClick={() => setCsvFiles([])}
                      style={{ background: 'none', border: 'none', color: '#e05252', cursor: 'pointer', fontSize: 12 }}
                    >
                      ✕ Clear
                    </button>
                  </>
                )}
              </div>
              {csvFiles.length > 0 && !importingCSVs && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#2a4d3a' }}>
                  These will be merged with any existing library data. Duplicate sessions (same meeting ID or date+topic) will be deduplicated, preferring API data.
                </div>
              )}
            </div>

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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12, marginBottom: 24 }}>
                <StatCard label="Total Sessions" value={stats.totalSessions} accent="#0077b6" />
                <StatCard label="Zoom Identities" value={stats.totalUnique} accent="#00c2a8" />
                <StatCard label="Avg Session Presence" value={`${(stats.avgRate * 100).toFixed(0)}%`} accent="#f0b429" />
                <StatCard label="Frequent Identities" value={stats.highCount} sub="seen in ≥75% of sessions" accent="#00c2a8" />
                <StatCard label="Infrequent Identities" value={stats.atRisk} sub="seen in <40% of sessions" accent="#e05252" />
                <StatCard label="Unidentified" value={stats.unidCount} sub="phones / devices" accent="#334455" />
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', borderBottom: '1px solid #1a2e3a', marginBottom: 0 }}>
                {TABS.map(t => (
                  <button key={t} onClick={() => setTab(t)} style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    borderBottom: tab === t ? '2px solid #00c2a8' : '2px solid transparent',
                    color: tab === t ? '#00c2a8' : '#556677',
                    padding: '10px 22px', fontSize: 13, fontWeight: 600,
                    textTransform: 'capitalize', letterSpacing: '0.05em',
                    marginBottom: -1, transition: 'color 0.15s',
                  }}>
                    {t === 'sessions' ? `Sessions (${sessions.length})`
                      : t === 'volunteers' ? `Zoom Identities (${volunteers.length})`
                      : 'Trends'}
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
                      { val: 'high', label: 'Frequent' },
                      { val: 'mid', label: 'Occasional' },
                      { val: 'low', label: 'Infrequent' },
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

                  {/* Volunteer Rows */}
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
                      No Zoom identities match this filter.
                    </div>
                  )}

                  {/* Unidentified participants section */}
                  {unidentified?.length > 0 && (
                    <details style={{ borderTop: '2px solid #1a2e3a' }}>
                      <summary style={{
                        padding: '12px 20px', cursor: 'pointer', fontSize: 12,
                        color: '#334455', listStyle: 'none', userSelect: 'none',
                      }}>
                        ▸ {unidentified.length} unidentified participants excluded from stats
                        <span style={{ fontSize: 11, color: '#2a3040', marginLeft: 8 }}>
                          (phone numbers, device names — click to expand)
                        </span>
                      </summary>
                      <div style={{ padding: '0 20px 16px' }}>
                        <div style={{ fontSize: 11, color: '#2a3d4d', marginBottom: 10 }}>
                          These participants joined with a phone number or generic device name. They are not counted in any engagement metrics.
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {unidentified.map((u, i) => (
                            <span key={i} style={{
                              background: '#111822', border: '1px solid #1a2630',
                              borderRadius: 4, padding: '3px 9px', fontSize: 11, color: '#334455',
                            }} title={`Appeared in ${u.sessionsAttended} session(s)`}>
                              {u.name}
                              <span style={{ color: '#223040', marginLeft: 5 }}>{u.sessionsAttended}×</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    </details>
                  )}
                </div>
              )}

              {/* Trends Tab */}
              {tab === 'trends' && (
                <TrendsTab sessions={sessions} volunteers={volunteers} />
              )}

            </div>
          )}

          {/* Empty state when nothing loaded yet */}
          {!stats && !loading && (
            <div style={{
              textAlign: 'center', padding: '60px 40px',
              color: '#2a3d4d', fontSize: 14,
            }}>
              <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.4 }}>📊</div>
              Pull live data from Zoom above, or import historical CSVs to get started.
            </div>
          )}

        </div>
      </div>
    </>
  );
}
