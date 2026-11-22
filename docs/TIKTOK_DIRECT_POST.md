# طلب النشر المباشر على تيك توك (من غير Buffer)

**الهدف:** «سر الموبايل» ينشر على `@ser.mobile` مباشرةً، من غير حد الـ 10 منشورات بتاع Buffer، ومن غير أي تداخل مع كادر كورة.

**المدة:** إنشاء التطبيق حوالي 20 دقيقة، ومراجعة تيك توك عادةً من كام يوم لأسبوعين.

**قبل الموافقة:** التطبيق بيشتغل، بس أي فيديو بينزل **خاص (Private)**. عشان كده هنفضل على Buffer لحد ما تيجي الموافقة، وبعدها ننقل.

---

## الخطوة 1: حساب المطوّر
1. ادخل على **developers.tiktok.com** وسجّل دخول **بحساب تيك توك `@ser.mobile`** نفسه.
2. لو طلب منك تعمل "Organization"، اعمله باسم: `Ser El Mobile`.

## الخطوة 2: إنشاء التطبيق
**Manage apps ← Connect an app**، واملا البيانات دي:

| الخانة | اكتب |
|---|---|
| App name | `Ser El Mobile Publisher` |
| Category | `Utilities` (أو `Entertainment` لو مش موجودة) |
| Description | `Publishes the Ser El Mobile channel's own short videos (phone tips in Egyptian Arabic) to its own TikTok account after the owner approves each video.` |
| Terms of Service URL | `https://ser-mobile-bot.matwee79.workers.dev/terms` |
| Privacy Policy URL | `https://ser-mobile-bot.matwee79.workers.dev/privacy` |
| Platform | **Web** |
| Website URL | `https://ser-mobile-bot.matwee79.workers.dev/` |
| App icon | لوجو القناة (1024×1024) |

> ⚠️ الصفحات الـ 3 دي اتعملت، وهتشتغل أول ما البوت يتحدّث (محتاج `npx wrangler login`).

## الخطوة 3: إثبات ملكية الموقع
تيك توك هيطلب إثبات إن الموقع بتاعك (**URL properties ← Verify**):
1. اختار **URL prefix** واكتب: `https://ser-mobile-bot.matwee79.workers.dev/`
2. هيديك **ملف** اسمه شبه `tiktokXXXX.txt` وجواه كود.
3. **ابعتلي اسم الملف والكود** وأنا أحطهم في البوت، وبعدها دوس **Verify**.

## الخطوة 4: المنتجات والصلاحيات
**Add products:**
- ✅ **Login Kit**
- ✅ **Content Posting API**، وفعّل جواها **Direct Post**

**Scopes:**
- `user.info.basic`
- `video.upload`
- `video.publish`

**Redirect URI (Login Kit):** `https://ser-mobile-bot.matwee79.workers.dev/tiktok/callback`

## الخطوة 5: طلب المراجعة (Submit for review)
في خانة **"Explain how each product and scope works in your app"** اكتب:

```
Ser El Mobile Publisher is a private tool used only by the owner of the TikTok account @ser.mobile.
It publishes the channel's own original short videos (phone tips in Egyptian Arabic, made by the channel).

- Login Kit + user.info.basic: the owner logs in once; we show the account's display name and avatar on the
  approval page so the owner always sees which account will post.
- video.upload + video.publish (Content Posting API, Direct Post): for each new video, the owner opens the
  approval page, watches the preview, edits the caption, chooses the privacy level (no default), sets
  comments / duet / stitch, sets the content disclosure if needed, accepts TikTok's Music Usage Confirmation,
  and taps Post. Only then is the video published to @ser.mobile.

No other users can log in. No data is shared with third parties. Videos are AI-assisted and labelled as AI-generated.
```

**فيديو الشرح (Demo video):** تيك توك بتطلب فيديو قصير يوضّح الخطوات كلها. **أنا هسجّله** بعد ما أعمل صفحة الموافقة (الخطوة الجاية).

---

## اللي هعمله أنا

| | |
|---|---|
| ✅ | صفحات الموقع والخصوصية والشروط (جاهزين، ومستنيين تحديث البوت) |
| ✅ | مكان ملف إثبات الملكية في البوت |
| ⏳ | **صفحة موافقة** فيها اللي تيك توك بتطلبه: اسم الحساب، معاينة الفيديو، اختيار الخصوصية، التعليقات والدويتو والستيتش، الإفصاح، وزرار «انشر» |
| ⏳ | تسجيل **فيديو الشرح** للمراجعة |
| ⏳ | بعد الموافقة: أربط المفتاح وأنقل النشر من Buffer للمباشر، وأتأكد إن أول فيديو نزل عام |

## ⚠️ حاجة لازم تعرفها
تيك توك **بتشترط إن صاحب الحساب يوافق على كل فيديو بنفسه** في النشر المباشر: يشوفه، ويختار الخصوصية، ويدوس «انشر». مش مسموح يتنشر أوتوماتيك 100% من غير ما حد يدوس.

عشان كده صفحة الموافقة هتبقى **ضغطة واحدة من تيليجرام**: يوصلك الفيديو بالإعدادات جاهزة، تدوس «انشر» وخلاص. ولو مش عايز تدوس على كل فيديو، يبقى Buffer أنسب، لأنه بيدير الموافقات دي بنفسه.
