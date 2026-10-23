import type { ImageMetrics, ScanMode } from '../types';

/**
 * 场景化决策 —— 对标扫描全能王「智能高清」的第二层：看清问题之后决定怎么办。
 *
 * 放在纯 JS 而不是原生，是为了：阈值调整是产品决策，必须能被单测钉住；
 * 原生层只负责量得准，不负责下判断。
 *
 * 自动档只在 智能高清 / 增强 之间选：
 *   - 灰度 / 黑白 / 原图 都是明确的审美取向，机器不该替用户决定；
 *   - 但「有摩尔纹时别开降噪」是技术事实，必须机器来挡（bilateral 会把屏纹放大）。
 */

export const MODE_THRESHOLDS = {
  /** Laplacian 方差低于此值判为「糊」 */
  BLUR_MIN: 90,
  /** 背景动态范围归一高于此值判为「有阴影/光照不均」 */
  SHADOW_MAX: 0.22,
  /** 高频能量占比高于此值判为「拍屏摩尔纹」 */
  MOIRE_MAX: 0.35,
  /** S 通道均值高于此值判为彩色内容 */
  SATURATION_COLOR: 60,
  /** 平均亮度低于此值判为偏暗 */
  BRIGHT_DARK: 70,
  /** 白场覆盖率低于此值说明纸面本来就灰，提白收益大 */
  WHITE_LOW: 0.12,
} as const;

export interface ModeSuggestion {
  mode: ScanMode;
  /** 一句话说明为什么这么选（界面上「智能」必须可解释，否则用户不敢信） */
  reason: string;
  /** 命中了哪条规则，便于 QA 台统计与回归 */
  rule: string;
}

export function suggestMode(metrics: ImageMetrics | null | undefined): ModeSuggestion {
  if (!metrics) {
    return { mode: 'hd', reason: '默认智能高清', rule: 'fallback' };
  }
  const t = MODE_THRESHOLDS;

  // 1. 摩尔纹优先：降噪会把屏纹放大，这是唯一「不做反而更好」的情况
  if (metrics.moireScore > t.MOIRE_MAX) {
    return {
      mode: 'enhance',
      reason: '检测到拍屏纹路：改用增强，避免降噪把纹路放大',
      rule: 'moire',
    };
  }
  // 2. 已经糊的图再降噪只会更糊，只锐化
  if (metrics.blurScore < t.BLUR_MIN) {
    return {
      mode: 'enhance',
      reason: '画面偏糊：只增强锐度，不降噪',
      rule: 'blur',
    };
  }
  // 3. 阴影/光照不均 → 摊平光照（智能高清的核心）
  if (metrics.shadowScore > t.SHADOW_MAX) {
    return {
      mode: 'hd',
      reason: '检测到阴影与光照不均：已摊平光照',
      rule: 'shadow',
    };
  }
  // 4. 偏暗 → 摊平 + 提白
  if (metrics.brightness < t.BRIGHT_DARK) {
    return { mode: 'hd', reason: '环境偏暗：已提亮纸面并增强对比', rule: 'dark' };
  }
  // 5. 纸面发灰 → 提白收益最大
  if (metrics.whiteCoverage < t.WHITE_LOW) {
    return { mode: 'hd', reason: '纸面发灰：已提白并增强', rule: 'grey-paper' };
  }
  // 6. 彩色内容保留颜色
  if (metrics.saturation > t.SATURATION_COLOR) {
    return { mode: 'hd', reason: '彩色内容：保留颜色，同时切边增强', rule: 'color' };
  }
  return { mode: 'hd', reason: '默认智能高清', rule: 'default' };
}

/** 清晰度提升的对外说法：只在真的有明显提升时才报数字 */
export function sharpnessLabel(gain: number | null | undefined): string | null {
  if (typeof gain !== 'number' || !Number.isFinite(gain)) return null;
  if (gain <= 1.05) return null;
  const percent = Math.round((gain - 1) * 100);
  if (percent <= 0) return null;
  return `清晰度 +${percent}%`;
}

/**
 * 自动切边的可信度说法：检测失败时不能装作切好了。
 *
 * `source` 是原生报过来「用了哪条路」，只用来把话说准：
 * full = 纸本来就在画面里铺满了，那不是「切好了」，是「无需切」，
 * 混在一起说会让用户以为裁过了、结果纸边被留白切掉时找不到原因。
 */
export function cropLabel(detected: boolean, confidence: number, source?: string): string {
  if (!detected) return '没找到纸边，用整页 —— 可手动调整四角';
  if (source === 'full') return '纸面已占满画面，整页处理';
  if (confidence >= 0.72) return '已自动切边';
  if (confidence >= 0.45) return '已自动切边，建议确认一下四角';
  return '边缘不太确定，建议调整四角';
}

/**
 * 文档默认标题：时间戳最实用，但保存那一刻会给用户改的机会（走查 audit-29）。
 * 放这里而不是组件里，是为了能被单测钉住（组件里的同名函数在 node 环境 import 不动）。
 */
export function defaultTitle(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `扫描 ${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(
    now.getMinutes(),
  )}`;
}

/**
 * 初始档位：自动决策优先，用户设置兜底（走查 audit-21：suggestMode 以前算完只是显示，从不影响档位）。
 * 只有规则真的命中（摩尔纹 / 糊图 / 阴影…）才替用户选，rule='default' 不越权。
 */
export function pickInitialMode(rule: string, suggested: ScanMode, fallback: ScanMode): ScanMode {
  return rule && rule !== 'default' ? suggested : fallback;
}

/** 模式在界面上的顺序（与 constants 的 SCAN_MODES 一致，测试用来防漂移） */
export const MODE_ORDER: ScanMode[] = ['hd', 'enhance', 'gray', 'bw', 'raw'];

export function isScanMode(value: unknown): value is ScanMode {
  return typeof value === 'string' && (MODE_ORDER as string[]).includes(value);
}

/** 存储/原生返回里的模式兜底：脏值一律回落智能高清，而不是让界面白屏 */
export function safeMode(value: unknown): ScanMode {
  return isScanMode(value) ? value : 'hd';
}
