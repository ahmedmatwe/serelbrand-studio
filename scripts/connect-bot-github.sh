#!/bin/bash
# Lets the Telegram bot ask GitHub for a fresh report when you write «تقرير». Copy the GitHub token you just
# created (fine-grained, only the serelbrand-studio repo, permission "Actions: Read and write"), then run:
#   bash scripts/connect-bot-github.sh
set -euo pipefail
cd "$(dirname "$0")/../bot"
T="$(pbpaste | grep -oE '(github_pat_[A-Za-z0-9_]{40,}|ghp_[A-Za-z0-9]{30,})' | head -1)"
[ -n "$T" ] || { echo "✗ الحافظة مفيهاش مفتاح GitHub — انسخ المفتاح اللي بيبدأ بـ github_pat_"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $T" https://api.github.com/repos/ahmedmatwe/serelbrand-studio/actions/workflows)
[ "$CODE" = "200" ] || { echo "✗ GitHub رفض المفتاح (HTTP $CODE) — اتأكد إنك اخترت مستودع serelbrand-studio وصلاحية Actions"; exit 1; }
printf %s "$T" | npx --yes wrangler@4 secret put GH_TOKEN > /dev/null
printf '' | pbcopy
echo "✓ البوت بقى يقدر يجيبلك أحدث الأرقام أول ما تكتب «تقرير»"
