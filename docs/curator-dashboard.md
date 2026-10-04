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

The queue shows unreviewed records, records that need re-review, source changes, missing evidence, corrections, and hidden events.
An event stays in the review queue until both the event and its rewards have current reviews.
Search checks imported and displayed names. Date filters and chronological sorting use displayed Global dates.
Hidden events are excluded by default. Select the Hidden view or change the visibility filter to include them.

Apply the review migration before deploying these controls.
Tracking how long records have waited for review and dismissing importer warnings are not implemented yet.

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
