import type { QuadPoint } from '../types';

/**
 * 四角几何（纯函数，vitest 覆盖）。
 *
 * 与原生 QuadDetect.kt 的 orderCorners 必须给出同一个结果：
 * 顺序一旦不一致，透视变换会把纸翻面 —— 而「看起来还是一张纸」，最难发现。
 */

/** 整页框（不切边时用） */
export const FULL_FRAME_QUAD: QuadPoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 固定成 左上→右上→右下→左下（sum/diff 法，与原生一致） */
export function orderCorners(points: QuadPoint[]): QuadPoint[] {
  if (points.length !== 4) return points;
  const tl = points.reduce((a, b) => (b.x + b.y < a.x + a.y ? b : a));
  const br = points.reduce((a, b) => (b.x + b.y > a.x + a.y ? b : a));
  const tr = points.reduce((a, b) => (b.x - b.y > a.x - a.y ? b : a));
  const bl = points.reduce((a, b) => (b.x - b.y < a.x - a.y ? b : a));
  return [tl, tr, br, bl];
}

/** 鞋带公式求面积（坐标域需一致：归一化就是占画面比例） */
export function quadArea(quad: QuadPoint[]): number {
  if (quad.length !== 4) return 0;
  let sum = 0;
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4;
    sum += quad[i].x * quad[j].y - quad[j].x * quad[i].y;
  }
  return Math.abs(sum) / 2;
}

/**
 * 退化判定：角点重合、面积过小、或四点几乎共线。
 * 退化的框喂给原生会得到 1×1 的图，界面上表现为「扫出来是空白」，必须在入口拦住。
 *
 * ⚠️ 传入顺序必须是 左上→右上→右下→左下：鞋带公式对自交（乱序）的四点会算出 ≈0，
 * 于是把好框当成退化。调用方不确定顺序时先过 orderCorners。
 */
export function isDegenerate(quad: QuadPoint[], minArea = 0.02): boolean {
  if (quad.length !== 4) return true;
  if (quadArea(quad) < minArea) return true;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 0.02) return true;
  }
  return false;
}

/** 归一化 → 像素坐标 */
export function scaleQuad(quad: QuadPoint[], width: number, height: number): QuadPoint[] {
  return quad.map((p) => ({ x: p.x * width, y: p.y * height }));
}

/** 像素 → 归一化（拖动把手后回写用） */
export function normalizeQuad(quad: QuadPoint[], width: number, height: number): QuadPoint[] {
  if (width <= 0 || height <= 0) return quad;
  return quad.map((p) => ({ x: clamp01(p.x / width), y: clamp01(p.y / height) }));
}

/**
 * 图片在容器里按 contain 摆放后的实际矩形（letterbox）。
 * 叠加层必须画在这个矩形上，否则用户拖的角点和图上看到的角点会错开 ——
 * 这是「四角调整」最容易做的 bug：错开几像素看起来像是算法不准。
 */
export interface ContentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function contentRect(imageW: number, imageH: number, boxW: number, boxH: number): ContentRect {
  if (imageW <= 0 || imageH <= 0 || boxW <= 0 || boxH <= 0) {
    return { x: 0, y: 0, width: Math.max(0, boxW), height: Math.max(0, boxH) };
  }
  const scale = Math.min(boxW / imageW, boxH / imageH);
  const width = imageW * scale;
  const height = imageH * scale;
  return { x: (boxW - width) / 2, y: (boxH - height) / 2, width, height };
}

/** 归一化四角 → 容器像素坐标（画叠加层用） */
export function quadToScreen(quad: QuadPoint[], rect: ContentRect): QuadPoint[] {
  return quad.map((p) => ({ x: rect.x + p.x * rect.width, y: rect.y + p.y * rect.height }));
}

/** 容器像素坐标 → 归一化四角（把手拖动后回写用） */
export function screenToQuad(points: QuadPoint[], rect: ContentRect): QuadPoint[] {
  if (rect.width <= 0 || rect.height <= 0) return points;
  return points.map((p) => ({
    x: clamp01((p.x - rect.x) / rect.width),
    y: clamp01((p.y - rect.y) / rect.height),
  }));
}

/**
 * 校验原生/存储回来的四角。
 * 长度不对、有 NaN、越界太多一律当作「没有框」，让调用方退回整页 + 自动检测，
 * 而不是把一个脏框喂给原生（脏框喂进去会得到一张斜切的废图）。
 */
export function sanitizeQuad(raw: unknown): QuadPoint[] | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const points: QuadPoint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const { x, y } = item as { x?: unknown; y?: unknown };
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < -0.2 || x > 1.2 || y < -0.2 || y > 1.2) return null;
    points.push({ x: clamp01(x), y: clamp01(y) });
  }
  // 先排序再判退化：乱序四点是自交多边形，鞋带面积≈0，会被 isDegenerate 误杀
  const ordered = orderCorners(points);
  if (isDegenerate(ordered)) return null;
  return ordered;
}
