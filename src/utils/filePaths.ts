/**
 * 文件路径的两种形态，必须分开（v0.1.0/v0.1.1 的真机崩溃就是这么来的）。
 *
 * - `nativePath()`：裸绝对路径 `/data/user/0/...`，**只给原生模块**（Kotlin 的 java.io.File 收路径）。
 * - `withFileScheme()`：`file:///data/...`，**只给 expo-file-system 的 File/Directory 构造函数**。
 *   它内部把字符串按 URI 解析（FileSystemPath.checkPermission → JavaFile → new java.io.File(URI)），
 *   传裸路径会抛 `IllegalArgumentException: URL is not absolute`，而且是在读 `.exists` 时才抛，
 *   看起来像「文件不存在」，实际是「我根本没看懂这个路径」。
 *
 * 这个文件刻意不 import 任何 RN/expo 模块，所以能在 vitest 里钉住往返关系。
 */

const SCHEME = 'file://';

/** 去掉 file:// 前缀，得到原生侧要用的裸路径（幂等：没前缀时原样返回） */
export function nativePath(pathOrUri: string): string {
  if (!pathOrUri) return '';
  return pathOrUri.startsWith(SCHEME) ? pathOrUri.slice(SCHEME.length) : pathOrUri;
}

/** 补上 file:// 前缀，得到 expo-file-system 要的 URI 形态（幂等） */
export function withFileScheme(pathOrUri: string): string {
  if (!pathOrUri) return '';
  if (pathOrUri.startsWith(SCHEME)) return pathOrUri;
  // 已经是别的 scheme（content://、http://）时不要乱改
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(pathOrUri)) return pathOrUri;
  return `${SCHEME}${pathOrUri.startsWith('/') ? '' : '/'}${pathOrUri}`;
}

/** 给 <Image source> / Sharing 用的 URI（与 withFileScheme 同义，语义上更清楚） */
export function fileUri(pathOrUri: string): string {
  return withFileScheme(pathOrUri);
}

/**
 * 是不是一个能用的路径。
 * 空串和只有 scheme 的串都会让下游抛难懂的异常，入口先挡住。
 */
export function isUsablePath(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const bare = nativePath(value);
  return bare.length > 1 && bare.includes('/');
}
