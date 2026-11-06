/**
 * Candidate niches with 0–10 ratings per criterion.
 *
 * IMPORTANT: these ratings are *expert estimates* for an Arabic, faceless, documentary-style
 * channel (Nov 2026). They are a starting prior, not measured data. The Trend Research agent and
 * real YouTube/Trends data should replace them before committing long-term.
 *
 * Direction of every criterion: higher = better for the channel.
 * e.g. competition 9 = very LOW competition; productionCost 9 = very CHEAP to produce.
 */
export const CRITERIA = [
  'audienceDemand',
  'searchPotential',
  'trendPotential',
  'competition',
  'monetization',
  'advertiserFriendly',
  'productionCost',
  'productionSpeed',
  'copyrightSafety',
  'policySafety',
  'originality',
  'audienceLoyalty',
  'sponsorship',
  'seriesPotential',
] as const;
export type Criterion = (typeof CRITERIA)[number];

/** Weights sum to 100. Demand + monetization + safety dominate; pure trendiness is deliberately low. */
export const WEIGHTS: Record<Criterion, number> = {
  audienceDemand: 12,
  searchPotential: 9,
  trendPotential: 5,
  competition: 8,
  monetization: 11,
  advertiserFriendly: 9,
  productionCost: 6,
  productionSpeed: 5,
  copyrightSafety: 8,
  policySafety: 8,
  originality: 7,
  audienceLoyalty: 5,
  sponsorship: 4,
  seriesPotential: 3,
};

export const CRITERIA_AR: Record<Criterion, string> = {
  audienceDemand: 'الطلب',
  searchPotential: 'البحث',
  trendPotential: 'الترند',
  competition: 'قلة المنافسة',
  monetization: 'الربحية',
  advertiserFriendly: 'ملاءمة المعلنين',
  productionCost: 'رخص الإنتاج',
  productionSpeed: 'سرعة الإنتاج',
  copyrightSafety: 'أمان الحقوق',
  policySafety: 'أمان السياسات',
  originality: 'الأصالة',
  audienceLoyalty: 'ولاء الجمهور',
  sponsorship: 'الرعاة',
  seriesPotential: 'السلاسل',
};

export interface NicheCandidate {
  id: string;
  nameAr: string;
  nameEn: string;
  ratings: Record<Criterion, number>;
  pros: string[];
  cons: string[];
}

const r = (...v: number[]): Record<Criterion, number> =>
  Object.fromEntries(CRITERIA.map((c, i) => [c, v[i]!])) as Record<Criterion, number>;

export const NICHE_CANDIDATES: NicheCandidate[] = [
  {
    id: 'business-stories', nameAr: 'قصص الشركات والبيزنس', nameEn: 'Business & company stories',
    ratings: r(8, 8, 6, 6, 9, 9, 7, 7, 8, 9, 8, 8, 9, 10),
    pros: ['RPM مرتفع (جمهور مهتم بالمال والأعمال)', 'سلاسل لا نهائية (سقوط/نجاح/منافسة)', 'مناسب لأسلوب وثائقي بدون وجه', 'رعاة محتملون: بنوك رقمية، تطبيقات استثمار، أدوات SaaS'],
    cons: ['يحتاج بحث دقيق لكل قصة', 'تجنب شعارات الشركات المحمية في الصور المصغرة'],
  },
  {
    id: 'economy-explained', nameAr: 'الاقتصاد والمال المبسط', nameEn: 'Economics & personal finance explained',
    ratings: r(8, 9, 7, 5, 10, 8, 8, 7, 9, 6, 7, 8, 9, 8),
    pros: ['أعلى CPM في يوتيوب العربي', 'أسئلة بحث متكررة (التضخم، الذهب، الأسعار)'],
    cons: ['خطر "النصيحة المالية" وسياسات المحتوى المالي', 'محتوى الأسعار يتقادم بسرعة'],
  },
  {
    id: 'history', nameAr: 'التاريخ والحضارات', nameEn: 'History & civilizations',
    ratings: r(8, 7, 4, 5, 6, 7, 6, 6, 7, 7, 8, 8, 5, 10),
    pros: ['ولاء عالٍ ومشاهدة طويلة', 'محتوى دائم (evergreen)'],
    cons: ['منافسة عربية قوية', 'مواضيع قد تلمس حساسيات دينية/سياسية', 'RPM متوسط'],
  },
  {
    id: 'psychology', nameAr: 'علم النفس والسلوك اليومي', nameEn: 'Everyday psychology',
    ratings: r(9, 8, 6, 4, 7, 8, 8, 8, 9, 7, 7, 7, 6, 8),
    pros: ['طلب ضخم ومناسب للـShorts', 'إنتاج سريع ورخيص'],
    cons: ['تشبّع كبير بمحتوى سطحي', 'حذر في مواضيع الصحة النفسية (سياسة المعلومات الطبية)'],
  },
  {
    id: 'tech-ai', nameAr: 'التقنية والذكاء الاصطناعي', nameEn: 'Tech & AI explained',
    ratings: r(8, 8, 9, 4, 9, 9, 8, 7, 8, 9, 6, 6, 9, 8),
    pros: ['CPM مرتفع ورعاة كثيرون', 'ترند مستمر'],
    cons: ['منافسة عالية جداً', 'المحتوى يتقادم بسرعة', 'صعب التميز بدون خبرة شخصية'],
  },
  {
    id: 'science-space', nameAr: 'العلوم والفضاء المبسط', nameEn: 'Science & space',
    ratings: r(7, 7, 5, 6, 6, 10, 6, 6, 7, 9, 8, 7, 5, 9),
    pros: ['مناسب جداً للمعلنين', 'أصالة ممكنة بالرسوم الخاصة'],
    cons: ['يحتاج رسوماً وتحريكاً أكثر', 'RPM متوسط'],
  },
  {
    id: 'mystery-true-crime', nameAr: 'الغموض والجرائم الحقيقية', nameEn: 'Mystery & true crime',
    ratings: r(9, 7, 7, 5, 4, 3, 7, 7, 7, 3, 6, 8, 3, 9),
    pros: ['احتفاظ عالٍ جداً', 'مشاهدات كبيرة'],
    cons: ['غير مناسب لكثير من المعلنين', 'مخاطر خصوصية وتقييد عمري', 'ضحايا حقيقيون: مخاطر أخلاقية وقانونية'],
  },
  {
    id: 'book-summaries', nameAr: 'ملخصات الكتب', nameEn: 'Book summaries',
    ratings: r(6, 7, 3, 4, 6, 9, 9, 8, 4, 8, 4, 6, 6, 9),
    pros: ['إنتاج سريع ورخيص'],
    cons: ['خطر حقوق التأليف (عمل مشتق)', 'خطر "محتوى معاد الاستخدام" ضمن سياسات الربح', 'أصالة منخفضة'],
  },
  {
    id: 'geopolitics', nameAr: 'الجيوسياسة والعلاقات الدولية', nameEn: 'Geopolitics',
    ratings: r(8, 6, 9, 5, 5, 4, 7, 6, 6, 3, 6, 7, 3, 7),
    pros: ['اهتمام عالٍ عند الأحداث'],
    cons: ['حساسية سياسية عالية في المنطقة', 'خطر تقييد الإعلانات', 'خطر المعلومات المضللة'],
  },
  {
    id: 'health-fitness', nameAr: 'الصحة واللياقة', nameEn: 'Health & fitness',
    ratings: r(8, 9, 5, 3, 8, 6, 6, 6, 7, 4, 5, 6, 8, 7),
    pros: ['طلب بحثي عالٍ', 'رعاة كثيرون'],
    cons: ['سياسة المعلومات الطبية المضللة صارمة', 'منافسة من أطباء ومدربين حقيقيين', 'يحتاج خبرة موثقة'],
  },
  {
    id: 'football', nameAr: 'الرياضة وكرة القدم', nameEn: 'Football',
    ratings: r(10, 8, 10, 2, 5, 7, 7, 8, 2, 6, 4, 7, 6, 6),
    pros: ['أعلى طلب في المنطقة'],
    cons: ['حقوق اللقطات شبه مستحيلة (Content ID)', 'منافسة شرسة', 'RPM منخفض نسبياً'],
  },
  {
    id: 'travel-cultures', nameAr: 'السفر والثقافات', nameEn: 'Travel & cultures',
    ratings: r(7, 6, 4, 5, 7, 9, 3, 3, 5, 9, 6, 6, 7, 8),
    pros: ['مناسب للمعلنين والرعاة'],
    cons: ['يحتاج تصويراً أصلياً مكلفاً', 'بدون تصوير يصبح محتوى stock ضعيف'],
  },
];
