# فتح النشر العلني التلقائي: خطوتين عليك (مجانيين)

## 1) حوّل التطبيق لـ Production (عشان الربط ميقفش بعد 7 أيام)
1. افتح: https://console.cloud.google.com/auth/audience?project=serelbrand-studio
2. تحت **Publishing status: Testing**، دوس **Publish app**، وبعدين **Confirm**.
3. بعدها شغّل الربط من جديد مرة واحدة (التصريح القديم اتعمل في وضع Testing):
   ```bash
   cd ~/Desktop/youtube-ai-studio && npm run cli -- youtube:auth --client ~/Downloads/client_secret_*.json
   ```
   لو كنت مسحت ملف `client_secret` من Downloads، نزّله تاني من **Clients ← studio ← Download JSON**.
   جوجل هيقولك "Google hasn't verified this app"، ودي حاجة عادية لأنه تطبيقك إنت. دوس **Advanced**، وبعدين **Go to Ser El Brand Studio**.

## 2) مراجعة YouTube API (عشان YouTube يسمح بالنشر العلني من النظام)
لحد ما المراجعة دي تخلص، YouTube بيقفل أي فيديو بيترفع من النظام على **private**. ده قرار YouTube، والنظام هيبلّغك لو حصل.

1. افتح الفورم: https://support.google.com/youtube/contact/yt_api_form
2. املاه بالبيانات دي. الفورم بالإنجليزي، فانسخ الإجابات كما هي:

| الخانة | الإجابة |
|---|---|
| API Client / Project number | `528338760981` |
| Project ID | `serelbrand-studio` |
| Channel | https://www.youtube.com/channel/UCC0OhGT02h4t-iZVn1wPa6w |
| Which API services | YouTube Data API v3, YouTube Analytics API |
| Who uses the app | Only me, the channel owner (internal tool, single channel) |

**Use case / description (انسخه):**
```
"Ser El Brand Studio" is a private, single-user desktop tool that I (the channel owner) run on my own computer to manage my own YouTube channel "سر البراند" (Arabic business-history stories).
It uses:
- videos.insert to upload videos I produce (original narration and graphics, licensed Pixabay footage credited in the description),
- thumbnails.set and captions.insert to add the thumbnail and Arabic captions,
- YouTube Analytics API (read-only) to see my own videos' performance.
Every video passes automated quality, copyright and fact-checking gates (sources are listed in each description) before upload. AI-generated narration is disclosed with the "altered or synthetic content" flag (status.containsSyntheticMedia).
The tool only accesses my own channel, stores tokens locally on my machine, shares no data with third parties, and uploads at most ~4 videos per day (1 long video + up to 3 Shorts).
```

3. لو طلبوا صور أو فيديو للتطبيق، قولّي وأجهزهملك من لوحة التحكم.
4. الرد بياخد عادة من أيام لأسابيع، وبيوصلك على الإيميل.

## بعد الموافقة
مش محتاج تعمل حاجة تانية. النظام هيبدأ ينشر علني تلقائياً في أحسن موعد، للفيديوهات اللي بتعدّي **كل** الفحوصات بس.
