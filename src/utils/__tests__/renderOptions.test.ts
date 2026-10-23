import { describe, expect, it } from 'vitest';
import { effectiveAutoCrop, resolveRenderOptions } from '../renderOptions';
import type { ResolvedRenderOptions } from '../renderOptions';
import { defaultTitle, pickInitialMode } from '../modeSelection';
import { placeOnSheet, SHEETS } from '../pageSize';

// 手抄一份默认值：appSettings 会 runtime 依赖 SQLite/RN，测试环境里 import 不动。
// 与 src/utils/appSettings.ts 的 DEFAULT_SETTINGS 保持一致，改那边记得改这里。
const settings = { autoCrop: true, outputMaxSide: 3000, jpegQuality: 92, pdfPageSize: 'auto' } as const;

describe('resolveRenderOptions（渲染参数的唯一真源）', () => {
  it('不带 override 时全部取设置值，不设隐式默认', () => {
    const resolved = resolveRenderOptions({ ...settings, jpegQuality: 80 });
    expect<ResolvedRenderOptions>(resolved).toBeTruthy();
    expect(resolved.jpegQuality).toBe(80);
    expect(resolved.outputMaxSide).toBe(settings.outputMaxSide);
    expect(resolved.pageSizeMode).toBe('auto');
  });

  it('两条渲染路径给同样的输入必须得到同样的输出（走查 audit-16 的成因）', () => {
    const fromScan = resolveRenderOptions(settings, { autoCrop: true });
    const fromDetail = resolveRenderOptions(settings, { autoCrop: true });
    expect(fromScan).toEqual(fromDetail);
  });

  it('脏值回落到默认，不会把 0/NaN/越界写进原生', () => {
    expect(resolveRenderOptions({ ...settings, outputMaxSide: 99999 }).outputMaxSide).toBe(3000);
    expect(resolveRenderOptions({ ...settings, jpegQuality: 5 }).jpegQuality).toBe(60);
    expect(resolveRenderOptions({ ...settings, jpegQuality: 999 }).jpegQuality).toBe(100);
    expect(resolveRenderOptions({ ...settings, pdfPageSize: 'a3' as never }).pageSizeMode).toBe('auto');
  });

  it('会话开关优先于全局设置，null 才跟随（audit-15 的两个真源问题）', () => {
    expect(effectiveAutoCrop(null, true)).toBe(true);
    expect(effectiveAutoCrop(null, false)).toBe(false);
    expect(effectiveAutoCrop(true, false)).toBe(true);
    expect(effectiveAutoCrop(false, true)).toBe(false);
  });
});

describe('自动决策与默认标题', () => {
  it('规则命中才让建议盖过用户默认档', () => {
    expect(pickInitialMode('moire', 'enhance', 'hd')).toBe('enhance');
    expect(pickInitialMode('blur', 'enhance', 'hd')).toBe('enhance');
    expect(pickInitialMode('default', 'enhance', 'hd')).toBe('hd');
    expect(pickInitialMode('', 'enhance', 'hd')).toBe('hd');
  });

  it('标题是「扫描 YYYYMMDD-HHMM」，且会被 40 字上限内的名字覆盖', () => {
    const title = defaultTitle(new Date(2026, 9, 23, 9, 5));
    expect(title).toBe('扫描 20261023-0905');
  });
});

describe('placeOnSheet（PDF 页面尺寸归一，audit-25）', () => {
  it('auto 时页面就是图片本身，不引入任何留白', () => {
    const p = placeOnSheet('auto', 2480, 3508);
    expect(p.pageWidthPt).toBeCloseTo(595.2, 1);
    expect(p.pageHeightPt).toBeCloseTo(841.92, 1);
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
  });

  it('竖图进竖版 A4，横图自动换横版', () => {
    const portrait = placeOnSheet('a4', 2480, 3508);
    expect(portrait.pageWidthPt).toBeCloseTo(SHEETS.a4.short, 1);
    const landscape = placeOnSheet('a4', 3508, 2480);
    expect(landscape.pageWidthPt).toBeCloseTo(SHEETS.a4.long, 1);
  });

  it('等比 contain：不裁切、不拉伸，长宽比与原图一致', () => {
    const p = placeOnSheet('a4', 1000, 700);
    expect(p.width / p.height).toBeCloseTo(1000 / 700, 2);
    expect(p.width).toBeLessThanOrEqual(p.pageWidthPt + 0.01);
    expect(p.height).toBeLessThanOrEqual(p.pageHeightPt + 0.01);
  });

  it('小图也不会算出 0 尺寸（MediaBox 出现 0 会让整份 PDF 打不开）', () => {
    const p = placeOnSheet('letter', 1, 1);
    expect(p.width).toBeGreaterThan(0);
    expect(p.height).toBeGreaterThan(0);
    expect(p.pageWidthPt).toBeCloseTo(SHEETS.letter.short, 1);
  });
});
