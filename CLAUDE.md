# Volunteer Engagement Analyzer — Project Brief
## Keep Altadena Together (Altagether) · Eaton Fire Recovery

---

## What This Project Is

A private **Neighborhood Captain engagement directory** that combines multiple
activity sources into one canonical captain profile and timeline.

The central entity is **not** a Zoom participant. It is an **Airtable-backed
Neighborhood Captain** with:

- One stable internal ID (Airtable record ID / resident ID when present)
- Primary and alternate emails
- Name aliases
- Phone / account identifiers
- Zone and status
- Manually confirmed identity links

Source systems then attach **events** to that captain. Zoom is the first source
implemented end-to-end; Gmail, Zone Dashboard access, and eventually WhatsApp
are required parts of the product direction — not optional extras.

Organizers review ambiguous identities and classify meetings. The app derives
transparent engagement signals with an explicit reason and source for each.
Do **not** collapse signals into an opaque score until multi-source evidence is
solid.

**Live URL:** https://engagement-analyzer.vercel.app  
**GitHub:** https://github.com/johntmayo/engagement-analyzer  
**Stack:** Next.js 14 (Pages Router) · Vercel Pro · Airtable (read-only roster) · Google Sheets (datastore) · Zoom S2S OAuth · Zone Dashboard User Access sheet · Gmail API (read-only domain-wide delegation) · (planned) WhatsApp

---

## Org Context

- **John Mayo** — Executive Director, built this app, main contact
- **Stefanie Lynch** — Co-Founder
- **Megan Meo** — Project Lead, handles admin/email
- **~150–170 neighborhood captains** organized into geographic zones across Altadena, CA
- **Zoom account:** info@altagether.org (Owner) + info+nczoom@altagether.org (Member — separate licensed user, both host sessions)
- **Zoom plan:** Workplace Business (required for admin API scopes)
- **Zone Dashboard** — Altagether captain-facing product; User Access spreadsheet tracks last login
- **Org mailboxes** — `info@`, `john@`, `newsletter@`, and `issues@altagether.org`

---

## Product Decisions

- No application login for now.
- Google Sheets is the datastore; do **not** introduce Supabase.
- Airtable is the source of truth for who is currently a Neighborhood Captain.
- Source integrations remain read-only. The Analyzer may write internal decisions
  and normalized data to Google Sheets only.
- Never merge identities automatically. Show evidence and require organizer decisions.
- Multi-source engagement is the north star: Zoom + Gmail + Dashboard access +
  WhatsApp (later) attach to the same captain timeline.
- Do not print or expose `.env.local`.
- Do not commit or push unless explicitly asked.

---

## Multi-Source Engagement Model

Every derived signal must name its **source** and **reason**. Hosting, emailing,
logging in, and meeting attendance are different kinds of evidence.

| Source | What it contributes | Status |
|---|---|---|
| **Airtable People** | Canonical captain roster, zones, status, organizer-recorded interaction | ✅ Synced |
| **Zoom** | Meeting attendance, hosting, classification-aware participation | ✅ Foundation live |
| **Zone Dashboard User Access** | Last login / access activity from the User Access spreadsheet | ✅ Plumbing live (`POST /api/sync-dashboard-access`) |
| **Gmail / mailbox** | Inbound captain correspondence across four Workspace inboxes | ✅ Live |
| **WhatsApp** | Chat/group participation and outreach (later) | 📋 Planned later |
| **Outbound digest (Resend)** | Weekly summary *to organizers* — not a captain signal source | 📋 Planned |

### Canonical captain profile fields (identity layer)

- Stable IDs: Airtable record ID, resident ID when present
- Names + aliases (manual identity links)
- Primary email, additional emails, dashboard Gmail
- Phone / other account identifiers as available
- Zones, active/inactive status, engagement status from Airtable
- Confirmed identity links (never auto-merged)

### Event timeline (activity layer)

Normalized events stored in Sheets and rolled into captain signals, e.g.:

- Zoom session attended / hosted (with classification)
- Email received from captain / email sent to captain
- Dashboard login / last access
- WhatsApp interaction (future)
- Organizer-recorded interaction (manual Airtable field, until automated)

### Signal principles

- Transparent source-specific signals first; no opaque composite score yet
- Absence in an optional channel must not count against a captain
- Hosting and initiated outreach are strong positive leadership signals
- Unmatched people stay in review or channel-specific buckets (guest, prospective);
  they are never silently merged onto a captain

---

## File Structure

```
engagement-analyzer/
├── pages/
│   ├── index.js                 # Roster, review UI, legacy Zoom explorer
│   ├── _app.js
│   └── api/
│       ├── captains.js          # Roster + multi-source transparent signals
│       ├── sync-airtable.js     # Pull Airtable → Captains / Data Quality
│       ├── sync-dashboard-access.js  # Zone Dashboard User Access → signals
│       ├── sync-gmail.js        # Mailbox status + store normalized email events
│       ├── store-zoom.js        # Persist Zoom / CSV pulls to Sheets
│       ├── rematch-zoom.js      # Rematch stored data (no Zoom API)
│       ├── review-data.js       # Review workspace payload
│       ├── review-decision.js   # Identity / series / session-override saves
│       ├── zoom-token.js
│       └── zoom-proxy.js
├── lib/
│   ├── airtable.js              # Roster normalization + quality checks
│   ├── google-sheets.js         # Workbook schemas / access
│   ├── identity.js              # Matching + manual identity decisions
│   ├── zoom-matching.js         # Classifications, guests, hosts, rematch core
│   ├── rematch-zoom.js          # Load Sheets → rematch → write back
│   ├── review-store.js          # Persist identity / rules / overrides
│   ├── sync-airtable.js
│   ├── sync-dashboard-access.js # User Access match + Dashboard Access writes
│   ├── sync-gmail.js            # Email Events normalize/store + status
│   ├── sync-zoom.js             # Store Zoom sessions / attendance
│   └── zoom.js                  # Legacy Zoom fetch / CSV / explorer helpers
├── styles/globals.css
├── next.config.js
├── package.json
├── README.md
└── .env.local.example
```

---

## Environment Variables

Set in Vercel → Settings → Environment Variables AND locally in `.env.local`:

```
ZOOM_ACCOUNT_ID=
ZOOM_CLIENT_ID=
ZOOM_CLIENT_SECRET=
AIRTABLE_ACCESS_TOKEN=
AIRTABLE_BASE_ID=
AIRTABLE_TABLE_NAME=People
AIRTABLE_VIEW_NAME=Engagement Analyzer
GOOGLE_SHEETS_SPREADSHEET_ID=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
USER_ACCESS_SHEET_ID=
GMAIL_MAILBOXES=info@altagether.org,john@altagether.org,newsletter@altagether.org,issues@altagether.org
GMAIL_DIRECTIONS=inbound
GMAIL_AUTH_MODE=domain_wide
# GMAIL_LOOKBACK_DAYS=180
```

**After changing env vars in Vercel, must redeploy for changes to take effect.**

Share the Zone Dashboard User Access Registry with the Analyzer service account
(`engagement-sheets-sync@…`) as Viewer. The Dashboard app uses a different SA
(`dashboard@nc-dashboard-v1.iam.gserviceaccount.com`).

---

## Google Sheets Workbook

| Tab | Purpose |
|---|---|
| Captains | Canonical roster synced from Airtable |
| Identity Links | Organizer identity decisions |
| Zoom Sessions | Normalized sessions + classification / host fields |
| Zoom Attendance | Participant rows with match status |
| Zoom Match Review | Ambiguous / unmatched identities needing review |
| Session Rules | Recurring-series default classification + host |
| Session Overrides | Per-dated-session classification / zone / host |
| Dashboard Access Source | Paste/export fallback when `USER_ACCESS_SHEET_ID` unset |
| Dashboard Access | Matched Zone Dashboard login / last_seen / login_count |
| Dashboard Match Review | Unmatched / ambiguous dashboard logins |
| Email Events | Normalized inbound/outbound mailbox events |
| Data Quality | Missing resident IDs, duplicate identifiers, etc. |
| Sync Log | Airtable, Zoom, dashboard, gmail, and rematch runs |

---

## Meeting Classification Taxonomy

Two layers:

1. **Series default** — `Session Rules` keyed by normalized topic
2. **Session override** — `Session Overrides` keyed by `session_id`

Effective classification = override → series rule → stored/unclassified.

| Classification | Engagement behavior |
|---|---|
| `captain` | Broad coordination. Eligible sessions may enter attendance rates (zone-aware). |
| `working_group` | Optional issue-focused group. Attendance is positive; absence never negative. |
| `captain_support` | One-to-one help/coaching. Positive interaction; no denominator. |
| `onboarding` | Pre-captain milestone. Unmatched people stay `prospective`, not non-captain. Later Airtable entry rematches history. |
| `community` | Guests expected. Unmatched → `expected_guest` (excluded from captain review/metrics). Captain hosting is a strong leadership signal. |
| `internal` | Staff/ops. No automatic captain engagement implication. |
| `test_exclude` | No engagement signal. |
| `unclassified` | No scoring until reviewed. |

Known preserved series examples:

- `Altagether PREP ... Zone 61` → `community`
- `Neighborhood Captain Meeting` → `captain`

Shared Zoom hosts (`Altagether Org` / `Altagether NCs`) require manual captain-host assignment at series or session level.

---

## Engagement Signals (Captain Profiles)

Do **not** collapse into an opaque score. Each signal shows value, reason, and source:

- Captain meetings attended
- Eligible captain-meeting attendance rate (zone-aware denominator; expected_zone required)
- Working-group participation
- Captain-support interactions
- Onboarding milestone / earliest date
- Community meetings hosted
- Other meetings hosted
- Last observed Zoom activity
- Days since last Zone Dashboard use (`login_count` retained only as audit data)
- Mailbox interactions + last mailbox activity
- Last organizer-recorded interaction (Airtable)
- Zoom activity trend (recent 90 days vs prior 90 days)

Hosting is treated as a particularly strong positive signal.
Captain-meeting attendance rates exclude sessions with a blank `expected_zone`
so the denominator never silently becomes all ~168 captains. Use `all` /
`all captains` only when the session truly applies to every captain.

Legacy Zoom explorer frequency tiers (Active / Sporadic / At Risk) remain for
exploratory raw attendance only and must not be presented as official captain
engagement ratings.

---

## Data Flow

1. **Airtable sync** — `POST /api/sync-airtable` reads `People` / `Engagement Analyzer` view → Captains + Data Quality
2. **Zoom store** — Live pull or CSV import → Zoom Sessions + Zoom Attendance, then rematch
3. **Identity match** — Manual link → unique email → exact name. Ambiguous/unmatched go to review (except community guests and onboarding prospects)
4. **Organizer review** — Identity decisions + series defaults + session overrides via Review workspace
5. **Rematch** — `POST /api/rematch-zoom` reapplies identity decisions, classifications, overrides, guests, prospects, and host assignments without calling Zoom
6. **Captain directory** — `GET /api/captains` returns roster + transparent signals

---

## Zoom API Constraints (Hard Limits)

| Constraint | Detail |
|---|---|
| Report history | **6 months max** |
| Date range per call | 1 month max — code auto-chunks |
| Page size | 300 records — code paginates |
| Admin scopes | Require Business or Enterprise |
| user:read:me | Does NOT work with S2S OAuth — use /users list |
| UUID encoding | UUIDs with `/` or `//` must be double URL-encoded |

Required Zoom scopes:

- `report:read:list_history_meetings:admin`
- `report:read:meeting:admin`
- `report:read:list_meeting_participants:admin`
- `report:read:list_users:admin`
- `user:read:list_users:admin`

---

## Current Feature Status

| Feature | Status |
|---|---|
| Airtable-backed canonical captain roster | ✅ |
| Google Sheets persistence + identity decisions | ✅ |
| Zoom S2S OAuth + multi-user pull / CSV import | ✅ |
| Zoom identity review + meeting classification / overrides | ✅ |
| Transparent Zoom-derived captain signals | ✅ |
| Rematch without Zoom API | ✅ |
| Legacy Zoom explorer (raw frequencies) | ✅ exploratory only |
| **Zone Dashboard User Access (last login) → captain events** | ✅ Plumbing live |
| **Gmail / mailbox activity → captain events** | ✅ Read-only four-mailbox fetch live |
| Zoom host-credit + attendance-denominator hardening | 🔧 Denominator hardened; host-credit workflow continues |
| Deeper Zoom history in Sheets | 🔧 Needs fuller pull / CSV |
| Scheduled auto-pulls / cron | 📋 Planned |
| WhatsApp activity → captain events | 📋 Planned later |
| Unified multi-source captain timeline UI | 📋 Planned (needs Gmail + Dashboard first) |
| AI engagement briefings | 📋 Planned |
| Weekly organizer email digest (Resend) | 📋 Planned |
| Trend charts | 📋 Planned |
| Session filtering UI (min participants/duration/keywords) | 🔧 Optional polish |

### Immediate integration priorities

1. Verify the completed Gmail fetch against Vercel
2. Finish Zoom host-credit UX for shared Altagether Org / Altagether NCs accounts
3. Unified timeline across sources; WhatsApp after email/dashboard are trusted
4. Keep this multi-source north star current (this file + README)

---

## Organizer Workflow

1. Sync Airtable to refresh the captain roster and data-quality flags.
2. Sync Dashboard Access (`USER_ACCESS_SHEET_ID` or paste into `Dashboard Access Source`).
3. Pull Zoom or import historical CSVs; records persist to Sheets.
4. In **People to identify**, link only with evidence; otherwise non-captain, ignore, or research later.
   Decisions save immediately and do **not** rematch on every click (avoids Sheets quota).
5. In **Meeting types**, set series default, **expected zone** (needed for attendance rates),
   and actual captain host when known.
6. Expand a series to override dated sessions (personal rooms / mixed-purpose topics).
7. Click **Rematch now** once after a batch (or after roster changes). No Zoom call.
8. Open a captain profile → **Why these signals appear** to audit value, reason, and source.

---

## Local Development

```bash
git clone https://github.com/johntmayo/engagement-analyzer.git
cd engagement-analyzer
npm install
cp .env.local.example .env.local
# fill Zoom, Airtable, and Google Sheets values
npm run dev
# open http://localhost:3000
```

Useful PowerShell checks:

```powershell
Invoke-RestMethod http://localhost:3000/api/captains
Invoke-RestMethod http://localhost:3000/api/review-data
Invoke-RestMethod -Method Post http://localhost:3000/api/sync-dashboard-access
Invoke-RestMethod http://localhost:3000/api/sync-gmail
Invoke-RestMethod -Method Post http://localhost:3000/api/rematch-zoom
```

Deploy: `git push origin main` → Vercel auto-deploys.

---

## Debugging Guide

| Error | Cause & Fix |
|---|---|
| "Zoom credentials not configured" | Env vars missing or set after last deploy. Redeploy after fixing Vercel env. |
| "Missing Google Sheets configuration" | One of `GOOGLE_*` vars missing/malformed. Check private key `\n` escaping. |
| Airtable sync empty / auth error | Token scopes or base/view names wrong. |
| API error 400 on zoom-proxy | Usually scope or plan issue — check Vercel External APIs log. |
| API error 404 on zoom-proxy | Wrong user ID format from `/users`. |
| No meetings found | Date range too narrow, or topic filter too restrictive. |
| Classifications not applying | Run rematch after saving rules/overrides; confirm Session Overrides sheet exists. |
| Scopes not saving in Zoom UI | Pro plan limitation — needs Business/Enterprise for `:admin` scopes. |
| Dashboard sync: no source configured | Set `USER_ACCESS_SHEET_ID` or paste Access rows into `Dashboard Access Source`. |
| Dashboard sync: permission denied | Share User Access Registry with Analyzer SA as Viewer. |
| Gmail quota error | Sync retries transient limits and bounds each mailbox to 200 recent messages per run. |
