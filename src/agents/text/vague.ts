/**
 * Vagueness penalty for titles and hooks. Our numbers: openings that name the exact thing ("أصوات مطر وبحر مخفية في
 * الآيفون" ×1.5, "كود بيفتح قائمة اختبار مخفية" ×1.3) beat vague promises and fears ("رسايلك محتاجة تأمين أكتر" ×0.5,
 * "إوعى تسلف موبايلك… عشان خصوصيتك" ×0.7). A vague phrase costs points unless the line also names something concrete.
 */
const VAGUE = /(الحركة دي|الحركه دي|الحاجة دي|الحاجه دي|الطريقة دي|السر ده|الخدعة دي|لو معملتش|كد[هة](?=[\s.!؟?،]|$)|بسهولة|أمان|امان|خصوصيت|تأمين|حماية|حمايه|مهم جد|خطير جد)/g;
/** Things a viewer can picture: an app, a phone, a concrete feature or result. */
const CONCRETE = /(واتساب|واتس|إنستجرام|انستجرام|تيك توك|فيسبوك|يوتيوب|تليجرام|جوجل|آيفون|ايفون|أندرويد|اندرويد|سامسونج|شاومي|كود|صور|صورة|فيديو|رسايل|رسالة|مكالم|بطارية|شاحن|كاميرا|سكرين|شاشة|إشعار|اشعار|باسورد|واي فاي|الإنترنت|صوت|أصوات|قائمة|زرار|لوكيشن|ستوري|جروب)/;

/** 0 (concrete) … 2.4 (vague): points to subtract from a candidate's score. */
export function vaguePenalty(text: string): number {
  const hits = text.match(VAGUE)?.length ?? 0;
  if (!hits) return 0;
  return Math.min(2.4, hits * (CONCRETE.test(text) ? 0.5 : 1.2));
}
