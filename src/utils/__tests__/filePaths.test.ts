import { describe, expect, it } from 'vitest';
import { fileUri, isUsablePath, nativePath, withFileScheme } from '../filePaths';

/**
 * 这两条形态必须钉死：v0.1.0/v0.1.1 的真机崩溃就是把裸路径喂给了 expo-file-system，
 * 报的是 java.lang.IllegalArgumentException: URL is not absolute（在读 .exists 时才炸）。
 */
describe('nativePath（给原生 Kotlin 的裸路径）', () => {
  it('剥掉 file:// 前缀', () => {
    expect(nativePath('file:///data/user/0/com.tapscanner.app/files/a.jpg')).toBe(
      '/data/user/0/com.tapscanner.app/files/a.jpg',
    );
  });

  it('对裸路径幂等', () => {
    expect(nativePath('/data/a.jpg')).toBe('/data/a.jpg');
  });

  it('空值不炸', () => {
    expect(nativePath('')).toBe('');
  });
});

describe('withFileScheme（给 expo-file-system 的 URI）', () => {
  it('裸绝对路径补成三斜杠 URI', () => {
    expect(withFileScheme('/data/a.jpg')).toBe('file:///data/a.jpg');
  });

  it('已经是 URI 时幂等', () => {
    expect(withFileScheme('file:///data/a.jpg')).toBe('file:///data/a.jpg');
    expect(withFileScheme('file://a.jpg')).toBe('file://a.jpg');
  });

  it('缺前导斜杠时补上，避免拼出 file:data/a.jpg 这种非绝对 URI', () => {
    expect(withFileScheme('data/a.jpg')).toBe('file:///data/a.jpg');
  });

  it('别的 scheme 不乱改（content:// 是相册给的路径）', () => {
    expect(withFileScheme('content://media/external/images/1')).toBe('content://media/external/images/1');
  });

  it('往返：withFileScheme → nativePath 回到原值', () => {
    for (const p of ['/data/a.jpg', '/storage/emulated/0/x y.jpg', '/a/b/c.jpeg']) {
      expect(nativePath(withFileScheme(p))).toBe(p);
    }
  });
});

describe('fileUri', () => {
  it('与 withFileScheme 同义（给 <Image source> 和 Sharing 用）', () => {
    expect(fileUri('/data/a.jpg')).toBe(withFileScheme('/data/a.jpg'));
  });
});

describe('isUsablePath', () => {
  it('空串、只有 scheme、无斜杠的脏值都挡在入口', () => {
    expect(isUsablePath('')).toBe(false);
    expect(isUsablePath(null)).toBe(false);
    expect(isUsablePath(undefined)).toBe(false);
    expect(isUsablePath('file://')).toBe(false);
    expect(isUsablePath('a.jpg')).toBe(false);
    expect(isUsablePath('/data/a.jpg')).toBe(true);
    expect(isUsablePath('file:///data/a.jpg')).toBe(true);
  });
});
