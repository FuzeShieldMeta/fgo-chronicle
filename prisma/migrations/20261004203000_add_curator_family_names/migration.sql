CREATE TABLE "EventFamilyCuration" (
  "familyId" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "name" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EventFamilyCuration_pkey" PRIMARY KEY ("familyId"),
  CONSTRAINT "EventFamilyCuration_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "EventFamilyCuration_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 300)
);
ALTER TABLE "EventFamilyCuration" ADD CONSTRAINT "EventFamilyCuration_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "EventFamily"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EventFamilyCuration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EventFamilyCuration" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "EventFamilyCuration" FROM PUBLIC;
DO $$
DECLARE api_role TEXT;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON "EventFamilyCuration" FROM %I', api_role);
  END LOOP;
END $$;
