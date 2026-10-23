/**
 * WCAG 相对亮度与对比度。
 *
 * 单独成一个模块的原因：`npx tsc --noEmit` 不会检查「这个颜色放在那个背景上能不能看清」，
 * 而人眼在暖米白底上也估不准 —— 只有把公式写下来，令牌漂移才会被抓到（走查 audit-32）。
 * 支持 rgba(...)：相机页那套 onCamera* 全是半透明白，必须先按背景合成再算。
 */
function parseColor(color: string): { r: number; g: number; b: number; a: number } {
  const text = color.trim();
  const rgba = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgba) {
    const parts = rgba[1].split(',').map((v) => Number(v.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  const hex = text.replace('#', '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: 1,
  };
}

/** 半透明前景压在实色背景上，合成出眼睛真正看到的那个颜色 */
export function composite(foreground: string, background: string): string {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (fg.a >= 1) return foreground;
  const mix = (a: number, b: number) => Math.round(a * fg.a + b * (1 - fg.a));
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(mix(fg.r, bg.r))}${hex(mix(fg.g, bg.g))}${hex(mix(fg.b, bg.b))}`;
}

function relativeLuminance(color: string): number {
  const { r, g, b } = parseColor(color);
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(foreground: string, background: string): number {
  const fg = composite(foreground, background);
  const a = relativeLuminance(fg);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** 正文要求 4.5，大字/图形要求 3.0 */
export function meetsAA(ratio: number, need = 4.5): boolean {
  return ratio >= need - 1e-9;
}
