-- Remove Google identity details and OAuth credentials that planner sync does not use.
UPDATE "Account"
SET
    "refresh_token" = NULL,
    "access_token" = NULL,
    "expires_at" = NULL,
    "token_type" = NULL,
    "scope" = NULL,
    "id_token" = NULL,
    "session_state" = NULL,
    "refresh_token_expires_in" = NULL
WHERE "provider" = 'google';

UPDATE "User"
SET
    "name" = NULL,
    "email" = NULL,
    "emailVerified" = NULL,
    "image" = NULL
WHERE "id" IN (
    SELECT "userId"
    FROM "Account"
    WHERE "provider" = 'google'
);
