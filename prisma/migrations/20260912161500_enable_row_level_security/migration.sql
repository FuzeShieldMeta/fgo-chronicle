DO $$
DECLARE
    table_name TEXT;
BEGIN
    FOR table_name IN
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
    LOOP
        EXECUTE format(
            'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
            table_name
        );
        EXECUTE format(
            'ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',
            table_name
        );
    END LOOP;
END
$$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;

DO $$
DECLARE
    api_role TEXT;
BEGIN
    FOR api_role IN
        SELECT rolname
        FROM pg_roles
        WHERE rolname IN ('anon', 'authenticated')
    LOOP
        EXECUTE format(
            'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
            api_role
        );
        EXECUTE format(
            'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
            api_role
        );
        EXECUTE format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I',
            api_role
        );
        EXECUTE format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
            api_role
        );
    END LOOP;
END
$$;
