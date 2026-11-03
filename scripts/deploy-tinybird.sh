#!/bin/sh
# Deploy tinybird/ datafiles to Tinybird Cloud via the deploy API (no tb CLI needed).
# Usage: scripts/deploy-tinybird.sh [--check | --allow-destructive]
#   --allow-destructive is required when a datasource file is removed (its table and data are dropped).
set -eu
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

params="auto_promote=true"
case "${1:-}" in
  --check) params="check=true" ;;
  --allow-destructive) params="auto_promote=true&allow_destructive_operations=true" ;;
esac

set --
for f in tinybird/datasources/*.datasource tinybird/endpoints/*.pipe; do
  [ -f "$f" ] && set -- "$@" -F "data_project://=@$f;filename=$(basename "$f")"
done

curl -sS -X POST "$TINYBIRD_HOST/v1/deploy?$params" \
  -H "Authorization: Bearer $TINYBIRD_ADMIN_TOKEN" "$@" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); dep=d.get("deployment",{}); print("result:", d.get("result"), "| deployment", dep.get("id"), dep.get("status")); [print("  " + x["level"] + ": " + x["message"]) for x in dep.get("feedback",[])]; [print("  error:", e) for e in dep.get("errors",[])]'
