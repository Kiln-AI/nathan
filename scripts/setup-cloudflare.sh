#!/usr/bin/env bash
# Creates one environment's Cloudflare resources (docs/setup.md, step 1) and writes
# the D1 and KV IDs into wrangler.jsonc. Safe to rerun: existing resources are reused.
#
#   scripts/setup-cloudflare.sh staging
#   scripts/setup-cloudflare.sh production
#
# With more than one Cloudflare account, set CLOUDFLARE_ACCOUNT_ID first.
set -euo pipefail

env="${1:-}"
if [[ "$env" != "staging" && "$env" != "production" ]]; then
  echo "usage: $0 staging|production" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
[[ -d node_modules ]] || { echo "Run 'npm ci' first." >&2; exit 1; }

name="nathan-$env"
queue="nathan-jobs-$env"
upper="$(echo "$env" | tr '[:lower:]' '[:upper:]')"

# Prints the value of field $2 for the entry whose field $1 equals $3, from a JSON array on stdin.
json_lookup() {
  node -e '
    const [key, value, want] = process.argv.slice(1);
    let s = require("fs").readFileSync(0, "utf8");
    s = s.slice(s.indexOf("["));
    const hit = JSON.parse(s).find((x) => x[key] === want);
    if (hit) console.log(hit[value]);
  ' "$1" "$2" "$3"
}

echo "== Cloudflare account"
npx wrangler whoami

echo "== D1 database $name"
d1_id="$(npx wrangler d1 list --json | json_lookup name uuid "$name")"
if [[ -z "$d1_id" ]]; then
  npx wrangler d1 create "$name" </dev/null
  d1_id="$(npx wrangler d1 list --json | json_lookup name uuid "$name")"
else
  echo "exists"
fi
[[ -n "$d1_id" ]] || { echo "Could not find the D1 ID for $name." >&2; exit 1; }

echo "== KV namespace $name"
kv_id="$(npx wrangler kv namespace list | json_lookup title id "$name")"
if [[ -z "$kv_id" ]]; then
  npx wrangler kv namespace create "$name" </dev/null
  kv_id="$(npx wrangler kv namespace list | json_lookup title id "$name")"
else
  echo "exists"
fi
[[ -n "$kv_id" ]] || { echo "Could not find the KV ID for $name." >&2; exit 1; }

for q in "$queue" "$queue-dlq"; do
  echo "== Queue $q"
  if npx wrangler queues info "$q" >/dev/null 2>&1; then
    echo "exists"
  else
    npx wrangler queues create "$q"
  fi
done

echo "== wrangler.jsonc"
node -e '
  const fs = require("fs");
  const [upper, d1, kv] = process.argv.slice(1);
  const file = "wrangler.jsonc";
  const before = fs.readFileSync(file, "utf8");
  const after = before
    .replace(`REPLACE_WITH_${upper}_D1_ID`, d1)
    .replace(`REPLACE_WITH_${upper}_KV_ID`, kv);
  fs.writeFileSync(file, after);
  console.log(before === after ? "no placeholders left; check the IDs below match" : "updated");
' "$upper" "$d1_id" "$kv_id"

echo
echo "D1 database_id: $d1_id"
echo "KV id:          $kv_id"
echo
echo "Next: review and merge the wrangler.jsonc change (git diff wrangler.jsonc)."
