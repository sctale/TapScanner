import { describe, expect, it } from 'vitest';
import type { ImageMetrics } from '../../types';
import { MODE_THRESHOLDS, cropLabel, safeMode, sharpnessLabel, suggestMode } from '../modeSelection';

function metrics(overrides: Partial<ImageMetrics> = {}): ImageMetrics {
  return {
    brightness: 180,
    contrast: 55,
    saturation: 22,
    median: 185,
    blurScore: 240,
    shadowScore: 0.08,
    moireScore: 0.1,
    whiteCoverage: 0.35,
    elapsedMs: 12,
    ...overrides,
  };
}

describe('suggestMode 判定优先级', () => {
  it('摩尔纹最优先，且必须避开降噪档', () => {
    // 同时也很暗很糊：摩尔纹规则要压住其它所有规则，因为降噪会把屏纹放大
    const s = suggestMode(
      metrics({
        moireScore: MODE_THRESHOLDS.MOIRE_MAX + 0.01,
        blurScore: 10,
        brightness: 40,
        shadowScore: 0.9,
      }),
    );
    expect(s.mode).toBe('enhance');
    expect(s.rule).toBe('moire');
  });

  it('糊图走增强（只锐化不降噪）', () => {
    const s = suggestMode(metrics({ blurScore: MODE_THRESHOLDS.BLUR_MIN - 1, moireScore: 0.1 }));
    expect(s.mode).toBe('enhance');
    expect(s.rule).toBe('blur');
  });

  it('阴影/光照不均走智能高清（摊平光照）', () => {
    const s = suggestMode(metrics({ shadowScore: MODE_THRESHOLDS.SHADOW_MAX + 0.01 }));
    expect(s.mode).toBe('hd');
    expect(s.rule).toBe('shadow');
  });

  it('偏暗走智能高清（提白 + 增强）', () => {
    const s = suggestMode(metrics({ brightness: MODE_THRESHOLDS.BRIGHT_DARK - 1 }));
    expect(s.rule).toBe('dark');
    expect(s.mode).toBe('hd');
  });

  it('纸面发灰时命中 grey-paper', () => {
    const s = suggestMode(metrics({ whiteCoverage: MODE_THRESHOLDS.WHITE_LOW - 0.01 }));
    expect(s.rule).toBe('grey-paper');
  });

  it('彩色内容命中 color 且保留颜色', () => {
    const s = suggestMode(metrics({ saturation: MODE_THRESHOLDS.SATURATION_COLOR + 1 }));
    expect(s.rule).toBe('color');
    expect(s.mode).toBe('hd');
  });

  it('什么都不触发时是默认档，且一定给出可读理由', () => {
    const s = suggestMode(metrics());
    expect(s.mode).toBe('hd');
    expect(s.rule).toBe('default');
    expect(s.reason.length).toBeGreaterThan(2);
  });

  it('指标缺失（原生还没回）时回落默认档而不是崩', () => {
    expect(suggestMode(undefined).mode).toBe('hd');
    expect(suggestMode(null).rule).toBe('fallback');
  });

  it('自动档只在 hd / enhance 里选（灰度黑白原图是人的审美取向）', () => {
    const samples = [
      metrics({ moireScore: 0.99 }),
      metrics({ blurScore: 1 }),
      metrics({ shadowScore: 1 }),
      metrics({ brightness: 0 }),
      metrics({ saturation: 255 }),
      metrics(),
    ];
    for (const sample of samples) {
      expect(['hd', 'enhance']).toContain(suggestMode(sample).mode);
    }
  });
});

describe('sharpnessLabel', () => {
  it('提升不足 5% 时不吹', () => {
    expect(sharpnessLabel(1.0)).toBeNull();
    expect(sharpnessLabel(1.04)).toBeNull();
    expect(sharpnessLabel(0.8)).toBeNull();
  });

  it('明显提升时报百分比', () => {
    expect(sharpnessLabel(1.42)).toBe('清晰度 +42%');
    expect(sharpnessLabel(2.5)).toBe('清晰度 +150%');
  });

  it('脏值不报错', () => {
    expect(sharpnessLabel(Number.NaN)).toBeNull();
    expect(sharpnessLabel(undefined)).toBeNull();
    expect(sharpnessLabel('1.2' as unknown as number)).toBeNull();
  });
});

describe('cropLabel', () => {
  it('检测失败时如实说「用整页」', () => {
    const label = cropLabel(false, 0);
    expect(label).toContain('没找到纸边');
    expect(label).toContain('整页');
  });

  it('高置信度不啰嗦，低置信度提示确认', () => {
    expect(cropLabel(true, 0.95)).toBe('已自动切边');
    expect(cropLabel(true, 0.5)).toContain('建议确认');
    expect(cropLabel(true, 0.2)).toContain('不太确定');
  });
});

describe('safeMode', () => {
  it('脏模式值回落 hd（旧版本备份/手改数据库都可能塞进脏值）', () => {
    expect(safeMode('bw')).toBe('bw');
    expect(safeMode('hd')).toBe('hd');
    expect(safeMode('colorful')).toBe('hd');
    expect(safeMode(null)).toBe('hd');
    expect(safeMode(3)).toBe('hd');
  });
});
