/**
 * TikTok is stricter than YouTube / Facebook / Instagram. On 21–22 Nov 2026 four of our videos were removed for
 * "Community Guidelines" and several more were held in review: the reposted copies of videos already sent to another
 * account (duplicate / unoriginal content), and topics TikTok reads as hacking, leaks, spying or secret dialer codes
 * (its "scams & fraud", "privacy" and "integrity" rules). A Short whose title or caption touches those is still
 * published everywhere else, but is NOT sent to TikTok — one removed video hurts the whole account's reach.
 */
const RISKY: [RegExp, string][] = [
  [/[*#][*#\d]{2,}#|نجمة\s*شباك|شباك\s*\S+\s*شباك/u, 'كود اتصال سري (TikTok بيعتبره خداع/احتيال)'],
  [/اختراق|اخترا[قك]|هاك|هكر|hack/iu, 'اختراق/هاك'],
  [/مسرب|المسربة|تسريب|leak/iu, 'تسريبات'],
  [/يتسرق|تتسرق|سرقة\s*(الحساب|حسابك)|تهكير/u, 'سرقة حسابات'],
  [/تجسس|يتجسس|تراقب\s*(حد|شخص)|تتبع\s*(حد|شخص|مكان)|spy/iu, 'تجسس/تتبع أشخاص'],
  [/مكالمات\S*\s*بتتحول|تحويل\s*المكالمات|بيحول\s*مكالمات/u, 'تحويل مكالمات (احتيال)'],
  [/فلوس\s*(ببلاش|مجان)|اربح|ربح\s*مضمون|قمار|مراهن/u, 'وعود فلوس/قمار'],
  [/(بدون|من غير)\s*(علامة مائية|حقوق)|crack|مهكر/iu, 'تحايل على حقوق'],
];

/** Why this Short must not go to TikTok, or undefined when it is safe. */
export function tiktokRisk(...texts: (string | undefined)[]): string | undefined {
  const s = texts.filter(Boolean).join(' \n ');
  for (const [re, why] of RISKY) if (re.test(s)) return why;
  return undefined;
}

/** Hashtags TikTok treats as spam bait are dropped from the caption. */
export function cleanTikTokCaption(caption: string): string {
  return caption.replace(/\s*#(fyp|foryou|foryoupage|viral|explore|xyzbca|trending)\b/giu, '').replace(/[ \t]+\n/g, '\n').trim();
}
