#!/usr/bin/env bash
set -euo pipefail

# ─── OpenClaw Reset & Reinstall ─────────────────────────────────────────────
# Removes all existing cron jobs and re-runs openclaw-setup.sh
# Usage: bash scripts/openclaw-reset.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🗑️  Removing all openclaw cron jobs..."

# List all cron jobs and delete them
JOBS=$(openclaw cron list --json 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for job in (data if isinstance(data, list) else data.get('data', data.get('jobs', []))):
        name = job.get('name', job.get('id', ''))
        if name:
            print(name)
except:
    pass
" 2>/dev/null || true)

if [ -z "$JOBS" ]; then
  echo "  No cron jobs found (or openclaw cron list returned empty)"
else
  while IFS= read -r job; do
    echo "  Deleting: $job"
    openclaw cron remove --name "$job" 2>/dev/null || openclaw cron delete --name "$job" 2>/dev/null || echo "    ⚠️  Could not delete $job"
  done <<< "$JOBS"
fi

echo ""
echo "🔄 Re-running openclaw-setup.sh..."
echo ""

bash "$SCRIPT_DIR/openclaw-setup.sh"
