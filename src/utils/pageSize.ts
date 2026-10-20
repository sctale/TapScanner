/**
 * PDF 页面尺寸换算（纯函数，vitest 覆盖）。
 *
 * PDF 的用户空间单位是 1/72 英寸（point）。扫描件按「像素 + dpi」决定页面物理尺寸：
 * pt = px * 72 / dpi。dpi 取错会让 A4 打成海报，所以这条单独测。
 */

export const POINTS_PER_INCH = 72;
export const DEFAULT_SCAN_DPI = 300;

export function pxToPt(px: number, dpi = DEFAULT_SCAN_DPI): number {
  if (!Number.isFinite(px) || px <= 0) return 0;
  const safeDpi = Number.isFinite(dpi) && dpi > 0 ? dpi : DEFAULT_SCAN_DPI;
  return (px * POINTS_PER_INCH) / safeDpi;
}

export interface PdfPageSize {
  widthPt: number;
  heightPt: number;
}

/**
 * 页面尺寸。
 *
 * 下限 1pt 是必须的：写进 PDF 的 MediaBox 出现 0 或负数，阅读器会整份文件报错，
 * 而那时用户看到的是「PDF 打不开」，根本想不到是某一张图尺寸算崩了。
 */
export function pdfPageSize(widthPx: number, heightPx: number, dpi = DEFAULT_SCAN_DPI): PdfPageSize {
  return {
    widthPt: Math.max(1, round2(pxToPt(widthPx, dpi))),
    heightPt: Math.max(1, round2(pxToPt(heightPx, dpi))),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A4 在 300dpi 下的像素数，QA 台合成样张和断言用 */
export const A4_PX_300DPI = { width: 2480, height: 3508 };
