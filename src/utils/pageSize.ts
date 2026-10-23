/**
 * PDF 页面尺寸换算（纯函数，vitest 覆盖）。
 *
 * PDF 的用户空间单位是 1/72 英寸（point）。扫描件按「像素 + dpi」决定页面物理尺寸：
 * pt = px * 72 / dpi。dpi 取错会让 A4 打成海报，所以这条单独测。
 */

import type { PageSizeMode } from '../types';

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

/**
 * 页面尺寸策略的类型定义在 src/types（与设置项、渲染参数共用一个名字）。
 *
 * v0.1 只有 auto：每页跟随自己那张图的像素比例，于是同一份合同里
 * 「A4 拍的页 + 手机横拍的照片」会出一份每页大小都不一样的 PDF ——
 * 打印时打印机要反复重设纸张，翻阅时页面一跳一跳。管理页原来还写着
 * 「3000 够打印 A4」，那是没实现过的承诺（走查 audit-25）。
 */

/** 纸张短/长边（point）。A4 = 210×297mm，Letter = 8.5×11in */
export const SHEETS = {
  a4: { short: 595.28, long: 841.89 },
  letter: { short: 612.0, long: 792.0 },
} as const;

export interface PdfPlacement {
  pageWidthPt: number;
  pageHeightPt: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把一张图放到页面上。
 *
 * auto = 页面就是图本身（旧的直传行为，零留白）；
 * a4/letter = 按图的方向选横/竖版纸，等比 contain 铺满一边后居中。
 *
 * 这里刻意不做「小图放大填满」以外的任何裁切：扫描件的内容一个像素都不能丢，
 * 宁可四周留白，也不能把页边切掉 —— 那是 audit 里最贵的一类错误（切掉纸）。
 */
export function placeOnSheet(
  mode: PageSizeMode,
  widthPx: number,
  heightPx: number,
  dpi = DEFAULT_SCAN_DPI,
  marginPt = 0,
): PdfPlacement {
  const imgW = Math.max(1, pxToPt(widthPx, dpi));
  const imgH = Math.max(1, pxToPt(heightPx, dpi));
  if (mode === 'auto' || !(mode in SHEETS)) {
    return {
      pageWidthPt: Math.max(1, round2(imgW)),
      pageHeightPt: Math.max(1, round2(imgH)),
      x: 0,
      y: 0,
      width: Math.max(1, round2(imgW)),
      height: Math.max(1, round2(imgH)),
    };
  }
  const sheet = SHEETS[mode as 'a4' | 'letter'];
  const landscape = imgW > imgH;
  const pageWidthPt = landscape ? sheet.long : sheet.short;
  const pageHeightPt = landscape ? sheet.short : sheet.long;
  const availW = Math.max(1, pageWidthPt - marginPt * 2);
  const availH = Math.max(1, pageHeightPt - marginPt * 2);
  const scale = Math.min(availW / imgW, availH / imgH);
  const width = round2(imgW * scale);
  const height = round2(imgH * scale);
  return {
    pageWidthPt: round2(pageWidthPt),
    pageHeightPt: round2(pageHeightPt),
    x: round2((pageWidthPt - width) / 2 + marginPt / 2),
    y: round2((pageHeightPt - height) / 2 + marginPt / 2),
    width,
    height,
  };
}

export function pagePresetLabel(mode: PageSizeMode): string {
  if (mode === 'a4') return 'A4';
  if (mode === 'letter') return 'Letter';
  return '自适应';
}
