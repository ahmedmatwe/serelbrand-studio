#!/bin/bash
# Publishes the latest bot code to Cloudflare (keeps every key already saved there). Run:  bash scripts/deploy-bot.sh
set -euo pipefail
cd "$(dirname "$0")/../bot"
npx --yes wrangler@4 deploy
echo "✓ البوت اتحدّث — وبقى هو اللي بيشغّل الإنتاج والنشر في مواعيدهم"
