import { Agent } from '../base.ts';
import { CRITERIA, WEIGHTS, NICHE_CANDIDATES, type Criterion, type NicheCandidate } from './candidates.ts';

export interface NicheScore {
  id: string;
  nameAr: string;
  nameEn: string;
  score: number;
  breakdown: Record<Criterion, number>;
  eligible: boolean;
  riskFlags: string[];
  pros: string[];
  cons: string[];
}

export interface NicheSelectionReport {
  generatedAt: string;
  dataSource: 'expert-estimates' | 'measured';
  ranked: NicheScore[];
  top3: string[];
  primary: string;
  backups: string[];
  confidence: { level: 'low' | 'medium' | 'high'; value: number; reason: string };
  rationale: string;
}

/** Ratings at or below this on a safety criterion disqualify a niche as primary. */
const SAFETY_FLOOR = 4;
const SAFETY_CRITERIA: Criterion[] = ['copyrightSafety', 'policySafety', 'advertiserFriendly'];

export function scoreNiche(c: NicheCandidate): NicheScore {
  const breakdown = {} as Record<Criterion, number>;
  let total = 0;
  for (const k of CRITERIA) {
    const rating = c.ratings[k];
    if (rating < 0 || rating > 10) throw new Error(`Rating out of range for ${c.id}.${k}: ${rating}`);
    const pts = (WEIGHTS[k] * rating) / 10;
    breakdown[k] = Number(pts.toFixed(2));
    total += pts;
  }
  const riskFlags = SAFETY_CRITERIA.filter((k) => c.ratings[k] <= SAFETY_FLOOR).map((k) => `${k}=${c.ratings[k]}/10`);
  return {
    id: c.id, nameAr: c.nameAr, nameEn: c.nameEn,
    score: Math.round(total),
    breakdown,
    eligible: riskFlags.length === 0,
    riskFlags,
    pros: c.pros,
    cons: c.cons,
  };
}

export function selectNiches(candidates: NicheCandidate[], dataSource: NicheSelectionReport['dataSource'] = 'expert-estimates'): NicheSelectionReport {
  if (candidates.length < 10) throw new Error(`At least 10 niches are required, got ${candidates.length}`);
  const ranked = candidates.map(scoreNiche).sort((a, b) => b.score - a.score);
  const eligible = ranked.filter((n) => n.eligible);
  if (eligible.length < 3) throw new Error('Fewer than 3 niches pass the safety floor');
  const [p, b1, b2] = eligible as [NicheScore, NicheScore, NicheScore];

  // Confidence: margin over runner-up, capped when ratings are estimates rather than measured data.
  const margin = p.score - b1.score;
  let value = Math.min(0.9, 0.5 + margin * 0.05);
  if (dataSource === 'expert-estimates') value = Math.min(value, 0.65);
  const level = value >= 0.75 ? 'high' : value >= 0.55 ? 'medium' : 'low';

  return {
    generatedAt: new Date().toISOString(),
    dataSource,
    ranked,
    top3: [p.id, b1.id, b2.id],
    primary: p.id,
    backups: [b1.id, b2.id],
    confidence: {
      level,
      value: Number(value.toFixed(2)),
      reason:
        `الفارق بين الأول والثاني ${margin} نقطة. ` +
        (dataSource === 'expert-estimates' ? 'التقييمات تقديرية وليست بيانات مقاسة، لذلك الثقة محدودة بحد أقصى 65%.' : 'التقييمات مبنية على بيانات مقاسة.'),
    },
    rationale:
      `"${p.nameAr}" حصل على أعلى درجة (${p.score}/100) مع اجتياز كل حدود الأمان. ` +
      `النيتشات المستبعدة رغم الطلب العالي: ${ranked.filter((n) => !n.eligible).map((n) => n.nameAr).join('، ') || 'لا يوجد'}.`,
  };
}

export class NicheSelectorAgent extends Agent<{ candidates?: NicheCandidate[] }, NicheSelectionReport> {
  readonly name = 'niche-selector';
  readonly artifactKind = 'niche_report';
  protected async execute(input: { candidates?: NicheCandidate[] }) {
    return selectNiches(input.candidates ?? NICHE_CANDIDATES);
  }
}
