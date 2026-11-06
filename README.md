# YouTube AI Studio

نظام تشغيل محتوى يوتيوب بالذكاء الاصطناعي (عربي أولاً). بيبحث عن الأفكار، ويكتب السكريبت، ويدقق الحقائق،
ويجهز خطة الإنتاج والصور المصغّرة والـSEO، ويفحص الجودة والامتثال قبل أي نشر.

> **وضع Dry-Run مفعّل افتراضياً.** لا يوجد أي اتصال خارجي مدفوع ولا رفع حقيقي، ولا نشر علني بدون موافقتك.

## التشغيل

```bash
npm install
cp .env.example .env      # اختياري: الإعدادات الافتراضية آمنة
npm test                  # كل الاختبارات
npm run typecheck
```

## سيناريو كامل في وضع Dry-Run

```bash
npm run cli -- produce --title "قصة نوكيا"          # الإنتاج كامل لحد طلب الموافقة
npm run cli -- verify <videoId> 0 --url https://…   # تأكيد ادعاء بمصدر حقيقي
npm run cli -- review <videoId>                     # إعادة فحص الامتثال والجودة
npm run cli -- approve <approvalId> --accept-risks --note "السبب"
npm run cli -- publish <videoId>                    # رفع private (تجريبي)
npm run cli -- analytics <videoId> --hours 168      # التحليلات والتشخيص
npm run cli -- report <videoId>                     # reports/generated/<id>.html
npm run cli -- daily --niche business-stories       # بحث، ثم أفضل فكرة جديدة، ثم إنتاج
```

## الـRender المحلي (مجاني)

```bash
npm run cli -- produce --title "..." --render          # 1080p + Short عمودي + صورة مصغّرة + ترجمة SRT
npm run cli -- render <videoId> --preview              # نسخة سريعة 540p للمراجعة
```
الملفات بتتحفظ في `data/renders/<videoId>/`: ‏`video.mp4` و`short-1.mp4` و`thumbnail.png` و`captions.srt`.
الصوت الافتراضي هو **Charon** من Gemini: طبيعي ومجاني على نفس المفتاح (`TTS_PROVIDER=gemini`). لو الحد المجاني خلص في نص الفيديو، النظام بيعيد الفيديو كله بصوت ماجد عشان الصوتين ميتخلطوش. تقدر تغيّر الصوت من `GEMINI_TTS_VOICE`.

### لقطات مجانية (Pixabay، والبديل Pexels)
`STOCK_PROVIDER=pixabay` و`PIXABAY_API_KEY` (المفتاح موجود في https://pixabay.com/api/docs/ بعد تسجيل الدخول).

#### Pexels (إصدار مفاتيح جديدة متوقف حالياً)
1. اعمل حساب مجاني على https://www.pexels.com/api/ وخد المفتاح.
2. حط في `.env` بنفسك: `STOCK_PROVIDER=pexels` و`PEXELS_API_KEY=...` (ومعاهم `DRY_RUN=false`).

- لكل مشهد النظام بيدوّر على فيديو، ولو ملقاش بيدوّر على صورة بحركة Ken Burns، ولو ملقاش الاتنين بيرجع لبطاقة نصية.
- اللقطات بتتحفظ في `data/stock-cache/`، فمش بتتنزل مرتين.
- النظام بيحترم الحد المسموح (200 طلب في الساعة).
- أسماء أصحاب اللقطات ورابط Pexels بيتضافوا في وصف الفيديو تلقائياً، زي ما إرشادات الـAPI بتطلب.
- رخصة Pexels: الاستخدام مجاني ومسموح التعديل. الممنوع: إظهار أشخاص معروفين بشكل مسيء، أو إيحاء إن شخص أو علامة تجارية بيدعموا الفيديو. الفحص بيفكّرك تراجع ده.

## التشغيل التلقائي (Autopilot)

- **كل ساعتين** (عن طريق launchd في macOS): بيرفع الفيديوهات اللي اتوافق عليها (private)، ويسحب التحليلات، وفي أيام النشر حسب التقويم بيعمل فيديو طويل + لحد 3 Shorts، وبيبعتلك إشعار.
- **وضع التشغيل الكامل** (`AUTO_VERIFY=true` + `AUTO_APPROVE=true` + `ALLOW_PUBLIC_PUBLISHING=true`): بيدقق كل معلومة بمصادر حقيقية وباقتباس حرفي، والأرقام والإحصائيات لازم يأكدها موقعين مختلفين. اللي مش متأكد منه بيتشال من السكريبت. الفيديو بيتوافق عليه ويتجدول للنشر **بس لو عدّى كل الفحوصات** (جودة 85 أو أكتر، وامتثال 90 أو أكتر، ومعلومات مؤكدة كلها، وحقوق سليمة، وصوت سليم). غير كده بيقف وبيبعتلك إشعار.
- النشر العلني من الـAPI محتاج مراجعة مجانية من YouTube. الخطوات في [docs/YOUTUBE_AUDIT.md](docs/YOUTUBE_AUDIT.md).
- **لوحة التحكم:** دبل كليك على `لوحة التحكم.command` (أو `npm run cli -- dashboard`). منها بتأكد المصادر، وتتفرج على الفيديو والـShorts، وتوافق أو ترفض.
- التقرير اليومي في `reports/daily/`، والسجل في `data/logs/autopilot.log`.
- الأوامر: `schedule:status` · `schedule:run-now` · `schedule:remove` (عشان توقفه).
- حصة YouTube المجانية حوالي 10,000 وحدة في اليوم، يعني فيديو طويل + 3 Shorts تقريباً في اليوم كحد أقصى.

## الأوامر

```bash
npm run cli -- niche                                   # تقييم 12 نيتش + reports/niche-report.md
npm run cli -- trends --niche business-stories         # أفكار بـ Opportunity Score
npm run cli -- strategy --niche business-stories       # أعمدة + سلاسل + تقويم 30/60/90
npm run cli -- video:new --title "قصة نوكيا"
npm run cli -- run scriptwriter <videoId>              # وبعده: fact-checker, production-planner, thumbnail, seo, compliance, quality
npm run cli -- show <videoId> compliance_report
npm run cli -- pause <agent|*>  /  resume <agent|*>
npm run cli -- jobs  /  rerun --all  /  costs  /  audit
```

## المتطلبات (كلها مجانية)
- Node.js 24 أو أحدث (يشغّل TypeScript مباشرة، ويوفّر SQLite والاختبارات مدمجين)
- macOS: صوت "ماجد" العربي المدمج للتعليق الصوتي
- FFmpeg بيتثبّت تلقائياً من npm (`ffmpeg-static`). لو npm حذّر من الـinstall scripts: `npm approve-scripts ffmpeg-static`

## تشغيل Gemini المجاني
1. اعمل مفتاح مجاني (من غير كارت) من https://aistudio.google.com/apikey
2. انسخ `.env.example` لـ`.env`، وحط فيه بنفسك:
   ```
   DRY_RUN=false
   LLM_PROVIDER=gemini
   GEMINI_API_KEY=المفتاح_بتاعك
   TTS_PROVIDER=macos
   ```
   الرفع على YouTube يفضل تجريبي (`YOUTUBE_PROVIDER=mock`)، والنشر العلني مقفول.
3. شغّل: `npm run cli -- produce --title "..."`

> **ملاحظات:** حدود الـfree tier بتتغير من Google، فالنظام بيبطّأ نفسه (`LLM_RPM`) ويعيد المحاولة تلقائياً لما يوصل للحد.
> في الـfree tier، Google ممكن تستخدم المحتوى اللي بتبعته عشان تحسّن منتجاتها، فمتبعتش بيانات خاصة.
> المصادر اللي الموديل بيقترحها **عمرها ما بتتحسب مؤكدة تلقائياً**: افتح الرابط بنفسك، وبعدين `verify <videoId> <#>`.

## الهيكل
راجع [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
