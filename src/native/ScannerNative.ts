import { NativeModules, Platform } from 'react-native';
import type { AnalyzeResult, ProbeResult, ReadyInfo, ScanMode, QuadPoint } from '../types';

/**
 * 原生扫描模块的类型化入口（与 native/android/ScannerModule.kt 一一对应）。
 *
 * 以前这类桥是 NativeModules.X（any），方法名或参数写错只能等真机运行时暴露，
 * 所以契约集中声明在这里：改原生签名必须同步改这里，两处不一致会在 typecheck 就炸。
 */
export interface ScannerNativeModule {
  /** OpenCV 是否加载成功 + 版本 + 实际 ABI */
  isReady(): Promise<ReadyInfo>;
  /** 只量不画：指标 + 自动四角 + 是否真检测到 */
  analyze(path: string, maxSide: number): Promise<AnalyzeResult>;
  /**
   * 出成品。quad 传归一化四角拍平的 8 个数（[x0,y0,...]），
   * 传 null 表示让原生现场自动检测。
   */
  process(
    path: string,
    outPath: string,
    thumbPath: string,
    quad: number[] | null,
    mode: ScanMode,
    outputMaxSide: number,
    jpegQuality: number,
  ): Promise<import('../types').ProcessResult>;
  /** 图像层最小探针（诊断用） */
  probe(path: string, outPath: string, maxSide: number): Promise<ProbeResult>;
}

/**
 * 安全解析原生模块。
 *
 * 必须在 import 阶段就不抛错：新架构（bridgeless）下访问未注册的原生模块时，
 * NativeModules 的 Proxy 可能直接抛 invariant 而不是返回 undefined。
 * 这段在 App 启动时被求值，一旦抛出就是「点图标立刻闪退」，连一屏错误都看不到。
 * 吞掉后界面走「原生引擎不可用」的降级路径，并如实告诉用户。
 */
function resolveScannerModule(): ScannerNativeModule | null {
  if (Platform.OS !== 'android') return null;
  try {
    const mod = (NativeModules as Record<string, unknown>).ScannerModule;
    return (mod as ScannerNativeModule | undefined) ?? null;
  } catch (error) {
    console.warn('读取原生模块 ScannerModule 失败，智能高清不可用：', error);
    return null;
  }
}

/** 非 Android、原生模块未注入、或读取时抛错 —— 一律 null */
export const ScannerModule: ScannerNativeModule | null = resolveScannerModule();

/** 原生侧 reject 的错误码，逐条对照 native/android/ScanErrors.kt（改那边必须同步这里） */
export const SCANNER_ERRORS = {
  OPENCV: 'ERR_OPENCV',
  DECODE: 'ERR_DECODE',
  ENCODE: 'ERR_ENCODE',
  CANCELLED: 'ERR_CANCELLED',
  NATIVE: 'ERR_NATIVE',
  NOT_READY: 'ERR_NOT_READY',
  BAD_INPUT: 'ERR_BAD_INPUT',
  NO_ACTIVITY: 'ERR_NO_ACTIVITY',
} as const;

/** 错误码 → 用户能看懂的一句话（原生 message 通常更长，作为补充带上） */
export function scannerErrorMessage(code?: string, message?: string): string {
  const detail = message ? `（${message}）` : '';
  switch (code) {
    case SCANNER_ERRORS.OPENCV:
    case SCANNER_ERRORS.NOT_READY:
      return '图像引擎没加载成功，重启一次试试';
    case SCANNER_ERRORS.DECODE:
      return `这张图读不出来${detail}`;
    case SCANNER_ERRORS.ENCODE:
      return `图片保存失败${detail}`;
    case SCANNER_ERRORS.BAD_INPUT:
      return `参数不对${detail}`;
    case SCANNER_ERRORS.CANCELLED:
      return '已取消处理';
    default:
      return message ? `处理失败：${message}` : '处理失败，请重试';
  }
}

/** 从 reject 出来的 error 上取错误码（RN 的 NativeError 带 code，但不是每个环境都有） */
export function scannerErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export class ScannerUnavailable extends Error {
  constructor() {
    super('图像引擎不可用（原生模块 ScannerModule 未注入）');
    this.name = 'ScannerUnavailable';
  }
}

function requireModule(): ScannerNativeModule {
  if (!ScannerModule) throw new ScannerUnavailable();
  return ScannerModule;
}

export async function isEngineReady(): Promise<ReadyInfo> {
  if (!ScannerModule) return { ready: false, version: '', abi: '' };
  try {
    return await ScannerModule.isReady();
  } catch {
    return { ready: false, version: '', abi: '' };
  }
}

export function analyzeImage(path: string, maxSide = 1200): Promise<AnalyzeResult> {
  return requireModule().analyze(path, maxSide);
}

export interface ProcessArgs {
  path: string;
  outPath: string;
  thumbPath: string;
  /** 归一化四角；null = 让原生自动检测 */
  quad: QuadPoint[] | null;
  mode: ScanMode;
  outputMaxSide?: number;
  jpegQuality?: number;
}

export function quadToFlat(quad: QuadPoint[]): number[] {
  const flat: number[] = [];
  for (const p of quad) flat.push(p.x, p.y);
  return flat;
}

export function processPage(args: ProcessArgs) {
  const flat = args.quad ? quadToFlat(args.quad) : null;
  if (flat && flat.length !== 8) throw new Error(`四角必须是 4 个点，实际 ${args.quad?.length ?? 0}`);
  return requireModule().process(
    args.path,
    args.outPath,
    args.thumbPath,
    flat,
    args.mode,
    args.outputMaxSide ?? 3000,
    args.jpegQuality ?? 92,
  );
}

export function probeImage(path: string, outPath: string, maxSide = 1200): Promise<ProbeResult> {
  return requireModule().probe(path, outPath, maxSide);
}
