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

If another curator changed the record, the dashboard rejects the stale save. Reload the record and review the new values before trying again. Failed saves retain the form values. After a successful save, public timeline caches are invalidated. An already-open timeline may need a reload.

The dashboard has no public navigation link or search-engine listing. Page checks and API permission checks enforce access independently. The new tables have forced RLS and no grants to Supabase `anon` or `authenticated` roles. The server's Prisma connection remains privileged.

Public windows still use the tagged Next.js data cache. Their HTTP responses do not retain a separate stale CDN copy. This allows saved corrections to appear after cache invalidation. It increases function requests compared with the previous CDN cache, but keeps database reads cached.
