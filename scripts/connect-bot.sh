#!/bin/bash
# Sets up the Telegram assistant on YOUR Cloudflare account (free) and links it to the autopilot.
# Before running: create the bot with @BotFather, copy its token, open the bot and press Start.
# Run:  bash scripts/connect-bot.sh      (a browser window asks you to log in to Cloudflare once)
set -euo pipefail
REPO=ahmedmatwe/serelbrand-studio
DIR="$(cd "$(dirname "$0")/.." && pwd)/bot"
W="npx --yes wrangler@4"

TOKEN="$(pbpaste | tr -d '[:space:]')"
[[ "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || { echo "✗ الحافظة مفيهاش مفتاح بوت — انسخ المفتاح اللي بعتهولك BotFather"; exit 1; }
NAME=$(curl -s "https://api.telegram.org/bot$TOKEN/getMe" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["result"]["username"] if d.get("ok") else "")')
[ -n "$NAME" ] || { echo "✗ تليجرام رفض المفتاح — اتأكد إنك نسخته كامل"; exit 1; }
# Any old webhook would hide your /start message from getUpdates.
curl -s "https://api.telegram.org/bot$TOKEN/deleteWebhook" > /dev/null
CHAT=$(curl -s "https://api.telegram.org/bot$TOKEN/getUpdates" | python3 -c 'import json,sys; r=json.load(sys.stdin).get("result",[]); ids=[u.get("message",{}).get("chat",{}).get("id") for u in r if u.get("message")]; print(ids[-1] if ids else "")')
[ -n "$CHAT" ] || { echo "✗ افتح البوت @$NAME على تليجرام ودوس Start (أو ابعتله أي رسالة) وبعدين شغّل الأمر تاني"; exit 1; }
echo "✓ البوت @$NAME — الشات بتاعك اتعرف"

echo "… تسجيل الدخول لـ Cloudflare (هيفتح المتصفح مرة واحدة — وافق)"
cd "$DIR"
$W whoami 2>/dev/null | grep -q "associated with" || $W login

if grep -q REPLACE_WITH_KV_ID wrangler.toml; then
  KV=$($W kv namespace create BOT 2>&1 | grep -oE '[0-9a-f]{32}' | head -1)
  [ -n "$KV" ] || KV=$($W kv namespace list 2>/dev/null | python3 -c 'import json,sys; print(next((n["id"] for n in json.load(sys.stdin) if n["title"].endswith("BOT")), ""))')
  [ -n "$KV" ] || { echo "✗ مقدرتش أعمل مخزن KV على Cloudflare"; exit 1; }
  sed -i '' "s/REPLACE_WITH_KV_ID/$KV/" wrangler.toml
fi

URL=$($W deploy 2>&1 | tee /dev/stderr | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
[ -n "$URL" ] || { echo "✗ النشر على Cloudflare ما كملش — ابعتلي اللي ظهر فوق"; exit 1; }

INGEST=$(openssl rand -hex 24); HOOK=$(openssl rand -hex 24)
printf %s "$TOKEN"  | $W secret put TELEGRAM_BOT_TOKEN > /dev/null
printf %s "$CHAT"   | $W secret put CHAT_ID > /dev/null
printf %s "$INGEST" | $W secret put INGEST_SECRET > /dev/null
printf %s "$HOOK"   | $W secret put WEBHOOK_SECRET > /dev/null

# A brand-new workers.dev address can take a few minutes to resolve for Telegram: retry for ~5 minutes.
for i in $(seq 1 20); do
  R=$(curl -s "https://api.telegram.org/bot$TOKEN/setWebhook" --data-urlencode "url=$URL/telegram" --data-urlencode "secret_token=$HOOK" --data-urlencode 'allowed_updates=["message","callback_query"]')
  echo "$R" | grep -q '"ok":true' && break
  echo "… تليجرام لسه مش شايف البوت ($(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("description",""))' 2>/dev/null)) — هحاول تاني بعد 15 ثانية ($i/20)"
  sleep 15
done
echo "$R" | grep -q '"ok":true' || { echo "✗ ربط تليجرام بالبوت فشل: $R"; exit 1; }
echo "✓ تليجرام اتربط بالبوت"

printf %s "$TOKEN"  | gh secret set TELEGRAM_BOT_TOKEN -R "$REPO"
gh secret set TELEGRAM_CHAT_ID -R "$REPO" -b "$CHAT"
gh secret set BOT_URL -R "$REPO" -b "$URL"
printf %s "$INGEST" | gh secret set BOT_INGEST_SECRET -R "$REPO"
printf '' | pbcopy

curl -s -X POST "$URL/ingest" -H "authorization: Bearer $INGEST" -H 'content-type: application/json' \
  -d '{"messages":["✅ اتربطت! اكتبلي «تقرير» أو «فيديو» في أي وقت، ولو فيديو ضرب مشاهدات هنبهك لوحدي."]}' > /dev/null
echo "✓ البوت شغال على $URL — بص على تليجرام"
