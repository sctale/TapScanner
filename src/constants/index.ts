import type { ScanMode } from '../types';

// ===== Tap 系列设计令牌（与 TapLedger / TapMate / TapMood 同源）=====
// 界面颜色/间距/圆角/字号只从这里取，不在页面里写裸值。
//
// 对比度是算出来的，不是感觉出来的：v0.2.0 起由 src/utils/__tests__/tokens.test.ts 逐对断言
// （正文 ≥4.5，大字/图形 ≥3）。这里以前写着「对比度 ≥ WCAG AA」但其实没有 ——
// 主按钮白字压在 #7986CB 上只有 3.45:1。注释说谎比没注释更糟，所以改成测试守着。
export const COLORS = {
  background: '#F8F6F3', // 暖米白背景
  bgAlt: '#F3EFE9', // 深一档背景
  surface: '#FFFFFF',
  surfaceAlt: '#FFF9F5', // 暖色卡片底
  text: '#2D2D2D', // 深灰主文字
  textSecondary: '#6E6E6E',
  textTertiary: '#6B655E', // 次次级：v0.2 从 #857F78 加深（原来在白卡上只有 3.96:1）
  border: '#F0EDE8', // 暖灰边框
  borderSubtle: '#E8E4DE',
  accent: '#7986CB', // 强调靛蓝：描边 / 选中底色 / 装饰。别拿它当按钮底配白字
  accentDark: '#5C6BC0', // 主按钮底 + 主色文字用这个（配白字 4.86:1）
  accentSoft: 'rgba(121,134,203,0.09)',
  danger: '#C62828', // v0.2 从 #E57373 加深（原来配白字 2.99:1）
  success: '#2E7D32', // v0.2 从 #81C784 加深（原来配白字 2.01:1）
  white: '#FFFFFF',
  overlay: 'rgba(45,45,45,0.35)', // 遮罩
  // 相机页专用：取景区是深色，文字必须反过来
  cameraBackdrop: '#1C1A18',
  onCameraText: 'rgba(255,255,255,0.92)',
  onCameraTextDim: 'rgba(255,255,255,0.60)',
  onCameraSurface: 'rgba(255,255,255,0.12)',
  onCameraBorder: 'rgba(255,255,255,0.18)',
  frameGuide: '#FFE082', // 实时边框（暖黄，与选中的靛蓝区分）
  warningBg: '#FFF3E0',
  warningText: '#C43E00', // v0.2 从 #E65100 加深（原来在 warningBg 上只有 3.46:1）
};

/**
 * 触摸目标下限（Android 无障碍指南 48dp、Apple HIG 44pt，取 44 作为底线）。
 * v0.2 之前的现状是「全项目 minHeight 出现 0 次」，顶栏「完成」只有约 23dp 高 ——
 * 所有交互样式统一从这里取值，不要再手写 paddingVertical。
 */
export const TOUCH = {
  min: 44,
  /** 文字类小按钮的扩描边（不改变视觉高度，只扩大可点区） */
  slop: 12,
} as const;

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
};

export const RADIUS = {
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  pill: 999,
};

export const FONT_SIZE = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 18,
  xl: 22,
  xxl: 28,
  xxxl: 36,
};

/** 卡片：surface + RADIUS.lg + 1px 边框，无阴影（阴影只留给 TabBar / Toast / 浮层） */
export const CARD = {
  backgroundColor: COLORS.surface,
  borderRadius: RADIUS.lg,
  borderWidth: 1,
  borderColor: COLORS.border,
} as const;

// ===== 扫描模式（对标扫描全能王的滤镜档位）=====
export interface ScanModeDef {
  key: ScanMode;
  label: string;
  /** 一句话说明这档实际做了什么，结果页据此解释「智能」在哪 */
  hint: string;
}

export const SCAN_MODES: ScanModeDef[] = [
  { key: 'hd', label: '智能高清', hint: '自动切边 + 摊平光照去阴影 + 增强锐化' },
  { key: 'enhance', label: '增强', hint: '提亮纸面、加强对比与锐度，不做降噪' },
  { key: 'gray', label: '灰度', hint: '保留层次，适合图表和照片类内容' },
  { key: 'bw', label: '黑白', hint: '自适应阈值，纯文字最省纸最清楚' },
  { key: 'raw', label: '原图', hint: '只矫正角度，不改任何画质' },
];

export function findMode(key: string | null | undefined): ScanModeDef {
  return SCAN_MODES.find((m) => m.key === key) ?? SCAN_MODES[0];
}

/** 默认可信区间：这些常量只在原生层用一次，界面不再各处散写数字 */
export const OUTPUT_RESOLUTIONS = [2000, 3000, 4000] as const;
export const DEFAULT_OUTPUT_MAX_SIDE = 3000;
export const PDF_DPI = 300;

// ===== 全局事件名 =====
export const SCANNER_EVENTS = {
  SAVED: 'scanner:saved', // 一次扫描归档完成
  DATA_IMPORTED: 'scanner:data_imported',
  DOCS_CHANGED: 'scanner:docs_changed', // 文档增删改名，各页刷新
  SETTINGS_CHANGED: 'scanner:settings_changed',
} as const;

// 设置项 key
export const SETTING_KEYS = {
  DEFAULT_MODE: 'default_mode',
  AUTO_CROP: 'auto_crop', // 自动切边的全局默认值（扫描页那个开关是本组会话级，不写这里）
  OUTPUT_MAX_SIDE: 'output_max_side',
  JPEG_QUALITY: 'jpeg_quality',
  PDF_PAGE_SIZE: 'pdf_page_size', // auto / a4 / letter
  /** 首启教学看过没（存时间戳，只一次，之后不再打扰） */
  ONBOARDED_AT: 'onboarded_at',
  /** v0.2 实时取景边框（VisionCamera 帧处理器）；默认关，真机验过才敢默认开 */
  LIVE_DETECT: 'live_detect',
  LAST_QA_RUN: 'last_qa_run',
} as const;

/**
 * 系统字体放大上限。
 *
 * RN 的 Text 默认跟随系统字号，但界面里有大量固定高度（页条 62×82、缩略图框 108），
 * 用户开到 200% 时不是「变大」而是「被裁」。做法是两手：
 * 固定高度改成 minHeight + 内边距（布局让位），关键标签用这个倍数封顶（文字让位一点）。
 */
export const MAX_FONT_MULTIPLIER = 1.4;

// 生成 uuid（沿用 TapLedger 的做法：优先平台 crypto.randomUUID，
// 拿不到时退回「时间戳 + 进程内递增序号 + 每次启动随机盐 + 随机串」，同毫秒内也不会自撞。
// 只用 Math.random() 尾巴 8 个 base36 字符是不够的——文档/页面 uuid 撞车等于把自己的记录顶掉。）
const UUID_BOOT_SALT = Math.random().toString(36).slice(2, 10);
let uuidSeq = 0;

export function genUuid(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof webCrypto?.randomUUID === 'function') {
    try {
      return webCrypto.randomUUID();
    } catch {
      // Hermes 等环境可能只有空壳 crypto，继续走兜底实现
    }
  }
  uuidSeq = (uuidSeq + 1) % 1679616; // 36^4，够用且短
  return `${Date.now().toString(36)}-${uuidSeq
    .toString(36)
    .padStart(4, '0')}-${UUID_BOOT_SALT}${Math.random().toString(36).slice(2, 8)}`;
}

// 导出格式版本
export const EXPORT_VERSION = 1;
