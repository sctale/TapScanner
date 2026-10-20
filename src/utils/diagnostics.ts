import { File, Paths } from 'expo-file-system';

/**
 * 错误现场留存。
 *
 * 为什么需要它：这个 App 的失败点全在原生/相机层，而 Toast 2 秒就没了 ——
 * 手机不在开发者手边、也连不上 adb 时，「屏幕上有过一行英文」是唯一的线索来源。
 * 所以每次失败都把**完整**的环节名 + 错误码 + message + stack 落盘并留在内存里，
 * 界面上渲染成常驻卡片（可截图），管理页「关于与自检」里也能回看最近一次。
 *
 * 抄的是 anti-car-sickness 的 CrashCapture 思路：不要指望用户能复述报错，
 * 把现场留在屏幕上，一张截图就能定位。
 */

export type FailureStep =
  | 'capture' // VisionCamera 拍照出文件
  | 'capture-fallback'
  | 'relocate' // 临时文件搬进应用目录
  | 'analyze' // 原生感知 + 边界检测
  | 'process' // 原生增强出成品
  | 'save' // 落库
  | 'export-pdf'
  | 'share';

export interface FailureRecord {
  step: FailureStep;
  code: string;
  message: string;
  stack: string;
  at: number;
  /** 现场上下文：路径、尺寸、档位等，定位「只有某张图会崩」这类问题 */
  context?: Record<string, string | number | boolean | null>;
}

const DIAG_FILE = (() => {
  try {
    return new File(Paths.document, 'diagnostics', 'last_error.txt');
  } catch {
    return null;
  }
})();

let last: FailureRecord | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** 从任何 throw 出来的东西里尽量榨出信息（RN 原生异常不是 Error 实例，code 挂在自身属性上） */
function extract(error: unknown): { code: string; message: string; stack: string } {
  if (!error) return { code: 'UNKNOWN', message: '未知错误（没有异常对象）', stack: '' };
  if (typeof error === 'string') return { code: 'UNKNOWN', message: error, stack: '' };
  // RN 的原生异常不是标准 Error：code 挂在对象自身属性上，用结构化读取而不是 instanceof
  const e = error as { code?: unknown; message?: unknown; stack?: unknown; name?: unknown };
  const code = readString(e.code, readString(e.name, 'UNKNOWN'));
  const message = readString(e.message, String(e));
  const stack = readString(e.stack);
  return { code, message, stack };
}

export function formatFailure(record: FailureRecord): string {
  const time = new Date(record.at).toLocaleTimeString();
  const lines = [`环节 ${record.step} · ${time}`, `错误码 ${record.code}`, record.message];
  if (record.context && Object.keys(record.context).length > 0) {
    lines.push(
      Object.entries(record.context)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' '),
    );
  }
  if (record.stack) {
    // stack 只留前 6 行：卡片要能一眼读完，完整内容在落盘文件里
    lines.push(record.stack.split('\n').slice(0, 6).join('\n'));
  }
  return lines.join('\n');
}

export function recordFailure(
  step: FailureStep,
  error: unknown,
  context?: FailureRecord['context'],
): FailureRecord {
  const { code, message, stack } = extract(error);
  const record: FailureRecord = { step, code, message, stack, at: Date.now(), context };
  last = record;
  emit();
  try {
    if (DIAG_FILE) {
      // 沿用 TapLedger 的写法：先 create（含 intermediates），再 write
      DIAG_FILE.create({ intermediates: true, overwrite: true });
      DIAG_FILE.write(`${formatFailure(record)}\n\n=== 完整 stack ===\n${stack}\n`);
    }
  } catch {
    // 落盘失败不能把错误上报本身也弄崩：内存里那份还在，界面上还能看
  }
  return record;
}

export function lastFailure(): FailureRecord | null {
  return last;
}

export function clearFailure(): void {
  last = null;
  emit();
}

export function subscribeFailure(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
