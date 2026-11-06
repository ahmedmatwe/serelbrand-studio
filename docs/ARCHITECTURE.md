# YouTube AI Studio: المعمارية وخطة التنفيذ

> الحالة: المراحل 1 لـ 4b خلصت (2026-11-06) بتكلفة صفر. المرحلة الجاية: 5 (ربط YouTube OAuth ورفع private بس).
> تاريخ: 2026-11-06

---

## 1. نتيجة فحص البيئة

| الأداة | الحالة | ملاحظة |
|---|---|---|
| Node.js | v24.19.0 ✅ | حديث، فيه `node:sqlite` و`node --test` مدمجين |
| npm | 11.17.0 ✅ | |
| Python | 3.9.6 ⚠️ | قديم (انتهى دعمه)، لن نعتمد عليه |
| SQLite | 3.54 ✅ | |
| Git | 2.54 ✅ | |
| FFmpeg | ❌ غير موجود | سنستخدم حزمة `ffmpeg-static` من npm (بدون Homebrew) |
| Homebrew | ❌ غير موجود | غير مطلوب |
| خطوط عربية | Baghdad, Damascus, Nadeem ✅ | للصور المصغّرة والترجمة؛ يُفضَّل إضافة خط مفتوح مثل Cairo أو Tajawal |

الفولدر كان فاضي، يعني مشروع جديد من الصفر.

## 2. قرار اللغة: TypeScript على Node 24

- Node 24 حديث ومثبّت. Python 3.9 قديم ويحتاج تثبيت إصدار جديد.
- `node:sqlite` مدمج، فلا نحتاج مكتبات قاعدة بيانات native في الـMVP.
- `node --test` مدمج للاختبارات.
- مكتبات YouTube وOpenAI وAnthropic وElevenLabs الرسمية متوفرة لـTS.
- الأنواع (types) تمنع أخطاء كثيرة في تمرير البيانات بين الوكلاء.

## 3. الافتراضات (يتم تعديلها بعد ردّك)

| البند | الافتراض |
|---|---|
| اسم القناة | `[لم يُحدد]`، ونستخدم اسماً مؤقتاً في الإعدادات |
| الدول | مصر، السعودية، الإمارات، الكويت، المغرب (أولوية لمصر والخليج لأن الـRPM فيهما أعلى) |
| الجمهور | 18–34 سنة، الجنسين، مهتمون بالمعرفة والقصص والتقنية |
| الصيغة | الاثنين: فيديو طويل (8–12 دقيقة) + Shorts مستخرجة منه |
| معدل النشر | 2 فيديو طويل + 4 Shorts أسبوعياً |
| الميزانية | **صفر**: أدوات مجانية بس |
| الأسلوب | وثائقي/تعليمي قصصي (faceless بدون ظهور وجه) |
| المنافسون | سيتم تحليلهم عند توفر الروابط |
| مزود LLM | **Gemini free tier** (تكلفة صفر)، واسم الموديل بيتغير من `.env` |

## 4. المعمارية العامة

```
                         ┌──────────────────────────┐
                         │   CLI / Dashboard (HTML)  │
                         └────────────┬─────────────┘
                                      │
                         ┌────────────▼─────────────┐
                         │     Orchestrator Agent    │
                         │ (workflows + state machine)│
                         └────────────┬─────────────┘
           ┌──────────────┬───────────┼────────────┬───────────────┐
           ▼              ▼           ▼            ▼               ▼
     Research layer   Creation     Production   Gatekeeping     Growth loop
     ─────────────    ────────     ──────────   ───────────     ───────────
     Niche Selector   Strategy     Production   Fact-Check      Analytics
     Trend Research   Script       Rendering    Compliance      Optimization
                      Thumbnail    Shorts       Quality QA      Knowledge Base
                      SEO/Packaging             Human Approval  Experiments
                                                     │
                                                     ▼
                                               Publisher (YouTube)
           ─────────────────────────────────────────────────────────────
           Providers (قابلة للاستبدال، ولكل واحد نسخة Mock):
           LLM · TTS · Image · Video · Stock · Subtitles · FFmpeg · YouTube Data/Analytics · Trends
           ─────────────────────────────────────────────────────────────
           Core: Config · Logger(redaction) · DB(Repository) · Job Queue · Scheduler
                 Retry/RateLimit · Cost Tracker · Audit Log · Agent Pause Switches
```

### مبادئ التصميم
1. **كل وكيل وحدة مستقلة**: له input/output بأنواع محددة (Zod schemas) ويمكن إعادة تشغيله لوحده.
2. **Providers خلف Interfaces**: مثلاً `TTSProvider` له `MockTTS` و`ElevenLabsTTS`. التبديل يتم من الإعدادات.
3. **Dry-Run افتراضي**: لا يحدث أي اتصال خارجي مدفوع ولا رفع حقيقي إلا بتفعيل صريح.
4. **بوابات إلزامية قبل النشر**: Fact-Check ثم Compliance (90 أو أكثر) ثم Quality (85 أو أكثر) ثم موافقة بشرية.
5. **كل خطوة Job في Queue**: تُحفظ حالتها في DB، وتدعم retry وإعادة التشغيل والإيقاف المؤقت.
6. **Audit log لكل قرار**: من فعل ماذا، ومتى، وبأي تكلفة.

## 5. الوكلاء: المدخلات والمخرجات

| # | الوكيل | المدخل | المخرج الأساسي |
|---|---|---|---|
| 0 | **Niche Selector** | معلومات القناة | تقييم 10+ نيتشات على 14 معياراً (0–100)، ثم أفضل 3، ثم نيتش أساسي + 2 احتياطي + نسبة ثقة |
| 1 | **Trend Research** | النيتش | قائمة أفكار بـ Opportunity Score وتحليل الفجوات |
| 2 | **Content Strategy** | الأفكار | أعمدة المحتوى (pillars)، السلاسل، وتقويم 30/60/90 يوم |
| 3 | **Scriptwriting** | Brief | سكريبت عربي: 3 hooks و5 عناوين ومشاهد و CTA وعدد الكلمات والمدة |
| 4 | **Fact-Checking** | السكريبت | جدول الادعاءات: المصدر والتاريخ والثقة وهل يحتاج مراجعة بشرية |
| 5 | **Production Planner** | السكريبت | Blueprint مشهد بمشهد (صوت، صورة، prompt، حركة، موسيقى، انتقال) |
| 6 | **Thumbnail** | السكريبت + العنوان | 3–5 مفاهيم + توليد صور (عند التفعيل) |
| 7 | **SEO & Packaging** | كل ما سبق | العنوان والوصف والكلمات المفتاحية والفصول والتعليق المثبت والـplaylist |
| 8 | **Rendering** | Blueprint + أصول | ملف MP4 + SRT + Shorts عمودية |
| 9 | **Compliance** | الفيديو + الميتاداتا | Compliance Score وتصنيف المخاطر وإفصاح المحتوى الاصطناعي |
| 10 | **Quality QA** | كل شيء | Quality Score وتقرير ما قبل النشر |
| 11 | **Publisher** | فيديو مُعتمد | رفع **private/unlisted** أو جدولة، مع retry ولوج |
| 12 | **Analytics** | Video ID | لقطات أداء عند 1س و6س و24س و72س و7 أيام و28 يوم |
| 13 | **Optimization** | التحليلات + KB | توصيات مع درجة ثقة، وتجارب A/B (متغير واحد في كل مرة) |

## 6. هيكل الملفات المقترح

```
youtube-ai-studio/
├── .env.example
├── package.json / tsconfig.json
├── config/
│   ├── channel.yaml            # معلومات القناة والافتراضات
│   └── thresholds.yaml         # حدود الجودة والامتثال والميزانية
├── src/
│   ├── core/                   # config, logger, errors, retry, rate-limit, cost, audit
│   ├── database/               # schema.sql, migrations, repositories (SQLite ثم PostgreSQL)
│   ├── queue/                  # job queue + scheduler + pause switches
│   ├── providers/
│   │   ├── llm/      (mock, anthropic)
│   │   ├── tts/      (mock, elevenlabs/azure)
│   │   ├── image/    (mock, ...)
│   │   ├── video/    (mock, ...)
│   │   ├── stock/    (mock, pexels/pixabay)
│   │   ├── subtitles/(mock, whisper)
│   │   ├── trends/   (mock, youtube search, google trends)
│   │   └── youtube/  (mock, data-api, analytics-api)
│   ├── agents/                 # وكيل واحد لكل ملف + schemas
│   ├── workflows/              # daily, niche-selection, produce-video, post-publish
│   ├── media/                  # ffmpeg wrappers, shorts cutter, subtitle burn
│   ├── publishing/             # approval flow + uploader
│   ├── analytics/              # snapshots, diagnostics, experiments
│   ├── knowledge/              # knowledge base
│   ├── reports/                # مولّد تقارير HTML/Markdown
│   └── cli/                    # أوامر: run, approve, pause, rerun, report
├── prompts/                    # prompts الوكلاء كملفات منفصلة (عربي/إنجليزي)
├── tests/unit/ · tests/integration/
├── data/                       # sqlite + أصول مولّدة (خارج git)
├── reports/                    # التقارير المولّدة
├── scripts/                    # setup, seed, demo
└── docs/
```

## 7. الخدمات والـAPIs المطلوبة

| الخدمة | الغرض | متى نحتاجها | التكلفة التقريبية |
|---|---|---|---|
| **Anthropic API** | كل الوكلاء النصيين | المرحلة 3 | 20–50$ شهرياً حسب الحجم |
| **YouTube Data API v3** (OAuth) | الرفع والجدولة والـplaylists والبحث | المرحلة 5 | مجاني (حصة 10,000 وحدة يومياً، والرفع الواحد ~1,600) |
| **YouTube Analytics API** | الأداء والـretention والإيرادات | المرحلة 6 | مجاني |
| **TTS عربي** (ElevenLabs أو Azure Speech) | التعليق الصوتي | المرحلة 4 | 5–22$ شهرياً |
| **صور** (مولّد صور AI) | المشاهد والصورة المصغّرة | المرحلة 4 | 10–30$ شهرياً |
| **Pexels / Pixabay** | فيديوهات stock مرخّصة | المرحلة 4 | مجاني |
| **Whisper** (محلي أو API) | ترجمة دقيقة متزامنة | المرحلة 4 | مجاني محلياً |
| **FFmpeg** (`ffmpeg-static`) | المونتاج والـrender | المرحلة 4 | مجاني |
| **Telegram Bot** (اختياري) | إرسال طلب الموافقة على الموبايل | المرحلة 5 | مجاني |

> **ملاحظة امتثال:** YouTube يشترط الإفصاح عن المحتوى الاصطناعي الواقعي (altered/synthetic). النظام سيضبط علامة الإفصاح تلقائياً عند استخدام صوت أو صور AI واقعية.

## 8. محلي مقابل خارجي

**يعمل محلياً بدون أي مفاتيح (الـMVP):**
الإعدادات، وقاعدة البيانات، والـQueue، والـScheduler، والـLogger، وتتبع التكلفة، وكل الوكلاء عبر Mock LLM، ومحرك تقييم النيتشات، وفحوص الامتثال والجودة (قواعد ثابتة)، والتقارير، والـCLI، وتدفق الموافقة، و Mock YouTube، و Mock Analytics.

**يحتاج تكاملاً خارجياً (يُضاف تدريجياً):**
توليد النص الحقيقي، والصوت، والصور، والـstock، والرفع، والتحليلات الحقيقية، وبيانات الترندات.

## 9. خطة التنفيذ على مراحل

| المرحلة | المحتوى | معيار الانتهاء |
|---|---|---|
| **0** ✅ | فحص البيئة والمعمارية (هذه الوثيقة) | موافقتك |
| **1** ✅ | الأساس: config و`.env.example` والـlogger مع إخفاء الأسرار والـDB schema والـrepositories والـqueue والـretry وتتبع التكلفة والـaudit وإيقاف الوكلاء | اختبارات unit ناجحة |
| **2** ✅ | الوكلاء بـMock providers + Niche Selector (تقرير 10 نيتشات) + Compliance/Quality gates | تشغيل كل وكيل منفرداً |
| **3** ✅ | **Workflow كامل Dry-Run**: فكرة، ثم سكريبت، ثم تدقيق، ثم خطة إنتاج، ثم ميتاداتا، ثم تقرير ما قبل النشر، ثم موافقة، ثم Mock upload، ثم Mock analytics | تقرير اختبار HTML + اختبار integration |
| **4a** ✅ | Gemini مجاني (free tier) + صوت macOS المجاني + FFmpeg (والعربي في الترجمة اتأكد إنه بيظهر صح) | اختبارات Gemini والصوت |
| **4b** ✅ | Render: بطاقات نصية ورسوم بالكود + صوت + ترجمة ASS، ثم MP4، ثم Shorts عمودية | أول فيديو حقيقي محلي (لا يُنشر) |
| **4c** ✅ | لقطات Pexels مجانية (فيديو، وصور بحركة Ken Burns، وبطاقات لو ملقاش) + credits تلقائية + إصلاح اتجاه النص العربي | اختبارات Pexels + render بلقطات |
| **5** ✅ (كود) | YouTube OAuth: رفع **private فقط** + جدولة + موافقة عبر CLI أو Telegram | فيديو private على قناتك |
| **6** | التحليلات الحقيقية والـOptimization والـKnowledge Base والتجارب وتقارير يومية وأسبوعية وشهرية | تقرير أسبوعي حقيقي |
| **7** | لوحة تحكم HTML بسيطة + جاهزية PostgreSQL | |

> **قاعدة ثابتة:** لا نشر **public** إلا بأمر موافقة صريح منك. هذا مفعّل في الكود وليس مجرد إعداد.

## 10. المخاطر الحالية

- **محتوى AI متكرر قليل القيمة:** YouTube يرفض تحقيق الدخل من "inauthentic/repetitive content". العلاج: نيتش يسمح بقيمة أصلية، وبحث حقيقي، ومراجعة بشرية، ولمسة شخصية في الأسلوب.
- **دقة الحقائق:** الـLLM قد يختلق مصادر. لذلك الـFact-Checker لا يقبل مصدراً بدون رابط فعلي، وأي ادعاء غير مؤكد يوقف النشر.
- **حصة YouTube API:** حوالي 6 رفعات يومياً كحد أقصى بالحصة الافتراضية.
- **جودة الصوت العربي:** تختلف كثيراً بين المزودين، ويُفضَّل اختبار 2–3 أصوات قبل الاعتماد.
- **لا ضمانات:** لا يمكن ضمان مشاهدات أو قبول في برنامج الشركاء أو أرباح.
