# Volunteer Engagement Analyzer — Claude Code Project Brief
## Keep Altadena Together (Altagether) · Eaton Fire Recovery

---

## What This Project Is

A live web app that pulls Zoom meeting attendance data via API and surfaces volunteer engagement patterns for Altagether's 150+ neighborhood captain network. It replaces manual CSV exports from Zoom with an automated dashboard showing attendance rates, engagement tiers, and at-risk volunteers.

**Live URL:** https://engagement-analyzer.vercel.app  
**GitHub:** https://github.com/johntmayo/engagement-analyzer  
**Stack:** Next.js 14 (Pages Router) · Deployed on Vercel Pro · Auto-deploys on push to main

---

## Org Context

- **John Mayo** — Executive Director, built this app, main contact
- **Stefanie Lynch** — Co-Founder
- **Megan Meo** — Project Lead, handles admin/email
- **~150 neighborhood captains** organized into geographic zones across Altadena, CA
- **Zoom account:** info@altagether.org (Owner) + info+nczoom@altagether.org (Member — separate licensed user, both host sessions)
- **Zoom plan:** Workplace Business (required for admin API scopes)

---

## File Structure

```
zoom-analyzer/
├── pages/
│   ├── index.js              # Entire frontend UI
│   ├── _app.js               # Global CSS import
│   └── api/
│       ├── zoom-token.js     # Server-side: exchanges credentials for access token
│       └── zoom-proxy.js     # Server-side: proxies all Zoom API calls (avoids CORS)
├── lib/
│   └── zoom.js               # All Zoom logic: auth, fetching, parsing, aggregation, CSV export
├── styles/
│   └── globals.css           # Global styles + animations
├── next.config.js
├── package.json              # Dependencies: next, react, react-dom only
└── .env.local.example        # Template for local dev credentials
```

---

## Environment Variables

Set in Vercel → Settings → Environment Variables AND locally in `.env.local`:

```
ZOOM_ACCOUNT_ID=        # From Zoom Marketplace → Engagement Analyzer → App Credentials
ZOOM_CLIENT_ID=         # From Zoom Marketplace → Engagement Analyzer → App Credentials
ZOOM_CLIENT_SECRET=     # From Zoom Marketplace → Engagement Analyzer → App Credentials
```

**After changing env vars in Vercel, must redeploy for changes to take effect.**

---

## How It Works (Data Flow)

1. **Auth** — Browser → POST /api/zoom-token → Vercel reads env vars → calls zoom.us/oauth/token with Basic auth → returns 1-hour access token
2. **Get Users** — Browser → POST /api/zoom-proxy (path=/users) → returns all licensed users → extracts all user IDs
3. **Fetch Meetings** — For each user ID × each 1-month date chunk: calls /report/users/{userId}/meetings with pagination
4. **Deduplicate** — Meetings seen across both users are deduplicated by UUID
5. **Fetch Participants** — For each meeting: calls /report/meetings/{uuid}/participants. UUIDs with `/` or `//` require double URL-encoding. 150ms delay between calls.
6. **Merge CSVs** — If historical CSVs were uploaded, parse and merge them, deduplicating by date+topic against API data
7. **Aggregate** — Build volunteer map keyed by email (fallback: name). Calculate sessionsAttended, attendanceRate, avgDurationMin, lastSeen, tier.
8. **Display** — Sessions tab + Volunteers tab with sorting/filtering/search. CSV export.

---

## Zoom API Constraints (Hard Limits — Cannot Be Changed)

| Constraint | Detail |
|---|---|
| Report history | **6 months max** — hard limit regardless of plan |
| Date range per call | 1 month max — code auto-chunks |
| Page size | 300 records — code paginates |
| Admin scopes | Require Business or Enterprise plan |
| user:read:me | Does NOT work with Server-to-Server OAuth — use /users list instead |
| UUID encoding | UUIDs with / or // must be double URL-encoded |

---

## Zoom App Configuration

- **App name:** Engagement Analyzer
- **Type:** Server-to-Server OAuth
- **Required scopes:**
  - `report:read:list_history_meetings:admin`
  - `report:read:meeting:admin`
  - `report:read:list_meeting_participants:admin`
  - `report:read:list_users:admin`
  - `user:read:list_users:admin`

---

## Historical CSV Import

Zoom's UI lets you export participant reports going back further than the API. Export format:
- Row 0: column headers (Topic, ID, Host, Duration (minutes), Start time, End time, Participants)
- Row 1: meeting metadata values
- Row 2: blank
- Row 3: participant column headers (Name (original name), Email, Total duration (minutes), Guest)
- Row 4+: one participant per row

Export settings: check both "Export with meeting data" AND "Show unique users".

The app has a CSV upload UI that merges these files with live API data, deduplicating by date+topic.

---

## Current Feature Status

| Feature | Status |
|---|---|
| Zoom S2S OAuth auth | ✅ Working |
| Pull meetings from ALL users on account | ✅ Working |
| Fetch participants with pagination + UUID encoding | ✅ Working |
| Sessions tab (expandable rows with attendee list) | ✅ Working |
| Volunteers tab (sort, filter by tier, search, CSV export) | ✅ Working |
| Engagement tiers: Active ≥75%, Sporadic 40-74%, At Risk <40% | ✅ Working |
| Topic filter (partial match on meeting name) | ✅ Working |
| Historical CSV upload + merge | ✅ Working |
| Session filtering (exclude short/empty meetings) | 🔧 Not yet built |
| Persistent database (Supabase) | 📋 Next priority |
| Scheduled auto-pulls / cron job | 📋 Planned |
| Airtable cross-reference with captain roster | 📋 Planned |
| AI-generated engagement briefings (Claude API) | 📋 Planned |
| Weekly email digest (Resend) | 📋 Planned |
| Trend charts over time | 📋 Needs DB first |

---

## Immediate Next Task: Session Filtering UI

When viewing data, many sessions are test meetings, demos, or one-person check-ins that pollute the engagement stats. Need a filtering UI with configurable thresholds:

- **Min participants** — exclude sessions with fewer than N unique attendees (suggested default: 3)
- **Min duration** — exclude sessions shorter than N minutes (suggested default: 10)
- **Keyword exclude** — exclude meetings whose topic contains certain words (e.g. "test", "demo", "onboarding")

These filters should be:
1. Applied client-side after data is fetched (no re-fetch needed)
2. Shown in a collapsible "Advanced Filters" section in the UI
3. Reflected in the stats cards (total sessions count should update)
4. Persisted to localStorage so they survive page refresh

The `sessions` state array has: `{ meetingId, topic, date, duration, participants[], source }`.  
`duration` is in minutes. `participants.length` is the unique count.

---

## Priority Roadmap

### 1. Session Filtering (immediate — see above)

### 2. Supabase Database
- Free tier Postgres at supabase.com
- Schema: `sessions(id, meeting_id, topic, date, duration_min, source, created_at)`, `participants(id, session_id, name, email, duration_sec)`, `sync_log(id, synced_at, from_date, to_date, sessions_added)`
- Add `/api/db-sync` route that saves pulled data to Supabase
- Add `/api/db-load` route that loads stored data (bypasses Zoom API for historical)
- Once DB exists: build scheduled Vercel cron (vercel.json → crons) to auto-pull weekly

### 3. Airtable Integration
- Read captain roster from Airtable
- Cross-reference by name/email against volunteer attendance data
- Write engagement_score and last_seen back to Airtable records
- Flag captains with 30/60/90 day absence

### 4. AI Briefings (Claude API)
- "Generate Briefing" button that sends session + volunteer data to Claude
- Returns plain-English summary: trends, at-risk highlights, zone-level patterns
- Use claude-sonnet-4-20250514, max_tokens 1500

### 5. Email Digest (Resend)
- Weekly automated email to John, Stefanie, Megan
- Summary of sessions that week, new at-risk volunteers, trend direction
- resend.com free tier works natively with Vercel

---

## Local Development

```bash
git clone https://github.com/johntmayo/engagement-analyzer.git
cd engagement-analyzer/zoom-analyzer
npm install
cp .env.local.example .env.local
# fill in the three ZOOM_ values
npm run dev
# open http://localhost:3000
```

Deploy: `git push origin main` → Vercel auto-deploys in ~30 seconds.

---

## Debugging Guide

| Error | Cause & Fix |
|---|---|
| "Zoom credentials not configured" | Env vars missing or set after last deploy. Verify in Vercel → Settings → Environment Variables, then redeploy. |
| API error 400 on zoom-proxy | Check Vercel Logs → click the 400 row → External APIs to see exact endpoint. Usually scope or plan issue. |
| API error 404 on zoom-proxy | Wrong user ID format. Check getAllUserIds() is returning real user IDs. |
| API error 400 on zoom-token | Bad credentials or app not activated. Check Zoom Marketplace → app is Activated. |
| No meetings found | Date range too narrow, or topic filter too restrictive. |
| Scopes not saving in Zoom UI | Only happens on Zoom Pro. Must be on Business or Enterprise for :admin scopes. |
