# Volunteer Engagement Analyzer
### Keep Altadena Together · Captain Engagement Intelligence

A private Neighborhood Captain engagement directory. The central entity is an
Airtable-backed captain — not a Zoom participant. Zoom, Gmail, Zone Dashboard
access, and eventually WhatsApp attach events to that captain. Identity decisions
stay human-reviewed, source integrations are read-only, and every engagement
signal explains its source.

**Live app:** https://engagement-analyzer.vercel.app

---

## Product North Star

Canonical captain profile (stable ID, emails, aliases, zone, status, confirmed
identity links) + a multi-source activity timeline:

| Source | Role | Status |
|---|---|---|
| Airtable People | Who is a captain | ✅ Live |
| Zoom | Meetings attended / hosted | ✅ Foundation live |
| Zone Dashboard User Access | Last login / dashboard activity | ✅ Plumbing live |
| Gmail / mailbox | Captain correspondence as engagement | 🔧 Sheets plumbing ready; live fetch needs auth |
| WhatsApp | Chat / outreach activity | 📋 Later |
| Resend digest | Weekly summary *to organizers* | 📋 Planned |

See [CLAUDE.md](./CLAUDE.md) for the full multi-source model and signal principles.

---

## What It Does Today

- Uses Airtable as the source of truth for current Neighborhood Captains
- Pulls Zoom meeting attendance and persists sessions/attendance in Google Sheets
- Supports historical Zoom CSV import beyond the 6-month API limit
- Human-reviewed identity linking (never auto-merges people)
- Meeting series defaults + per-session classification overrides
- Syncs Zone Dashboard User Access (`last_seen_at` / `login_count`) into captain signals
- Stores normalized mailbox events in Sheets (`Email Events`) and surfaces them on profiles once loaded
- Captain profiles with transparent multi-source signals — each with reason and source
- Legacy Zoom explorer for raw attendance frequencies (not official ratings)

## Not Built Yet (but on the roadmap)

- Live Gmail API fetch (mailbox list + auth mode still needed)
- WhatsApp events
- Unified multi-source timeline UI
- Scheduled sync, AI briefings, organizer email digest

---

## Requirements

- Zoom **Workplace Business** or Enterprise plan (Pro does not support admin API scopes)
- A Zoom Server-to-Server OAuth app with these scopes:
  - `report:read:list_history_meetings:admin`
  - `report:read:meeting:admin`
  - `report:read:list_meeting_participants:admin`
  - `report:read:list_users:admin`
  - `user:read:list_users:admin`
- Airtable personal access token with `data.records:read` access to the tracker base
- Google service account with the Google Sheets API enabled
- A Google spreadsheet shared with the service account as an editor

---

## Local Development

```bash
git clone https://github.com/johntmayo/engagement-analyzer.git
cd engagement-analyzer
npm install
cp .env.local.example .env.local
# fill in the Zoom, Airtable, and Google Sheets settings
npm run dev
```

Open http://localhost:3000

---

## Deploy

Hosted on Vercel. Auto-deploys on push to `main`.

Add these environment variables in Vercel → Settings → Environment Variables:
- `ZOOM_ACCOUNT_ID`
- `ZOOM_CLIENT_ID`  
- `ZOOM_CLIENT_SECRET`
- `AIRTABLE_ACCESS_TOKEN`
- `AIRTABLE_BASE_ID`
- `AIRTABLE_TABLE_NAME`
- `AIRTABLE_VIEW_NAME`
- `GOOGLE_SHEETS_SPREADSHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `USER_ACCESS_SHEET_ID` (Zone Dashboard User Access Registry; optional if using the workbook source tab)

Credentials are server-side only and never exposed to the browser.

---

## Airtable Roster Synchronization

`POST /api/sync-airtable` reads the `People` table through the configured
`Engagement Analyzer` Airtable view. On its first run it initializes these
Google Sheets tabs:

- `Captains`
- `Identity Links`
- `Zoom Sessions`
- `Zoom Attendance`
- `Zoom Match Review`
- `Session Rules`
- `Session Overrides`
- `Dashboard Access Source` (paste/export fallback)
- `Dashboard Access`
- `Dashboard Match Review`
- `Email Events`
- `Data Quality`
- `Sync Log`

The sync updates active captains by Airtable record ID, retains captains who
leave the view as inactive, and regenerates deterministic data-quality flags
for missing resident IDs and duplicate identifiers.

With the development server running, trigger a sync in PowerShell:

```powershell
Invoke-RestMethod -Method Post http://localhost:3000/api/sync-airtable
```

`GET /api/captains` returns the active roster, Airtable quality findings, and
matched Zoom summaries used by the captain directory.

Live Zoom pulls and historical CSV imports are also persisted to the workbook.
Attendance is matched conservatively by manual identity link, unique email, or
exact name. Ambiguous and unmatched participants are written to
`Zoom Match Review`; the system never merges people automatically.

The in-app Review & Classification workspace groups repeated review rows into
unique identities. Organizer decisions are stored in `Identity Links` as one
of: linked captain, non-captain, ignored identity, or needs research.

Meeting classification has two layers:

1. `Session Rules` stores the recurring-series default by normalized topic.
2. `Session Overrides` stores classification, expected zone, and host-captain
   exceptions for one dated Zoom session.

The supported taxonomy is:

- `captain` — broad coordination; only eligible sessions enter attendance rates
- `working_group` — optional participation; absence never counts negatively
- `captain_support` — one-to-one help/coaching; no denominator
- `onboarding` — pre-captain milestone; unmatched people remain prospective
- `community` — guests expected; captain hosting is a strong leadership signal
- `internal` — staff/operations; no automatic captain implication
- `test_exclude` — no engagement signal
- `unclassified` — no interpretation until an organizer reviews it

Unknown community guests do not enter captain review. Unknown onboarding
attendees remain normalized as prospective people, are not permanently labeled
non-captains, and rematch to their earlier history if they later enter Airtable.

Because Altagether Zoom accounts are shared, Zoom usually identifies the host
as `Altagether Org` or `Altagether NCs`. A meeting series can therefore be
assigned manually to its actual host captain in the classification workspace.
That assignment is retained at either the series or dated-session level and
counted as a distinct, high-value hosting signal on the captain profile.

`POST /api/rematch-zoom` reapplies all saved identity decisions and meeting
rules, per-session overrides, guest handling, prospective onboarding handling,
and host assignments to stored attendance without calling Zoom again.

### Zone Dashboard access

`POST /api/sync-dashboard-access` reads the Zone Dashboard **User Access** sheet
(`USER_ACCESS_SHEET_ID`, tab `Access`) or, if that env var is unset, rows pasted
into workbook tab `Dashboard Access Source`. It matches `login_email` to captain
`dashboard_gmail` / emails / confirmed identity links (never by name alone),
writes `Dashboard Access` + `Dashboard Match Review`, and exposes
**Last Zone Dashboard access** on captain profiles.

Share the User Access Registry as **Viewer** with
`engagement-sheets-sync@…` (Analyzer service account). The Dashboard uses a
different service account (`dashboard@…`); both may need access to the same sheet.

### Gmail / mailbox

Sheets plumbing is ready (`Email Events` tab).

- `GET /api/sync-gmail` — configuration status / missing env vars
- `POST /api/sync-gmail` with `{ "events": [...] }` — store normalized events now
- Live mailbox fetch waits on organizer answers: mailbox(es), inbound/outbound/both,
  what “credits assigned” means, and auth (`domain_wide` vs user OAuth)

This is captain correspondence evidence — not the planned Resend organizer digest.

### Organizer workflow

1. Sync Airtable to refresh the current captain roster and data-quality flags.
2. Sync Dashboard Access (or paste Access rows into `Dashboard Access Source` first).
3. Pull Zoom or import historical CSV files; normalized records are saved to Sheets.
4. In **People to identify**, link only identities supported by evidence; otherwise
   choose non-captain, ignore, or research later. Decisions save immediately without
   rematching, so you can work through a batch without hitting Google Sheets quotas.
5. In **Meeting types**, assign a recurring-series default, expected zone (required
   for attendance-rate eligibility), and the actual captain host when known.
6. Expand a series to review dated sessions. Add overrides when a personal room
   or generic topic served a different purpose or had a different captain host.
7. Click **Rematch now** once after a batch of decisions (or after roster changes).
   Rematch reapplies everything to stored attendance with no Zoom API call.
8. Open a captain profile and expand **Why these signals appear** to audit the
   value, derivation reason, and source.

---

## Historical Data Import

Zoom's API only goes back 6 months. For older data, export participant reports manually from zoom.us → Reports → Usage Reports → Meeting and Webinar History. Check both **"Export with meeting data"** and **"Show unique users"** when exporting. Upload the CSV files using the Historical Data section in the app — they'll be merged with live API data automatically.

---

## Tech Stack

Next.js 14 (Pages Router) · Vercel · Zoom Server-to-Server OAuth · Airtable
(read-only roster) · Google Sheets (normalized datastore)

Captain profiles expose transparent source-specific signals rather than a single
opaque engagement score. The legacy Zoom explorer still shows raw attendance
frequency labels for exploratory use; those are not official captain ratings.

---

*For detailed technical documentation see [CLAUDE.md](./CLAUDE.md)*