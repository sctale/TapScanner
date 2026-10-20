import { describe, expect, it } from 'vitest';
import { A4_PX_300DPI, DEFAULT_SCAN_DPI, pdfPageSize, pxToPt } from '../pageSize';

describe('pxToPt', () => {
  it('300dpi 下 A4 宽 2480px = 595.2pt（≈210mm）', () => {
    const pt = pxToPt(A4_PX_300DPI.width, DEFAULT_SCAN_DPI);
    expect(pt).toBeCloseTo(595.2, 1);
    // 毫米换算回来核对：pt / 72 * 25.4
    expect((pt / 72) * 25.4).toBeCloseTo(210, 0);
  });

  it('dpi 越大同一像素数对应的物理尺寸越小', () => {
    expect(pxToPt(3000, 600)).toBeCloseTo(pxToPt(1500, 300), 6);
  });

  it('非法 dpi / 像素不会产出 NaN 或负数', () => {
    expect(pxToPt(1000, 0)).toBe(pxToPt(1000, DEFAULT_SCAN_DPI));
    expect(pxToPt(1000, Number.NaN)).toBe(pxToPt(1000, DEFAULT_SCAN_DPI));
    expect(pxToPt(-5, 300)).toBe(0);
    expect(pxToPt(0, 300)).toBe(0);
  });
});

describe('pdfPageSize', () => {
  it('A4 300dpi → 595.2 × 841.9 pt', () => {
    const size = pdfPageSize(A4_PX_300DPI.width, A4_PX_300DPI.height, DEFAULT_SCAN_DPI);
    expect(size.widthPt).toBeCloseTo(595.2, 1);
    expect(size.heightPt).toBeCloseTo(841.9, 1);
  });

  it('横放的纸（宽大于高）按实际像素出横向页面', () => {
    const size = pdfPageSize(3508, 2480, DEFAULT_SCAN_DPI);
    expect(size.widthPt).toBeGreaterThan(size.heightPt);
  });

  it('退化尺寸（0×0）也给出 ≥1pt 的合法页面 —— MediaBox 出现 0 会让整份 PDF 打不开', () => {
    const size = pdfPageSize(0, 0, DEFAULT_SCAN_DPI);
    expect(size.widthPt).toBeGreaterThanOrEqual(1);
    expect(size.heightPt).toBeGreaterThanOrEqual(1);
  });

  it('输出保留两位小数（PDF 里写太长的小数没意义）', () => {
    const size = pdfPageSize(1234, 2345, DEFAULT_SCAN_DPI);
    expect(size.widthPt).toBe(Math.round(size.widthPt * 100) / 100);
    expect(size.heightPt).toBe(Math.round(size.heightPt * 100) / 100);
  });
});
