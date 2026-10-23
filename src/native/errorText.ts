/**
 * 错误码与「说人话」的映射表（纯模块，不碰 react-native）。
 *
 * 单独成文件只有一个理由：让 errorCodes.test.ts 能在 node 里 import 它。
 * 放在 ScannerNative.ts 里就会连带把 NativeModules 拖进测试环境，直接跑不起来。
 * 而这张表恰恰是最需要被测试盯着的 —— 走查 audit-34 就是 Kotlin 发了码、JS 没有 case，
 * 结果英文原文糊到用户脸上。
 */
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
    case SCANNER_ERRORS.NATIVE:
      return `处理失败${detail || '，请重试'}`;
    case SCANNER_ERRORS.NO_ACTIVITY:
      return '找不到当前界面，重新打开 App 再试一次';
    default:
      return message ? `处理失败：${message}` : '处理失败，请重试';
  }
}

/** 从 reject 出来的 error 上取错误码（RN 的 NativeError 带 code，但不是每个环境都有） */
export function scannerErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}
