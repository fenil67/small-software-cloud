#!/usr/bin/env bash
set -u
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
PGC=ssc-pg18-test
export DATABASE_URL="postgres://postgres@localhost:5433/ssc_test"
if ! docker ps --format '{{.Names}}' | grep -qx "$PGC"; then
  docker start "$PGC" >/dev/null 2>&1 || docker run -d --name "$PGC" -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:5433:5432 postgres:18.6 >/dev/null
  sleep 3
fi
until docker exec "$PGC" psql -U postgres -Atc "select 1" >/dev/null 2>&1; do sleep 1; done
cd "$REPO/apps/api" || exit 1
kill_ts() { for p in $(lsof -nP -tiTCP:4099 -sTCP:LISTEN); do ps -p "$p" -o command= | grep -q test-server && kill "$p"; done; }
kill_ts; sleep 1
npm run build >/dev/null || { echo "build failed"; exit 1; }
docker exec "$PGC" dropdb -U postgres --if-exists ssc_test && docker exec "$PGC" createdb -U postgres ssc_test || { echo "db reset failed"; exit 1; }
node dist/db/migrate.js >/dev/null || { echo "migrate failed"; exit 1; }
: > /tmp/ts.log
(TEST_PORT=4099 npx ts-node --project tsconfig.json scripts/test-server.ts > /tmp/ts.log 2>&1 &)
i=0; until grep -q "ready on" /tmp/ts.log; do i=$((i+1)); if [ $i -gt 90 ]; then echo "server not ready after 90s:"; cat /tmp/ts.log; kill_ts; exit 1; fi; sleep 1; done
TEST_PORT=4099 npx tsx scripts/run-tests.ts > /tmp/test-out.txt 2>&1
grep -aE "✗|Passed|Failed" /tmp/test-out.txt
kill_ts
grep -q "Failed: 0" /tmp/test-out.txt
