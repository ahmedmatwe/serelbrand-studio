import { CRITERIA, CRITERIA_AR, WEIGHTS } from '../agents/niche/candidates.ts';
import type { NicheSelectionReport } from '../agents/niche/niche-selector.ts';

/** Renders the niche comparison as an Arabic Markdown report. */
export function renderNicheReport(r: NicheSelectionReport): string {
  const byId = new Map(r.ranked.map((n) => [n.id, n]));
  const p = byId.get(r.primary)!;
  const lines: string[] = [];
  lines.push('# تقرير اختيار النيتش', '');
  lines.push(`> تاريخ: ${r.generatedAt.slice(0, 10)} · مصدر البيانات: **${r.dataSource === 'expert-estimates' ? 'تقديرات خبير (غير مقاسة)' : 'بيانات مقاسة'}**`, '');
  lines.push('## التوصية', '');
  lines.push(`- **النيتش الأساسي:** ${p.nameAr} — **${p.score}/100**`);
  lines.push(`- **الاحتياطي:** ${r.backups.map((id) => `${byId.get(id)!.nameAr} (${byId.get(id)!.score})`).join('، ')}`);
  lines.push(`- **مستوى الثقة:** ${r.confidence.level} (${Math.round(r.confidence.value * 100)}%) — ${r.confidence.reason}`);
  lines.push('', r.rationale, '');
  lines.push('## الترتيب الكامل', '');
  lines.push('| # | النيتش | الدرجة | مؤهل؟ | مخاطر |', '|---|---|---|---|---|');
  r.ranked.forEach((n, i) => lines.push(`| ${i + 1} | ${n.nameAr} | ${n.score} | ${n.eligible ? '✅' : '❌'} | ${n.riskFlags.join('، ') || '—'} |`));
  lines.push('', '## التفصيل حسب المعايير (نقاط مرجّحة)', '');
  lines.push(`| النيتش | ${CRITERIA.map((c) => `${CRITERIA_AR[c]} (${WEIGHTS[c]})`).join(' | ')} |`);
  lines.push(`|---|${CRITERIA.map(() => '---').join('|')}|`);
  for (const n of r.ranked) lines.push(`| ${n.nameAr} | ${CRITERIA.map((c) => n.breakdown[c]).join(' | ')} |`);
  lines.push('', '## أفضل 3 بالتفصيل', '');
  for (const id of r.top3) {
    const n = byId.get(id)!;
    lines.push(`### ${n.nameAr} (${n.score}/100)`, '', '**مميزات:**', ...n.pros.map((x) => `- ${x}`), '', '**عيوب:**', ...n.cons.map((x) => `- ${x}`), '');
  }
  lines.push('## ملاحظات', '');
  lines.push('- النيتش اللي حصل على 4/10 أو أقل في أمان الحقوق أو السياسات أو ملاءمة المعلنين يُستبعد كأساسي حتى لو درجته عالية.');
  lines.push('- الترند وزنه 5% فقط عمداً: الاختيار مبني على الطلب والربحية والأمان والقدرة على التكرار.');
  lines.push('- التقييمات دي نقطة بداية. الخطوة الجاية: التحقق منها ببيانات بحث YouTube وتحليل المنافسين.');
  lines.push('- لا يوجد ضمان لعدد مشاهدات أو أرباح أو قبول في برنامج الشركاء.');
  return lines.join('\n') + '\n';
}
