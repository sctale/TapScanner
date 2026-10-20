import { describe, expect, it } from 'vitest';
import {
  FULL_FRAME_QUAD,
  clamp01,
  contentRect,
  isDegenerate,
  normalizeQuad,
  orderCorners,
  quadArea,
  quadToScreen,
  sanitizeQuad,
  scaleQuad,
  screenToQuad,
} from '../quad';

describe('orderCorners', () => {
  it('任意起点顺序都归一到 左上→右上→右下→左下', () => {
    // 同一组四角，故意打乱起点
    const tl = { x: 0.1, y: 0.2 };
    const tr = { x: 0.9, y: 0.1 };
    const br = { x: 0.95, y: 0.9 };
    const bl = { x: 0.15, y: 0.95 };
    const variants = [
      [tl, tr, br, bl],
      [tr, br, bl, tl],
      [br, bl, tl, tr],
      [bl, tl, tr, br],
    ];
    for (const v of variants) {
      expect(orderCorners(v)).toEqual([tl, tr, br, bl]);
    }
  });

  it('倾斜的纸也不会把顺序搞反（sum/diff 法对透视稳定）', () => {
    const quad = [
      { x: 0.2, y: 0.15 },
      { x: 0.85, y: 0.05 },
      { x: 0.8, y: 0.9 },
      { x: 0.1, y: 0.8 },
    ];
    const ordered = orderCorners(quad);
    expect(ordered[0].x).toBeLessThan(ordered[1].x); // 左上在左
    expect(ordered[0].y).toBeLessThan(ordered[3].y); // 左上在上
    expect(ordered[2].x).toBeGreaterThan(ordered[3].x); // 右下在右
    expect(ordered[2].y).toBeGreaterThan(ordered[1].y); // 右下在下
  });

  it('点数不是 4 时原样返回，不抛错', () => {
    const three = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(orderCorners(three)).toEqual(three);
  });
});

describe('quadArea / isDegenerate', () => {
  it('整页框面积是 1', () => {
    expect(quadArea(FULL_FRAME_QUAD)).toBeCloseTo(1, 6);
  });

  it('面积过小的框判退化（喂给原生会得到 1×1 废图）', () => {
    const tiny = [
      { x: 0.5, y: 0.5 },
      { x: 0.52, y: 0.5 },
      { x: 0.52, y: 0.52 },
      { x: 0.5, y: 0.52 },
    ];
    expect(isDegenerate(tiny)).toBe(true);
  });

  it('四点几乎共线判退化', () => {
    const flat = [
      { x: 0, y: 0.5 },
      { x: 1, y: 0.5 },
      { x: 1, y: 0.501 },
      { x: 0, y: 0.501 },
    ];
    expect(isDegenerate(flat)).toBe(true);
  });

  it('正常斜切的纸不退化', () => {
    expect(
      isDegenerate([
        { x: 0.1, y: 0.12 },
        { x: 0.92, y: 0.06 },
        { x: 0.88, y: 0.93 },
        { x: 0.08, y: 0.88 },
      ]),
    ).toBe(false);
  });
});

describe('contentRect（letterbox）', () => {
  it('竖图放进横容器：左右留边、上下顶满', () => {
    const rect = contentRect(1000, 2000, 800, 600);
    expect(rect.height).toBeCloseTo(600, 6);
    expect(rect.width).toBeCloseTo(300, 6);
    expect(rect.x).toBeCloseTo(250, 6);
    expect(rect.y).toBeCloseTo(0, 6);
  });

  it('横图放进竖容器：上下留边、左右顶满', () => {
    const rect = contentRect(2000, 1000, 600, 800);
    expect(rect.width).toBeCloseTo(600, 6);
    expect(rect.height).toBeCloseTo(300, 6);
    expect(rect.y).toBeCloseTo(250, 6);
  });

  it('尺寸非法时不产生 NaN 或负数', () => {
    const rect = contentRect(0, 0, 100, 100);
    expect(Number.isFinite(rect.width)).toBe(true);
    expect(rect.width).toBeGreaterThanOrEqual(0);
    expect(rect.height).toBeGreaterThanOrEqual(0);
  });

  it('四角往返：归一化 → 屏幕 → 归一化 一致', () => {
    const rect = contentRect(1200, 1600, 390, 700);
    for (const p of FULL_FRAME_QUAD) {
      const [round] = screenToQuad(quadToScreen([p], rect), rect);
      expect(round.x).toBeCloseTo(p.x, 8);
      expect(round.y).toBeCloseTo(p.y, 8);
    }
  });
});

describe('scaleQuad / normalizeQuad 往返', () => {
  it('像素与归一化互转保持同一个点', () => {
    const quad = [
      { x: 0.11, y: 0.22 },
      { x: 0.88, y: 0.19 },
      { x: 0.91, y: 0.79 },
      { x: 0.13, y: 0.83 },
    ];
    const pixels = scaleQuad(quad, 4000, 3000);
    expect(pixels[0]).toEqual({ x: 0.11 * 4000, y: 0.22 * 3000 });
    const back = normalizeQuad(pixels, 4000, 3000);
    expect(back).toEqual(quad.map((p) => ({ x: p.x, y: p.y })));
  });

  it('尺寸非法（0 宽）时不会被除爆', () => {
    const quad = [
      { x: 0.5, y: 0.5 },
      { x: 1, y: 0.5 },
      { x: 1, y: 1 },
      { x: 0.5, y: 1 },
    ];
    expect(normalizeQuad(quad, 0, 0)).toEqual(quad);
  });
});

describe('clamp01', () => {
  it('越界收进 [0,1]，非有限值当 0', () => {
    expect(clamp01(-5)).toBe(0);
    expect(clamp01(5)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
  });
});

describe('sanitizeQuad（脏数据入口拦截）', () => {
  it('接受正常四角并排序', () => {
    const cleaned = sanitizeQuad([
      { x: 0.9, y: 0.1 },
      { x: 0.1, y: 0.9 },
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.9 },
    ]);
    expect(cleaned).not.toBeNull();
    expect(cleaned?.[0]).toEqual({ x: 0.1, y: 0.1 });
  });

  it('长度不对 / NaN / 越界太多 / 退化 一律当作没有框', () => {
    expect(sanitizeQuad([{ x: 0, y: 0 }])).toBeNull();
    expect(
      sanitizeQuad([
        { x: Number.NaN, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ]),
    ).toBeNull();
    expect(
      sanitizeQuad([
        { x: 5, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ]),
    ).toBeNull();
    expect(
      sanitizeQuad([
        { x: 0.5, y: 0.5 },
        { x: 0.51, y: 0.5 },
        { x: 0.51, y: 0.51 },
        { x: 0.5, y: 0.51 },
      ]),
    ).toBeNull();
    expect(sanitizeQuad(null)).toBeNull();
    expect(sanitizeQuad('quad')).toBeNull();
  });
});
