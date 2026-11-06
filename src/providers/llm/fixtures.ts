/**
 * Offline fixtures for MockLLM. Content is illustrative sample output only.
 * Sources here use the `mock://` scheme on purpose: the fact-checker treats them as
 * NOT verified, so a dry run can never be mistaken for a fact-checked video.
 */
import type { MockFixture } from './mock.ts';

const scenes = [
  {
    n: 1,
    purpose: 'Hook',
    voiceover:
      'في بداية الألفينات، كان تقريباً واحد من كل ثلاثة موبايلات في العالم بيحمل اسم شركة واحدة. شركة بدأت بتصنيع الورق في فنلندا، ووصلت إنها تبقى ملكة الهواتف. بعد سنين قليلة، اتباع قسم الموبايلات بتاعها كله. إيه اللي حصل في النص؟',
    onScreenText: 'من القمة… للبيع',
    curiosityGap: 'إزاي شركة بالحجم ده تخسر كل حاجة بالسرعة دي؟',
    transition: 'قطع سريع على صوت رنة نوكيا الشهيرة',
  },
  {
    n: 2,
    purpose: 'Context: from paper to phones',
    voiceover:
      'القصة بتبدأ سنة ١٨٦٥ بمصنع ورق صغير جنب نهر في فنلندا. على مدار أكتر من مية سنة، الشركة اشتغلت في الكاوتش والكابلات والإلكترونيات، لحد ما قررت في التسعينات تركز على حاجة واحدة بس: الاتصالات المحمولة. القرار ده كان جريء جداً، وكان بداية الصعود.',
    onScreenText: '١٨٦٥ — مصنع ورق',
    transition: 'خط زمني متحرك',
  },
  {
    n: 3,
    purpose: 'Peak',
    voiceover:
      'في ذروتها، نوكيا كانت أكبر شركة مصنعة للموبايلات في العالم. موبايلاتها كانت معروفة بإنها بتستحمل أي حاجة، وبطاريتها بتقعد أيام. لكن تحت السطح، كان فيه مشكلة بتكبر: نظام التشغيل.',
    onScreenText: 'رقم ١ عالمياً',
    curiosityGap: 'المشكلة مكانتش في الموبايل نفسه…',
    transition: 'زووم على شاشة موبايل قديم',
  },
  {
    n: 4,
    purpose: 'Turning point: 2007',
    voiceover:
      'سنة ٢٠٠٧، أبل أعلنت عن الآيفون. وبعدها بشوية بدأت موبايلات أندرويد تنتشر. اللعبة اتغيرت: الناس بقت بتشتري تجربة وبرامج ومتجر تطبيقات، مش بس جهاز قوي. ونوكيا كانت لسه متمسكة بنظام سيمبيان.',
    onScreenText: '٢٠٠٧: قواعد اللعبة اتغيرت',
    transition: 'شاشة مقسومة بين عصرين',
  },
  {
    n: 5,
    purpose: 'The fall',
    voiceover:
      'سنة ٢٠١١ نوكيا اختارت تتحالف مع مايكروسوفت وتعتمد ويندوز فون. البعض شاف القرار ده متأخر، والبعض شافه رهان غلط. وفي ٢٠١٣ اتعلن إن مايكروسوفت هتشتري قسم الأجهزة والخدمات بتاع نوكيا.',
    onScreenText: 'رهان متأخر؟',
    transition: 'إطفاء تدريجي للإضاءة',
  },
  {
    n: 6,
    purpose: 'Lesson + CTA',
    voiceover:
      'الدرس هنا مش إن نوكيا كانت شركة ضعيفة. بالعكس، كانت من أقوى الشركات في العالم. الدرس إن النجاح في سوق معين ممكن يخليك تتأخر في فهم السوق الجديد. ولو عاوز تعرف إزاي شركات تانية قدرت تنجو من لحظة زي دي، الحلقة الجاية هتحكيلك.',
    onScreenText: 'النجاح ممكن يعمي',
    transition: 'نهاية بشاشة الفيديو التالي',
  },
];

export const MOCK_FIXTURES: Record<string, MockFixture> = {
  'trends.ideas': () => ({
    ideas: [
      {
        title: 'قصة نوكيا: إزاي خسرت أكبر شركة موبايلات في العالم؟',
        angle: 'قرارات إدارية في لحظة تحول السوق',
        seedQuery: 'قصة نوكيا',
        targetAudience: 'شباب 18–34 مهتمين بالبيزنس والتقنية',
        searchIntent: 'curiosity',
        trendStatus: 'evergreen',
        competition: 'medium',
        monetization: 'high',
        copyrightRisk: 'low',
        policyRisk: 'low',
        recommendedFormat: 'both',
        emotionalTrigger: 'الحنين + الدهشة من السقوط',
        contentGap: 'أغلب الفيديوهات العربية سطحية ومفيش تحليل للقرارات نفسها',
        explanation: 'موضوع معروف وفيه حنين، ويتحول لسلسلة "شركات سقطت".',
      },
      {
        title: 'ليه أغلب المطاعم الجديدة بتقفل في أول سنتين؟',
        angle: 'اقتصاد المشاريع الصغيرة في الوطن العربي',
        seedQuery: 'ليه المطاعم بتقفل',
        targetAudience: 'رواد أعمال مبتدئين',
        searchIntent: 'problem-solving',
        trendStatus: 'stable',
        competition: 'low',
        monetization: 'high',
        copyrightRisk: 'low',
        policyRisk: 'low',
        recommendedFormat: 'long',
        emotionalTrigger: 'الخوف من الخسارة',
        contentGap: 'محتوى قليل بأرقام محلية',
        explanation: 'سؤال عملي يتكرر، ومناسب للرعاة في مجال البرامج المحاسبية.',
      },
      {
        title: 'العلامة التجارية اللي اتولدت من غلطة',
        angle: 'قصص منتجات اكتُشفت بالصدفة',
        seedQuery: 'منتجات اكتشفت بالصدفة',
        targetAudience: 'جمهور عام',
        searchIntent: 'entertainment',
        trendStatus: 'evergreen',
        competition: 'high',
        monetization: 'medium',
        copyrightRisk: 'low',
        policyRisk: 'low',
        recommendedFormat: 'short',
        emotionalTrigger: 'الفضول',
        contentGap: 'Shorts عربية قليلة بتحقيق دقيق',
        explanation: 'مناسب جداً للـShorts وكل قصة تقف لوحدها.',
      },
    ],
  }),

  'strategy.plan': () => ({
    pillars: [
      { name: 'شركات سقطت', description: 'تحليل قرارات أدت لسقوط شركات كبيرة', share: 0.4 },
      { name: 'قصص نجاح عربية', description: 'شركات ومشاريع عربية ونموذج عملها', share: 0.35 },
      { name: 'اقتصاد يومي مبسط', description: 'ليه الأسعار بتعلى؟ إزاي الشركات بتكسب؟', share: 0.25 },
    ],
    series: [
      { name: 'لحظة السقوط', pillar: 'شركات سقطت', episodes: ['نوكيا', 'بلاكبيري', 'كوداك', 'ياهو'] },
      { name: 'من الصفر', pillar: 'قصص نجاح عربية', episodes: ['أرامكس', 'كريم', 'أنغامي'] },
    ],
    backlog: [
      { title: 'قصة نوكيا: إزاي خسرت أكبر شركة موبايلات في العالم؟', pillar: 'شركات سقطت', kind: 'evergreen', shortsAngles: ['رنة نوكيا', 'قرار ٢٠١١'] },
      { title: 'كوداك اخترعت الكاميرا الرقمية… وخسرت بسببها', pillar: 'شركات سقطت', kind: 'evergreen', shortsAngles: ['أول كاميرا رقمية'] },
      { title: 'ليه أغلب المطاعم الجديدة بتقفل في أول سنتين؟', pillar: 'اقتصاد يومي مبسط', kind: 'evergreen', shortsAngles: ['أكبر 3 أخطاء'] },
      { title: 'إزاي كريم بقت شركة بمليارات؟', pillar: 'قصص نجاح عربية', kind: 'evergreen', shortsAngles: ['الفكرة الأولى'] },
      { title: 'ليه سعر القهوة بيعلى كل سنة؟', pillar: 'اقتصاد يومي مبسط', kind: 'trending', shortsAngles: ['من المزرعة للكوباية'] },
      { title: 'بلاكبيري: من رمز للنفوذ لذكرى', pillar: 'شركات سقطت', kind: 'evergreen', shortsAngles: ['الكيبورد'] },
    ],
    experiments: [
      { hypothesis: 'العنوان بسؤال يرفع الـCTR مقارنة بالعنوان الخبري', variable: 'title_style', metric: 'ctr' },
      { hypothesis: 'Hook أقل من 15 ثانية يحسن الاحتفاظ في أول 30 ثانية', variable: 'hook_length', metric: 'retention_30s' },
    ],
  }),

  'brief.create': () => ({
    centralIdea: 'نوكيا كانت ملكة الموبايلات وخسرت كل حاجة لأنها اتأخرت في فهم السوق الجديد.',
    promise: 'هتفهم القرارات اللي خسّرت نوكيا السوق، والدرس اللي ينفعك في شغلك.',
    bigQuestion: 'إزاي شركة كانت في كل جيب تقريباً خسرت كل حاجة في سنين قليلة؟',
    emotions: ['الحنين', 'الدهشة'],
    targetViewer: 'شباب 18–34 في مصر والخليج مهتمين بالبيزنس والتقنية',
    clickReason: 'الحنين لنوكيا والفضول لمعرفة سبب السقوط',
    stayReason: 'القصة متصاعدة وكل جزء بيفتح سؤال جديد',
    twist: 'الشركة مكانتش ضعيفة تقنياً، المشكلة كانت في توقيت القرار',
    cta: 'قولّي في الكومنتات: أنهي شركة نحكي قصتها المرة الجاية؟',
    uniqueAngle: 'تحليل القرارات نفسها بدل سرد التاريخ',
    titles: [
      ['قصة نوكيا: إزاي خسرت أكبر شركة موبايلات في العالم؟', 'curiosity'], ['نوكيا: من القمة للبيع في سنين قليلة', 'curiosity'],
      ['الغلطة اللي خسّرت نوكيا السوق', 'shock'], ['ليه نوكيا مقدرتش تنافس الآيفون؟', 'shock'],
      ['درس نوكيا: النجاح ممكن يعمي الشركات', 'educational'], ['إزاي بتسقط الشركات العملاقة؟ نوكيا مثال', 'educational'],
      ['الموبايل اللي كان في إيد كل الناس… راح فين؟', 'emotional'], ['نوكيا: حكاية شركة كلنا حبيناها', 'emotional'],
      ['3 قرارات خسّرت نوكيا كل حاجة', 'number'], ['من 1865 لـ 2013: رحلة نوكيا', 'number'],
      ['سقوط نوكيا', 'seo'], ['قصة شركة نوكيا', 'seo'],
    ].map(([title, type], i) => ({ title, type, psychology: 'الفضول والحنين', strength: 9 - (i % 4), bestFor: i % 3 === 0 ? 'both' : i % 3 === 1 ? 'suggested' : 'search' })),
    best3: ['قصة نوكيا: إزاي خسرت أكبر شركة موبايلات في العالم؟', 'الغلطة اللي خسّرت نوكيا السوق', '3 قرارات خسّرت نوكيا كل حاجة'],
    claimsToVerify: [{ claim: 'نوكيا تأسست 1865', kind: 'fact', sourceType: 'Wikipedia / Britannica' }],
  }),

  'script.write': () => ({
    hooks: [
      'واحد من كل ثلاثة موبايلات في العالم كان نوكيا… فين راحت؟',
      'الشركة دي بدأت بمصنع ورق، ووصلت للقمة، وبعدين اتباعت. القصة كاملة.',
      'لو كان عندك نوكيا زمان، الفيديو ده هيجاوبك على سؤال عمرك ما سألته: إيه اللي حصل؟',
    ],
    mainTitle: 'قصة نوكيا: إزاي خسرت أكبر شركة موبايلات في العالم؟',
    altTitles: [
      'نوكيا: من القمة للبيع في سنين قليلة',
      'الغلطة اللي خسّرت نوكيا السوق',
      'ليه نوكيا مقدرتش تنافس الآيفون؟',
      'سقوط ملكة الموبايلات: قصة نوكيا',
      'نوكيا كانت رقم ١… وبعدين؟',
    ],
    opening: 'خليني أحكيلك قصة شركة كانت في كل جيب تقريباً، وإزاي قرار واحد في توقيت غلط غيّر كل حاجة.',
    scenes,
    cta: 'لو القصة عجبتك اشترك عشان تتابع سلسلة "لحظة السقوط"، وقولي في الكومنتات: أنهي شركة عاوزنا نحكي قصتها المرة الجاية؟',
    ending: 'نوكيا لسه موجودة النهاردة كشركة شبكات، بس قصة الموبايل هتفضل درس لكل شركة ناجحة.',
    nextVideoSuggestion: 'كوداك اخترعت الكاميرا الرقمية… وخسرت بسببها',
  }),

  // Offline: "expansion" returns the same script (mocks cannot write new content).
  'script.expand': (vars) => vars.previous,
  // Offline: the fixer cannot invent text, so it returns the script unchanged.
  'script.fixclaims': (vars) => vars.previous,
  'script.revise': (vars) => vars.previous,
  'script.smooth': (vars) => vars.previous,
  'seo.retitle': (vars) => vars.previous,
  'captions.translate': (vars) => ({ lines: ((vars.lines as string[]) ?? []).map((_, i) => `English caption ${i + 1}`) }),
  // Offline shot planner: generic but varied queries, one per sentence.
  'production.shots': (vars) => ({ queries: ((vars.sentences as string[]) ?? []).map((_, j) => ({ i: (vars.offset as number) + j, query: ['city skyline', 'office desk', 'old phones', 'warehouse boxes', 'people walking'][j % 5]! })) }),
  // Offline judge: never supports anything (no real evidence in dry-run).
  'factcheck.judge': () => ({ verdict: 'not_found', quote: '', correction: null }),

  'factcheck.claims': () => ({
    claims: [
      {
        claim: 'نوكيا تأسست سنة 1865 كمصنع ورق في فنلندا',
        sceneN: 2,
        type: 'fact',
        sourceUrl: 'mock://nokia.com/about-us/company/our-history',
        sourceTitle: 'Nokia — Our history (mock)',
        sourceDate: '2024-01-01',
        confidence: 'high',
        notes: 'معلومة معروفة؛ يلزم التحقق من الرابط الحقيقي.',
      },
      {
        claim: 'تقريباً واحد من كل ثلاثة موبايلات في العالم كان نوكيا في بداية الألفينات',
        sceneN: 1,
        type: 'statistic',
        sourceUrl: null,
        sourceTitle: null,
        sourceDate: null,
        confidence: 'medium',
        notes: 'الحصة السوقية تغيرت من سنة لسنة؛ لازم تحديد السنة والمصدر (Gartner/IDC).',
      },
      {
        claim: 'أبل أعلنت عن الآيفون سنة 2007',
        sceneN: 4,
        type: 'fact',
        sourceUrl: 'mock://apple.com/newsroom/2007/01/09',
        sourceTitle: 'Apple Reinvents the Phone with iPhone (mock)',
        sourceDate: '2007-01-09',
        confidence: 'high',
        notes: '',
      },
      {
        claim: 'نوكيا تحالفت مع مايكروسوفت في 2011 واعتمدت ويندوز فون',
        sceneN: 5,
        type: 'fact',
        sourceUrl: 'mock://news.microsoft.com/2011/02/11',
        sourceTitle: 'Nokia and Microsoft partnership (mock)',
        sourceDate: '2011-02-11',
        confidence: 'high',
        notes: '',
      },
      {
        claim: 'في 2013 اتعلن إن مايكروسوفت هتشتري قسم الأجهزة والخدمات',
        sceneN: 5,
        type: 'fact',
        sourceUrl: 'mock://news.microsoft.com/2013/09/03',
        sourceTitle: 'Microsoft to acquire Nokia Devices & Services (mock)',
        sourceDate: '2013-09-03',
        confidence: 'high',
        notes: 'الصفقة اكتملت في 2014.',
      },
      {
        claim: 'القرار كان رهان متأخر أو غلط',
        sceneN: 5,
        type: 'opinion',
        sourceUrl: null,
        sourceTitle: null,
        sourceDate: null,
        confidence: 'medium',
        notes: 'رأي محللين؛ لازم يتقدم كرأي مش حقيقة (والسكريبت بيقول "البعض شاف").',
      },
    ],
  }),

  'production.blueprint': () => ({
    scenes: scenes.map((s) => ({
      n: s.n,
      voiceover: s.voiceover,
      footage: ['هواتف قديمة على طاولة', 'نهر وغابة فنلندية', 'رسم بياني للحصة السوقية', 'هاتف لمس حديث', 'مكتب شركة بإضاءة خافتة', 'شخص يفكر أمام لوح'][s.n - 1]!,
      assetSource: (s.n === 3 ? 'original-graphic' : s.n % 2 === 0 ? 'stock' : 'generated') as 'generated' | 'stock' | 'original-graphic',
      visualPrompt: `Cinematic documentary still, scene ${s.n}, moody lighting, no logos, no real people, 16:9`,
      stockQuery: ['old mobile phones', 'finland river forest', 'business chart', 'smartphone touchscreen', 'empty office night', 'thinking whiteboard'][s.n - 1]!,
      onScreenText: s.onScreenText,
      motion: 'Ken Burns بطيء',
      sfx: s.n === 1 ? 'whoosh خفيف' : '',
      musicMood: s.n >= 5 ? 'حزين هادئ' : 'تشويق خفيف',
      transition: s.transition,
      subtitleNotes: 'سطرين بحد أقصى، خط عربي واضح',
      editingNotes: 'تجنب أي شعار حقيقي على الشاشة',
    })),
    music: { mood: 'وثائقي تشويقي', source: 'youtube-audio-library' },
    voice: { style: 'راوي هادئ واثق', pace: 'متوسط' },
  }),

  'thumbnail.concepts': () => ({
    concepts: [
      {
        mainVisual: 'هاتف كلاسيكي مكسور بشق في المنتصف',
        subject: 'الهاتف في المقدمة',
        background: 'أزرق داكن متدرج',
        palette: ['#0B1E3F', '#FFFFFF', '#FFD400'],
        text: 'من القمة للبيع',
        composition: 'الهاتف يسار، النص يمين',
        contrast: 'نص أصفر على خلفية داكنة',
        emotion: 'صدمة/حنين',
        ctrRationale: 'الشق يوحي بقصة سقوط بصرياً',
        accuracyNote: 'هاتف عام بدون شعار حقيقي',
      },
      {
        mainVisual: 'سهم رسم بياني صاعد ثم هابط بحدة',
        subject: 'السهم',
        background: 'أسود',
        palette: ['#000000', '#E53935', '#FFFFFF'],
        text: 'ليه وقعت؟',
        composition: 'السهم يغطي ثلثي الصورة',
        contrast: 'أحمر على أسود',
        emotion: 'فضول',
        ctrRationale: 'سؤال مباشر + رمز بصري واضح على الموبايل',
        accuracyNote: 'الرسم رمزي وليس بيانات دقيقة',
      },
      {
        mainVisual: 'هاتف قديم بجوار هاتف لمس حديث',
        subject: 'مقارنة جيلين',
        background: 'رمادي فاتح',
        palette: ['#ECEFF1', '#212121', '#00C853'],
        text: 'قرار واحد غيّر كل شيء',
        composition: 'تقسيم يسار/يمين',
        contrast: 'نص داكن عريض',
        emotion: 'دراما',
        ctrRationale: 'المقارنة تشرح القصة في ثانية',
        accuracyNote: 'العنوان يشير لتحول السوق، وهو موضوع الفيديو فعلاً',
      },
    ],
  }),

  'seo.package': () => ({
    primaryTitle: 'قصة نوكيا: إزاي خسرت أكبر شركة موبايلات في العالم؟',
    altTitles: [
      'نوكيا: من القمة للبيع في سنين قليلة',
      'الغلطة اللي خسّرت نوكيا السوق',
      'ليه نوكيا مقدرتش تنافس الآيفون؟',
      'سقوط ملكة الموبايلات: قصة نوكيا',
      'نوكيا كانت رقم ١… وبعدين؟',
    ],
    description:
      'نوكيا كانت أكبر شركة مصنعة للموبايلات في العالم، وبعد سنين قليلة اتباع قسم الموبايلات بتاعها. في الفيديو ده بنحكي القصة من مصنع الورق في فنلندا لحد صفقة مايكروسوفت، وبنحلل القرارات اللي غيرت مصير الشركة.',
    keywords: ['قصة نوكيا', 'سقوط نوكيا', 'نوكيا ومايكروسوفت', 'قصص شركات', 'تحليل بيزنس'],
    tags: ['نوكيا', 'Nokia', 'قصص شركات', 'بيزنس', 'تقنية'],
    hashtags: ['#نوكيا', '#قصص_شركات', '#لحظة_السقوط'],
    pinnedComment: 'أنهي شركة عاوزنا نحكي قصة سقوطها أو نجاحها في الحلقة الجاية؟ 👇',
    endScreen: 'فيديو كوداك + زر الاشتراك',
    playlist: 'لحظة السقوط',
    followUps: ['كوداك اخترعت الكاميرا الرقمية… وخسرت بسببها', 'بلاكبيري: من رمز للنفوذ لذكرى'],
  }),
};
