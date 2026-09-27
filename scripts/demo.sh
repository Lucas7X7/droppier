#!/usr/bin/env bash
# Scripted demo session for the README (and a GIF, if you record one).
#
#   bash scripts/demo.sh
#
# Uses a throwaway database and port so it never touches your real inbox, and
# --tunnel none so it needs no network. Everything printed here is real output.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-4999}"
DB="$(mktemp -d)/demo.db"
SECRET="whsec_demo_secret_for_the_readme"
BODY='{"id":"evt_demo_1","type":"charge.succeeded","amount":4200}'

step() { printf '\n\033[1m· %s\033[0m\n' "$1"; }

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  wait "${SERVER_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT

step "droppier dev --tunnel none --port $PORT"
LOG="$(mktemp)"
node src/cli.ts dev --tunnel none --port "$PORT" --db "$DB" \
  --secret "$SECRET" --provider stripe --token devdemo >"$LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 60); do
  grep -q 'inbox' "$LOG" && break
  sleep 0.2
done
sed -n '1,5p' "$LOG"

step "a real signed request arrives"
node src/cli.ts sign --provider stripe --secret "$SECRET" --body "$BODY" --url "http://127.0.0.1:$PORT/stripe" >/tmp/droppier-demo-curl.sh
printf '  %s\n' "$(sh /tmp/droppier-demo-curl.sh)"
echo "  -> 200 OK, signature verified"

step "the provider retries it (same event id, same signature)"
printf '  %s\n' "$(sh /tmp/droppier-demo-curl.sh)"
echo "  -> linked as a duplicate, not stored as a second charge"

step "someone tampers with the payload in transit"
curl -sS --no-progress-meter -o /dev/null -X POST "http://127.0.0.1:$PORT/stripe" \
  -H 'content-type: application/json' \
  -H 'stripe-signature: t=1111111111,v1=0000000000000000000000000000000000000000000000000000000000000000' \
  -d '{"id":"evt_demo_1","type":"charge.succeeded","amount":999999}'
echo "  -> 200 OK (so the provider stops retrying), stored as invalid"

step "droppier ls"
node src/cli.ts ls --db "$DB"

ID="$(node src/cli.ts ls --db "$DB" --json | node -e '
  let raw = "";
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    const events = JSON.parse(raw).events;
    const first = events.find((event) => event.verdict === "valid");
    console.log(first.id);
  });
')"

step "droppier show $ID"
node src/cli.ts show "$ID" --db "$DB" --port "$PORT"

step "droppier replay $ID --chaos corrupt"
node src/cli.ts replay "$ID" --chaos corrupt --db "$DB" --port "$PORT" --token devdemo

step "droppier stats"
node src/cli.ts stats --db "$DB" --port "$PORT"

step "the share link a teammate can open (no token needed)"
echo "  http://127.0.0.1:$PORT/_droppier/p/$ID"
echo "  http://127.0.0.1:$PORT/_droppier/p/$ID.json"
echo
echo "inbox:  http://127.0.0.1:$PORT/_droppier?t=devdemo"
echo
echo "re-run any of it:  droppier replay $ID --chaos strip"
