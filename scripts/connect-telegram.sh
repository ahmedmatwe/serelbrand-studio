#!/bin/bash
# Links the Telegram reporting bot WITHOUT showing its token: copy the token BotFather gave you, make sure you
# pressed Start in your bot (or sent it any message), then run:  bash scripts/connect-telegram.sh
set -euo pipefail
REPO=ahmedmatwe/serelbrand-studio

TOKEN="$(pbpaste | tr -d '[:space:]')"
[[ "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || { echo "✗ الحافظة مفيهاش مفتاح بوت — انسخ المفتاح اللي بعتهولك BotFather"; exit 1; }

NAME=$(curl -s "https://api.telegram.org/bot$TOKEN/getMe" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["result"]["username"] if d.get("ok") else "")')
[ -n "$NAME" ] || { echo "✗ تليجرام رفض المفتاح — اتأكد إنك نسخته كامل"; exit 1; }

CHAT=$(curl -s "https://api.telegram.org/bot$TOKEN/getUpdates" | python3 -c 'import json,sys; r=json.load(sys.stdin).get("result",[]); ids=[u.get("message",{}).get("chat",{}).get("id") for u in r if u.get("message")]; print(ids[-1] if ids else "")')
[ -n "$CHAT" ] || { echo "✗ افتح البوت @$NAME على تليجرام ودوس Start (أو ابعتله أي رسالة) وبعدين شغّل الأمر تاني"; exit 1; }

printf %s "$TOKEN" | gh secret set TELEGRAM_BOT_TOKEN -R "$REPO"
gh secret set TELEGRAM_CHAT_ID -R "$REPO" -b "$CHAT"
curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" -d chat_id="$CHAT" --data-urlencode text="✅ اتربطت! من دلوقتي هبعتلك كل شورت أول ما يجهز، وكل إشعار مهم عن قناة سر الموبايل." > /dev/null
printf '' | pbcopy

echo "✓ البوت @$NAME اتربط — بص على تليجرام، المفروض وصلتك رسالة تجربة"
