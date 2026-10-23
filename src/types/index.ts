/** 滤镜档位（与原生 DocPipeline 的 preset 字符串一致，改一边必须改另一边） */
export type ScanMode = 'hd' | 'enhance' | 'gray' | 'bw' | 'raw';

/** 归一化四角坐标（0..1），顺序固定为 左上→右上→右下→左下 */
export interface QuadPoint {
  x: number;
  y: number;
}

/** 图像感知指标（原生 Metrics.kt 产出；判定表在 src/utils/modeSelection.ts，可被 vitest 覆盖） */
export interface ImageMetrics {
  /** 平均亮度 0..255 */
  brightness: number;
  /** 亮度标准差（对比度） */
  contrast: number;
  /** 色彩丰富度：HSV 的 S 通道均值 0..255 */
  saturation: number;
  /** 亮度中位数 0..255（原生 Canny 阈值的基准） */
  median: number;
  /** Laplacian 方差：越小越糊 */
  blurScore: number;
  /** 背景（光照）动态范围归一：越大说明侧光/阴影越重 */
  shadowScore: number;
  /** 高频能量占比：摩尔纹的粗判，只用来决定「要不要避开降噪」，不做去纹 */
  moireScore: number;
  /** 白场覆盖率（>=235 的像素占比）：衡量纸面有多白 */
  whiteCoverage: number;
  /** 指标计算耗时 */
  elapsedMs: number;
}

export interface StageTimings {
  decodeMs: number;
  warpMs: number;
  enhanceMs: number;
  encodeMs: number;
  totalMs: number;
}

/** analyze()：只量不画 */
export interface AnalyzeResult {
  metrics: ImageMetrics;
  /** 归一化四角；原生保证一定有值（最差是 3% 内缩框），detected=false 表示那是回退框 */
  quad: QuadPoint[];
  /** true = 真检测到纸边；false = 回退框，界面要提示用户确认 */
  detected: boolean;
  confidence: number;
  /**
   * 原生用了哪条路：bright 亮区 / dark 暗区 / edge 梯度边缘 / full 纸铺满画面 /
   * rect 最小外接矩形 / inset 回退内缩框。
   * 出问题时看这个字段就知道该查哪条腿，不用靠猜。
   */
  source: string;
  /** 检出四边形占画面面积比 */
  areaRatio: number;
  /** 原图（已按 EXIF 转正后）尺寸 */
  width: number;
  height: number;
  rotationDegrees: number;
  detectMs: number;
  totalMs: number;
}

/** process()：真正产出扫描件 */
export interface ProcessResult {
  outPath: string;
  thumbPath: string;
  /** 1200px 预览图（审核页与四角层用它，不碰全分辨率成品）；空串 = 没写 */
  previewPath: string;
  width: number;
  height: number;
  mode: ScanMode;
  metricsBefore: ImageMetrics;
  metricsAfter: ImageMetrics;
  /** >1.0 表示锐度确实提升了；界面只在 >1.05 时才说「清晰度提升」 */
  sharpnessGain: number;
  stages: StageTimings;
  /** 原生实际使用的四角（可能与传入不同：例如做了排序） */
  usedQuad: QuadPoint[];
  /** true = 自动切边确实检到了纸边 */
  autoCropped: boolean;
}

export interface ProbeResult {
  outPath: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  elapsedMs: number;
}

export interface ReadyInfo {
  ready: boolean;
  version: string;
  abi: string;
}

/** PDF 页面尺寸策略：auto = 每页跟随自己的比例；a4/letter = 等比放进固定纸张画布留白 */
export type PageSizeMode = 'auto' | 'a4' | 'letter';

/** 出成品时用哪一套参数（唯一真源见 src/utils/renderOptions.ts） */
export interface RenderOptions {
  autoCrop?: boolean;
  outputMaxSide?: number;
  jpegQuality?: number;
  pageSizeMode?: PageSizeMode;
}

export interface PdfResult {
  outPath: string;
  pages: number;
  bytes: number;
}

/** 页面记录（SQLite pages 表；quad/metrics/stages 存 JSON 文本） */
export interface PageRecord {
  id: number;
  uuid: string;
  documentId: number;
  position: number;
  rawPath: string;
  outPath: string;
  /** 1200px 预览：用 previewFromOutPath(outPath) 推导，不落库（同目录同 uuid，纯函数关系） */
  thumbPath: string;
  mode: ScanMode;
  quad: QuadPoint[] | null;
  metrics: ImageMetrics | null;
  stages: StageTimings | null;
  width: number;
  height: number;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentRecord {
  id: number;
  uuid: string;
  title: string;
  pageCount: number;
  coverPath: string | null;
  pdfPath: string | null;
  starred: boolean;
  /** >0 = 在回收站里（值 = 丢进去的时间戳）；0 = 正常 */
  deletedAt: number;
  createdAt: number;
  updatedAt: number;
}

/** 待处理的拍摄结果（还没进文档队列的原始文件） */
export interface CapturedPage {
  uuid: string;
  rawPath: string;
  width: number;
  height: number;
}
