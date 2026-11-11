#!/bin/bash
# Links TikTok publishing through Buffer. In Buffer: Settings → API → create a key → copy it, then run:
#   bash scripts/connect-buffer.sh
# The key goes straight from the clipboard into GitHub secrets — it is never shown or sent anywhere else.
set -euo pipefail
REPO=ahmedmatwe/serelbrand-studio
KEY="$(pbpaste | tr -d '[:space:]')"
[ ${#KEY} -ge 20 ] || { echo "✗ الحافظة مفيهاش مفتاح Buffer — انسخه الأول من Buffer (الإعدادات ← API)"; exit 1; }
# Check the key and that a TikTok channel is connected (only names/services are printed, never the key).
OUT=$(curl -s https://api.buffer.com -H 'content-type: application/json' -H "authorization: Bearer $KEY" \
  -d '{"query":"query { account { organizations { id name } } }"}')
ORG=$(printf %s "$OUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); o=(d.get("data") or {}).get("account",{}).get("organizations",[]); print(o[0]["id"] if o else "")')
[ -n "$ORG" ] || { echo "✗ Buffer رفض المفتاح — اتأكد إنك نسخته كامل"; exit 1; }
CH=$(curl -s https://api.buffer.com -H 'content-type: application/json' -H "authorization: Bearer $KEY" \
  -d "{\"query\":\"query { channels(input: { organizationId: \\\"$ORG\\\" }) { name service } }\"}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); c=[x for x in (d.get("data") or {}).get("channels",[]) if "tiktok" in x["service"].lower()]; print(c[0]["name"] if c else "")')
[ -n "$CH" ] || { echo "✗ المفتاح شغال بس مفيش حساب تيك توك متربط في Buffer"; exit 1; }
printf %s "$KEY" | gh secret set BUFFER_API_KEY -R "$REPO"
printf '' | pbcopy
echo "✓ تيك توك اتربط عن طريق Buffer — الحساب: $CH"
echo "  من النهارده كل شورت هينزل على تيك توك لوحده في ميعاده المثالي"
