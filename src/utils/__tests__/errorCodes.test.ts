import { describe, expect, it } from 'vitest';
// @ts-expect-error vite 的 ?raw 导入没有类型声明；这里就是要读 Kotlin 源文本来比对码表
import kotlinSource from '../../../native/android/ScanErrors.kt?raw';
import { SCANNER_ERRORS, scannerErrorMessage } from '../../native/errorText';

/**
 * 错误码的防漂移测试。
 *
 * 走查 audit-34 的事实是：Kotlin 侧会发 ERR_NATIVE / ERR_NO_ACTIVITY，而 JS 映射表里没有这两条，
 * 于是它们落进 default 分支、把英文原文糊到用户脸上。这类漂移靠肉眼永远看不出来，
 * 所以直接读那份 Kotlin 的常量表来比对。
 */
const kotlin = String(kotlinSource);
const declared = [...kotlin.matchAll(/const val [A-Z_]+ = "(ERR_[A-Z_]+)"/g)].map((m) => m[1]).sort();
const mirrored = Object.values(SCANNER_ERRORS).sort();

describe('原生错误码：Kotlin 与 JS 两张表必须一模一样', () => {
  it('ScanErrors.kt 里的每个码都在 SCANNER_ERRORS 里', () => {
    expect(declared.length).toBeGreaterThan(4);
    for (const code of declared) expect(mirrored).toContain(code);
  });

  it('SCANNER_ERRORS 里没有 Kotlin 那边不存在的码', () => {
    for (const code of mirrored) expect(declared).toContain(code);
  });

  it('每个码都有中文说法，不会退回英文原文直出', () => {
    for (const code of mirrored) {
      const text = scannerErrorMessage(code, 'boom');
      expect(text).not.toBe('boom');
      expect(text).not.toContain('ERR_');
      expect(text).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it('未知码也不能把英文句子原样端给用户', () => {
    expect(scannerErrorMessage('ERR_WHATEVER', 'boom')).toContain('处理失败');
  });
});
