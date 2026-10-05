# Curator dashboard

The dashboard is available at `/curator`. Only accounts with a manually granted curator role can open it or use its APIs. Ordinary Google sign-in does not grant access. Curators cannot read player plans.

## First-time setup

1. Apply the database migrations with `npm run db:migrate` before deploying the dashboard.
2. Sign in to FGO Chronicle with the account that will curate the schedule.
3. Open `/api/auth/session` in the same signed-in browser and read `user.id`. This is your application account ID. Do not use an email address.
4. Check the selected account:

   ```sh
   npm run curator:access -- check USER_ID
   ```

5. Grant access to that exact account:

   ```sh
   npm run curator:access -- grant USER_ID --confirm --reason="Initial curator access"
   ```

6. Open `/curator` while signed in to that account.

The command uses the database configured in `.env`. Check the intended environment before changing access. Run it only on a trusted machine. Do not share database credentials or account identifiers publicly.

To revoke access:

```sh
npm run curator:access -- revoke USER_ID --confirm --reason="Curator access removed"
```

Every request checks the current database role. Revocation does not depend on refreshing the browser's session. An edit already authorised in a transaction can finish before revocation takes effect.

## Corrections

Search for an event, then select its dates or a reward. The source panel shows imported values and evidence. Date and time fields use UTC.

Every correction requires a reason. Saving an event can move its non-overridden reward dates by the same start-date offset. A reward correction uses its own explicit date instead. Clearing a reward date removes it from dated income.

Hide an event to remove it and its rewards from the public timeline. This does not permanently delete its source records. Clear the hide checkbox to restore it, or select **Use imported values** to remove the whole event correction.

Corrections are separate from imported rows. New imports do not overwrite them. Source cleanup preserves records with curator history. Reset uses the latest imported values and retains the correction's revision and audit history.

### Field ownership

The **Keep curator values** checkboxes identify fields that must retain a correction.
Editing a field selects it automatically. Clear its checkbox to use the latest source value after saving.
Start and end dates each include their timestamp precision. Reward date movement is a separate choice.
Older full-snapshot corrections retain all their fields until a curator releases them explicitly.
New corrections do not retain untouched fields. Releasing every field restores source values but keeps the revision and change history.
A name-only correction does not change the status of the dates. Individually corrected reward dates do not inherit an event date shift.

Apply the field-ownership migration before deploying these controls. The curator-only tables keep their existing RLS protections.

The change history records the curator account, time, reason, source snapshot, and old/new correction. No dashboard operation edits this history. Role changes also create audit records.

## Reviews and queue

Saving a correction does not mark it reviewed. Select **Mark reviewed** after checking the current content and evidence.
Event and reward reviews are separate. **Review all** covers the selected event and its current rewards, not other family members or banners.
Save or discard unsaved edits before reviewing.

Reviews store who checked the content, when, and hashes of the imported and displayed values. Changed values require another review.
This includes imported values that change while a correction is active. Import timestamps alone do not reopen reviews.
The dashboard keeps earlier reviews in the change history.
The review status updates after the save succeeds. The queue and selected record's history refresh in the background.
Older review dates do not confirm that anyone checked the current reward values.
Public reward details and income tiles use the same content checks. Changed rewards show **Needs re-review** until a curator reviews them again.

The queue shows unreviewed records, records that need re-review, source changes, missing evidence, corrections, and hidden events.
An event stays in the review queue until both the event and its rewards have current reviews.
Search checks imported and displayed names. Date filters and chronological sorting use displayed Global dates.
Hidden events are excluded by default. Select the Hidden view or change the visibility filter to include them.

Apply the review migration before deploying these controls.
Tracking how long records have waited for review and dismissing importer warnings are not implemented yet.

## Global source assessment

`npm run data:review-global-events` compares the public Atlas JP and NA event exports for the next 35 days.
It does not connect to the database by default. It never publishes events, rewards or confirmation status.
Use `--from=YYYY-MM-DD` and `--through=YYYY-MM-DD` after `--` to inspect another interval.
Saved exports can be supplied with `--jp-file=PATH` and `--na-file=PATH`.

To resolve candidates against existing event IDs, run:

```bash
node --env-file=.env scripts/report-global-event-candidates.mjs --include-database
```

This mode reads schedule identities and correction revisions only. It does not read player plans or curator account information.
An associated identity requires a shared event ID, matching event type and the same non-empty war association.
Title similarities do not establish a match. Missing associations and conflicts remain unresolved.
The report retains Global timestamps without projecting them. Embedded reward totals do not include quest rewards.
This is a source-assessment tool, not the automatic Global publication workflow.

### Global source queue

Open **Global source queue** in the dashboard to collect a date range of up to 90 days.
Collection reads the fixed Atlas JP and NA exports. Curators cannot supply arbitrary retrieval URLs or file paths through the API.
The queue keeps matched records, unresolved identities and malformed-date issues. It does not create public events or rewards.
Filter by matched or unresolved records. Sort by the newest assessment or earliest valid event date.
**Open matched event** opens the existing event editor. Unresolved records have no public target.
Source assessment details retain the JP record and Global retrieval metadata.

Repeated collection preserves one assessment for the same source content and identity result.
Changed source records create new assessments. Earlier versions remain available.
Collection checks curator access before retrieval and again inside the transaction.
It rechecks matched identities before saving candidates. Candidates and their collection audit save together.
The private queue table forces RLS and grants no client-role access.
Collection and pagination limits live in `src/shared/global-reconciliation-config.ts`, separate from timeline layout settings.
Apply the candidate-queue migration before deploying these controls.

### Publisher announcements

Select **Collect publisher announcements** to check recent official news and maintenance articles.
The date range controls apply only to Atlas collection. Publisher collection reads fixed feeds with separate coverage limits.
Use **Source type** to filter the queue. Open **Source assessment details** to inspect extracted periods, surrounding text and timezone labels.
Event, summon, exchange/shop and maintenance periods remain separate. Unsupported date formats and embedded content appear as review issues.
Missing times, unknown timezones, conflicting offsets and invalid ranges do not become confirmed dates.
Collection keeps earlier article revisions and saves identical assessments only once.
Source assessment details now include automatic event matching against nearby Global schedule entries.
Matching searches within 30 days of the announced start, then 60 and 90 days only when no candidate passes the identity checks.
Ambiguous matches stop the search. Date proximity alone cannot select an event.
The private assessment records the candidate IDs, matching window and rule revision.
Conflicting event periods, reruns and numbered titles have separate matching checks.
Announcements remain private and unresolved. They cannot use the Atlas preview or publication workflow.
This collection does not change events, rewards, player plans or date confirmation.
The daily cron handler now runs this collection after the JP importer. This wiring takes effect after deployment.

### Daily cron

Vercel calls `/api/cron/event-schedule` daily at 18:00 UTC, using `CRON_SECRET` for authentication.
The handler runs these stages in order:

1. Import the JP Atlas event, war/story and master-mission data, and reconcile Fandom event coverage and rewards.
2. Compare Atlas JP and NA event exports for the next 90 days and save private Global source assessments.
3. Collect recent official Global announcements and assess event matches using the 30/60/90-day search windows.
4. Invalidate the public timeline cache and warm its progressive windows.

Global collection failures produce a warning without blocking the other collector or cache refresh.
Retrieval limits, identity checks and collection audits also apply to cron calls. Cron cannot impersonate a curator.
Responses contain collection counts, not private article snapshots or player data.

Automatic publication is not yet wired. The family-shift calculator is implemented, but date-overlay storage and atomic announcement publication are still pending.
Until those checks pass, cron keeps announcement assessments private and reports `publication: "disabled"`.
It does not apply official family moves or change reward amounts, curator corrections or player plans.
Atlas Global publication remains a curator action through the preview workflow.

`npm run data:sync-event-schedule` and the daily cron use the same complete importer.
The local command uses the database credentials in `DATABASE_URL` from `.env`. It does not require `CRON_SECRET`.
The HTTP cron endpoint still requires `CRON_SECRET`. CLI authority is available only from the local import entry point, not from an HTTP request.
It runs against the database in `DATABASE_URL`, so check that target before running it.

```bash
npm run data:sync-event-schedule -- --dry-run
npm run data:sync-event-schedule
```

Dry runs assess JP/Fandom and Global sources without saving imports, candidates, audits or output files.
Existing `--as-of`, source-file and output flags remain available. Source-file flags apply to the JP inputs. Global collection still retrieves its fixed public sources.
Only cron refreshes and warms the Next.js timeline cache. The local command needs no running web server.
Global collection failures appear in the report and give the command a non-zero exit code. Successful earlier stages remain saved.

### Global reconciliation verification

The local acceptance audit passed 575 unit/static tests and 62 database/HTTP checks.
Checks covered identity conflicts, stale approvals, partial confirmation, source revisions, atomic audits and denied client-role access.
A real JP re-import retained accepted Global rewards, manual additions, suppressed rewards, family corrections, banners and player references.
Public details and progressive responses kept private source assessments and player data out of their payloads.
A local production server returned a new publication through a warmed timeline cache without a tag invalidation call.
The schema comparison and production build passed against a disposable database. No browser QA or production database writes ran.
Shared-database tests ran serially because their whole-table assertions must not race with other fixtures.

Apply the pending migrations to the intended database before deployment. Production migrations, deployment and scheduled reconciliation require separate approval.

### Global value previews

Open **Preview Global values** for a matched source assessment.
The preview shows current, Global-source and proposed event values, along with the proposed date status.
Curator-owned fields retain their corrections by default. Select **Use Global source value** to release an individual field in the preview.
These selections do not save changes until publication.

Reward matching requires the same source identity in both regional records within the verified event.
Duplicate or missing reward identities remain unchanged. Unmatched Global rewards stay visible without creating new income.
The preview retains stable reward IDs, manual definitions, hidden state and family associations.
Reward amount differences exclude player inclusion choices. Conditional rewards are not guaranteed income.
Quest rewards are not inspected by this source assessment.
Old assessments without both regional reward-source records require collection again.
Superseded assessments, changed event identities and invalid mixed date ranges cannot proceed.
Preview fingerprints include current event and reward values for the publication check.

### Publish Global values

Check the preview, enter a publication reason, then select **Publish Global values**.
The server checks curator access again and rejects changed records or superseded assessments.
Publication saves accepted source baselines, selected field releases, date evidence and an audit in one transaction.
If a write fails, none of these changes are saved. Repeating an unchanged publication creates no duplicate evidence or audit.

The JP forecast remains in its original rows. Accepted Global values provide the new source baseline for matched fields.
Curator-owned fields remain unchanged unless explicitly released. Individually corrected reward dates stay fixed.
Verified rewards retain their IDs and source-date anchors. Unmatched rewards keep their existing values, without extra income.
Later importer cleanup cannot delete accepted Global reward identities.
Publication does not move families or summon banners, grant access, or read player plans.

Public event details show separate start/end confirmation and a Global game-data source link.
Publication invalidates public timeline caches. Its event audit also advances the cache revision if tag invalidation fails.
An already-open timeline may need a refresh.
Apply the Global-baseline migration before deploying these controls. Both baseline tables force RLS and deny client-role access.

### Date confirmation evidence

The evidence table keeps Global source records separate from reviews and corrections.
Each record stores its source kind, URL, record identity, retrieval time and content hash.
Start and end confirmation have separate timestamps and precision. Earlier evidence remains in history when a source changes.
The curator API provides paginated evidence history. Signed-out users and ordinary accounts cannot read it.
There is no endpoint for manually submitting an official-date claim.

Storage alone does not publish a date or change public income.
The boundary classifier requires qualifying Global evidence that matches the displayed timestamp and precision.
A confirmed start does not confirm a projected end. Date corrections remain Curated, including a removed end date.
Name corrections do not change date status.
Publication applies this classification to the public timeline.
Apply the evidence migration before deploying its API. RLS is forced, and client database roles have no table privileges.

## Family names

Select an event, then open **Family name** if the event belongs to a family.
Enter the shared display name and a reason, then select **Preview name**.
Check the current and proposed names before selecting **Save family name**.

This changes only the family label. Individual event and banner names, dates, rewards, artwork and player plans remain unchanged.
The imported family name stays available. Later imports cannot overwrite the correction.
Select **Preview imported name** to check a reset, then **Use imported name** to publish it.
A reset uses the latest imported name and keeps the correction history.

The server rejects a preview if the imported name, correction revision or family membership changed before publication.
Reload the family and make a new preview. Failed saves keep the form values.
Family-name changes use the same public cache revision checks as event and reward corrections.

Apply the family-name migration before deploying this editor. Family moves and banner corrections are not implemented yet.

If another curator changed the record, the dashboard rejects the stale save. Reload the record and review the new values before trying again. Failed saves retain the form values. After a successful save, public timeline caches are invalidated. An already-open timeline may need a reload.

The dashboard has no public navigation link or search-engine listing. Page checks and API permission checks enforce access independently. The new tables have forced RLS and no grants to Supabase `anon` or `authenticated` roles. The server's Prisma connection remains privileged.

Public windows use the tagged Next.js data cache. Each request also checks the number of saved event and reward corrections. This number forms part of the cache key, so a save or reset selects fresh data even if tag invalidation fails. The check adds one small database query per request. The larger schedule queries remain cached. Correction history must not be deleted.

HTTP responses do not retain a separate stale CDN copy. An already-open timeline still needs a reload to fetch corrections. Deployments running older code do not gain this behaviour until they are updated.
