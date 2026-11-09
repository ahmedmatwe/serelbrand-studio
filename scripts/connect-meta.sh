#!/bin/bash
# Saves the Facebook Page + Instagram publishing key as GitHub secrets, WITHOUT the key ever being shown or sent
# anywhere else. Copy the long-lived user token first (Access Token Debugger → "Extend Access Token" → copy),
# then run:  bash scripts/connect-meta.sh
set -euo pipefail
REPO=ahmedmatwe/serelbrand-studio
PAGE_ID=1424087740791610          # سر الموبايل
IG_ID=17841470509594836           # @seer.mobile
V=v27.0

USER_TOKEN="$(pbpaste | tr -d '[:space:]')"
[ ${#USER_TOKEN} -gt 50 ] || { echo "✗ مفيش مفتاح في الحافظة — انسخ المفتاح الطويل الأول"; exit 1; }

# The Page token derived from a long-lived user token does not expire.
PAGE_TOKEN=$(curl -s "https://graph.facebook.com/$V/$PAGE_ID?fields=access_token&access_token=$USER_TOKEN" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')
[ -n "$PAGE_TOKEN" ] || { echo "✗ فيسبوك رفض المفتاح — اتأكد إنك نسخت المفتاح بعد Extend"; exit 1; }

EXP=$(curl -s "https://graph.facebook.com/$V/debug_token?input_token=$PAGE_TOKEN&access_token=$PAGE_TOKEN" | python3 -c 'import json,sys; d=json.load(sys.stdin).get("data",{}); print(d.get("expires_at", "?"))')
IG=$(curl -s "https://graph.facebook.com/$V/$IG_ID?fields=username&access_token=$PAGE_TOKEN" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("username","?"))')

printf %s "$PAGE_TOKEN" | gh secret set META_PAGE_TOKEN -R "$REPO"
gh secret set META_PAGE_ID -R "$REPO" -b "$PAGE_ID"
gh secret set META_IG_USER_ID -R "$REPO" -b "$IG_ID"
printf '' | pbcopy   # clear the clipboard

echo "✓ اتحفظ مفتاح النشر في GitHub"
echo "  إنستجرام: @$IG"
if [ "$EXP" = "0" ]; then echo "  المفتاح: دائم (مش بينتهي)"; else echo "  ⚠️ المفتاح بينتهي (expires_at=$EXP) — ابعتلي الرسالة دي"; fi
