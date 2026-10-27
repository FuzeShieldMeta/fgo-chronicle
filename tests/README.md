# Tests

Run the unit and mounted-component tests with `npm test`. React tests use jsdom;
supplied geometry in the rail tests checks observer behaviour, not browser layout.
Database tests skip unless their dedicated local database is configured.

## Database integration

Use a disposable database. The tests deliberately reject any URL except the one
below and never use the application's `DATABASE_URL`. They create and delete
synthetic users, banners and servants. One rollback case temporarily installs a
test-only database constraint. Do not run these suites concurrently against the
same database.

With Docker installed, start PostgreSQL and apply the existing migrations:

```sh
docker run --detach --rm --name fgo-integration-tests \
  --publish 127.0.0.1:55433:5432 \
  --env POSTGRES_PASSWORD=curator-test-only \
  --env POSTGRES_DB=fgo_curator_qa \
  --tmpfs /var/lib/postgresql/data:rw postgres:17

# Repeat until PostgreSQL reports that it is accepting connections.
docker exec fgo-integration-tests pg_isready -U postgres -d fgo_curator_qa

# Existing migrations reference these roles; they have no login privileges.
docker exec fgo-integration-tests psql -U postgres -d fgo_curator_qa \
  -v ON_ERROR_STOP=1 -c 'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;'

DATABASE_URL='postgresql://postgres:curator-test-only@127.0.0.1:55433/fgo_curator_qa' npm run db:migrate
CURATOR_QA_DATABASE_URL='postgresql://postgres:curator-test-only@127.0.0.1:55433/fgo_curator_qa' npm run test:integration
```

The explicit integration command fails if the URL is missing. To check ordering:

```sh
CURATOR_QA_DATABASE_URL='postgresql://postgres:curator-test-only@127.0.0.1:55433/fgo_curator_qa' npm run test:integration -- --sequence.shuffle --sequence.seed=281026
```

Remove the container and its temporary data when finished:

```sh
docker stop fgo-integration-tests
```
