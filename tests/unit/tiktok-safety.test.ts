import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTikTokCaption, tiktokRisk } from '../../src/publishing/tiktok-safety.ts';

test('tiktok safety: topics TikTok removed or held stay off TikTok; ordinary tips go through', () => {
  for (const t of [
    'أراهنك إن جوجل كشف باسورداتك المسربة في اختراق عالمي',
    'كود أندرويد يكشف لو مكالماتك بتتحول لشخص تاني 📞',
    'كود سامسونج سري يفتح قائمة اختبار تردد الشبكة: نجمة شباك صفر صفر واحد واحد شباك',
    'مين بيحول مكالماتك؟ اكتب الكود ده *#21#',
    'واتساب بتاعك ممكن يتسرق بسهولة!',
  ]) assert.ok(tiktokRisk(t), t);
  for (const t of [
    'زرار سري في الموبايل يقفل المايك والكاميرا نهائياً',
    'مسافة الشاشة في الآيفون تحمي عينك لو قربت الموبايل',
    'حيلة سرية في واتساب تمنع إضافة الجروبات العشوائية',
    'خيارات المطور في الأندرويد تظهر نقطة بيضاء لمكان لمستك',
  ]) assert.equal(tiktokRisk(t), undefined, t);
  assert.equal(cleanTikTokCaption('نصيحة #سر_الموبايل #fyp #tech #viral #foryou'), 'نصيحة #سر_الموبايل #tech');
});
