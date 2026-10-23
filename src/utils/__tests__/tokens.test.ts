import { describe, expect, it } from 'vitest';
import { COLORS, SCAN_MODES, TOUCH } from '../../constants';
import { contrastRatio, meetsAA } from '../contrast';

/**
 * 设计令牌的可验证部分。
 *
 * 起因是走查 audit-32：constants 里写着「对比度 ≥ WCAG AA」，实算主按钮白字只有 3.45:1。
 * 注释会骗人，测试不会 —— 所以把「前景/背景」这一组关系直接钉住。
 */
const PAIRS: [string, string, string, number][] = [
  ['text on background', COLORS.text, COLORS.background, 4.5],
  ['text on surface', COLORS.text, COLORS.surface, 4.5],
  ['textSecondary on background', COLORS.textSecondary, COLORS.background, 4.5],
  ['textTertiary on surface', COLORS.textTertiary, COLORS.surface, 4.5],
  ['textTertiary on background', COLORS.textTertiary, COLORS.background, 4.5],
  ['accentDark on surface', COLORS.accentDark, COLORS.surface, 4.5],
  ['white on accentDark（主按钮）', COLORS.white, COLORS.accentDark, 4.5],
  ['white on danger（错误 Toast）', COLORS.white, COLORS.danger, 4.5],
  ['white on success（成功 Toast）', COLORS.white, COLORS.success, 4.5],
  ['warningText on warningBg', COLORS.warningText, COLORS.warningBg, 4.5],
  ['onCameraText on cameraBackdrop', COLORS.onCameraText, COLORS.cameraBackdrop, 4.5],
  ['onCameraTextDim on cameraBackdrop（大字/提示）', COLORS.onCameraTextDim, COLORS.cameraBackdrop, 3.0],
];

describe('颜色令牌对比度', () => {
  for (const [name, fg, bg, need] of PAIRS) {
    it(`${name} ≥ ${need}`, () => {
      expect(meetsAA(contrastRatio(fg, bg), need)).toBe(true);
    });
  }
});

describe('触摸与档位令牌', () => {
  it('触摸下限至少 44dp（Android/Apple 无障碍指南的交集）', () => {
    expect(TOUCH.min).toBeGreaterThanOrEqual(44);
  });

  it('五个档位有 key、有 label、有一句话说明，且不重复', () => {
    const keys = SCAN_MODES.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const mode of SCAN_MODES) {
      expect(mode.label.length).toBeGreaterThan(0);
      expect(mode.hint.length).toBeGreaterThan(6);
    }
  });
});
