export const ENGAGEMENT_SCORE_VERSION = 'engagement_v1';
export const ENGAGEMENT_WINDOW_WEEKS = 12;
export const ENGAGEMENT_RISK_WINDOW_WEEKS = 8;

const WEEK_MS = 7 * 86400000;

function startOfUtcWeek(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.getUTCDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date;
}

function weekKey(value) {
  return startOfUtcWeek(value)?.toISOString().slice(0, 10) || '';
}

function keysForRange(currentWeek, startOffset, count) {
  return Array.from({ length: count }, (_, index) =>
    new Date(
      currentWeek.getTime() - (startOffset + index) * WEEK_MS
    ).toISOString().slice(0, 10)
  );
}

function trendDirection(recent, prior) {
  if (recent === 0 && prior === 0) return 'no_recent_activity';
  if (recent > prior) return 'increasing';
  if (recent < prior) return 'decreasing';
  return 'steady';
}

export function buildEngagementScore(events = [], { now = new Date() } = {}) {
  const currentWeek = startOfUtcWeek(now);
  const windowStart = new Date(
    currentWeek.getTime() - (ENGAGEMENT_WINDOW_WEEKS - 1) * WEEK_MS
  );
  const nowTime = new Date(now).getTime();
  const weekly = new Map();

  events.forEach((event) => {
    const timestamp = Date.parse(event.occurredAt || '');
    if (
      !Number.isFinite(timestamp)
      || timestamp < windowStart.getTime()
      || timestamp > nowTime
    ) {
      return;
    }
    const key = weekKey(timestamp);
    const bucket = weekly.get(key) || {
      weekStart: key,
      leadership: false,
      events: [],
      sourceCounts: {},
    };
    const source = String(event.source || 'other');
    bucket.leadership = bucket.leadership || Boolean(event.leadership);
    bucket.sourceCounts[source] = (bucket.sourceCounts[source] || 0) + 1;
    bucket.events.push({
      occurredAt: new Date(timestamp).toISOString(),
      source,
      kind: event.kind || 'activity',
      label: event.label || 'Observed activity',
      reason: event.reason || '',
      detail: event.detail || '',
      leadership: Boolean(event.leadership),
    });
    weekly.set(key, bucket);
  });

  const weeks = [...weekly.values()]
    .map((bucket) => {
      const sortedEvents = bucket.events.sort((a, b) =>
        b.occurredAt.localeCompare(a.occurredAt)
      );
      return {
        weekStart: bucket.weekStart,
        points: bucket.leadership ? 2 : 1,
        leadership: bucket.leadership,
        sources: Object.keys(bucket.sourceCounts).sort(),
        sourceCounts: bucket.sourceCounts,
        eventCount: sortedEvents.length,
        events: sortedEvents.slice(0, 12),
        hiddenEventCount: Math.max(0, sortedEvents.length - 12),
      };
    })
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart));

  const byWeek = new Map(weeks.map((week) => [week.weekStart, week]));
  const latestFourKeys = keysForRange(currentWeek, 0, 4);
  const priorFourKeys = keysForRange(currentWeek, 4, 4);
  const riskKeys = keysForRange(
    currentWeek,
    0,
    ENGAGEMENT_RISK_WINDOW_WEEKS
  );
  const pointsFor = (keys) => keys.reduce(
    (sum, key) => sum + (byWeek.get(key)?.points || 0),
    0
  );
  const recent8ActiveWeeks = riskKeys.filter((key) => byWeek.has(key)).length;
  const risk = recent8ActiveWeeks === 0
    ? 'at_risk'
    : recent8ActiveWeeks === 1
      ? 'needs_attention'
      : 'recently_active';
  const recentFourPoints = pointsFor(latestFourKeys);
  const priorFourPoints = pointsFor(priorFourKeys);
  const allEvents = weeks.flatMap((week) => week.events);

  return {
    version: ENGAGEMENT_SCORE_VERSION,
    windowWeeks: ENGAGEMENT_WINDOW_WEEKS,
    points: weeks.reduce((sum, week) => sum + week.points, 0),
    maxPoints: ENGAGEMENT_WINDOW_WEEKS * 2,
    activeWeeks: weeks.length,
    leadershipWeeks: weeks.filter((week) => week.leadership).length,
    risk,
    recent8ActiveWeeks,
    trend: {
      direction: trendDirection(recentFourPoints, priorFourPoints),
      recentFourPoints,
      priorFourPoints,
    },
    lastActivityAt: allEvents
      .map((event) => event.occurredAt)
      .sort()
      .at(-1) || '',
    weeks,
  };
}
