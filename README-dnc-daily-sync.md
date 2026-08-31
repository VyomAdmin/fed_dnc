# National DNC Daily Sync

Implements `.scratch/National_DNC_daily.md`: keeps a local Postgres table of every
National DNC number for the 34 subscribed area codes, synced daily from the FTC
registry's Change List files, so campaign scrubs are a local SQL anti-join instead
of a live API call — with every run logged for safe-harbor documentation.

## Components

| File | Purpose |
|---|---|
| `db/schema.sql` | `dnc_numbers` + `sync_log` tables |
| `db/pool.js` | RDS-ready `pg` Pool (reads `DATABASE_URL`, TLS-aware) |
| `lib/areaCodes.js` | the 34 subscribed area codes (FL 23 + AZ 5 + SC 6) |
| `lib/parse.js` | Full List / Change List flat-file parsers |
| `lib/registryClient.js` | fetches Full/Change List files from the registry (or `DNC_MOCK_DIR` fixtures for local testing) |
| `lib/syncEngine.js` | upsert/delete logic + `sync_log` writes + staleness check, DB-agnostic and unit-tested |
| `scripts/migrate.js` | applies `db/schema.sql` |
| `scripts/seed_full_list.js` | Day 0 one-time Full List seed |
| `scripts/daily_sync.js` | Day N Change List sync (cron target) |
| `scripts/scrub_against_dnc.js` | monthly/campaign anti-join against a CSV of contacts |
| `scripts/hubspot_dnc_writeback.js` | matches HubSpot list contacts against `dnc_numbers`, stamps `dnc_opt_out=true` on matches. Full check (no `--since`) once after seeding; `--since=YYYY-MM-DD` daily thereafter to check only that day's new numbers |
| `lambda/dailyPipeline.js` | orchestrates daily_sync → hubspot_dnc_writeback (diff mode) → Slack summary report, for a single scheduled Lambda |
| `.github/workflows/dnc-daily-sync.yml` | daily cron + manual seed dispatch |

## One thing you need to supply

`lib/registryClient.js` needs the actual telemarketing.donotcall.gov SAN download
endpoints — those only appear once you're logged into the portal with your SAN and
aren't publicly documented, so they're not hardcoded here. Set once you have them:

```
DNC_FULL_LIST_URL_TEMPLATE=https://.../fulllist?areaCode={areaCode}
DNC_CHANGE_LIST_URL_TEMPLATE=https://.../changelist?areaCode={areaCode}&date={date}
DNC_SAN=...
DNC_SAN_USERNAME=...   # or DNC_SAN_TOKEN if it's bearer-token auth
DNC_SAN_PASSWORD=...
```

Everything else — parsing, upsert/delete, staleness, alerting, the scrub query — is
built and unit-tested (`npm test`, 9 passing) against the flat-file formats the spec
describes, using fixtures in `test/fixtures/` via `DNC_MOCK_DIR` so the whole
pipeline is exercisable before real credentials exist.

## Setup on AWS RDS

1. Create an RDS Postgres instance (any small instance class is fine — the daily
   table only ever holds ~34 area codes' worth of 10-digit numbers).
2. Download the RDS CA bundle if you want full TLS chain verification:
   `PGSSLROOTCERT=/path/to/rds-ca-rsa2048-g1.pem`. Without it, connections still use
   TLS but skip chain verification.
3. Set `DATABASE_URL=postgres://user:pass@your-instance.rds.amazonaws.com:5432/dnc`.
4. `npm install && npm run dnc:migrate` to create the tables.
5. `npm run dnc:seed` (Day 0, one-time — pulls the Full List for all 34 area codes).
6. Deploy `scripts/daily_sync.js` on a daily cron after 8am ET. The included GitHub
   Actions workflow (`dnc-daily-sync.yml`, 13:15 UTC) works if you'd rather not stand
   up your own scheduler — put the secrets above in the repo's Actions secrets.

## Running the monthly/campaign scrub

```
npm run dnc:scrub -- contacts.csv --phone-col=phone --out-dir=.
```

Writes `contacts.callable.csv` (survivors) and `contacts.suppressed.csv` (with a
`suppress_reason` column: `ON_NATIONAL_DNC`, `OUT_OF_SAN_COVERAGE`, or
`INVALID_PHONE`). Run this right before each campaign push — the table is always
≤24h stale, so there's no reason to batch it monthly.

## Safe harbor / compliance notes

- `sync_log` is the evidence trail — one row per area code per run, with
  added/removed counts and status. Never delete rows from it.
- A same-day retry happens automatically on failure (`daily_sync.js`); if the retry
  also fails, that area code is marked `stale` and `ALERT_WEBHOOK_URL` fires — the
  run does not silently proceed as if it succeeded.
- `findStaleAreaCodes` flags any area code with no successful sync in the last 31
  days (configurable via `DNC_MAX_STALE_DAYS`) — beyond that, safe harbor no longer
  holds for that area code's numbers.
- A missed day is not a compliance problem by itself — the next Change List always
  covers everything since the *last successful* pull. Only the 31-day threshold is.
