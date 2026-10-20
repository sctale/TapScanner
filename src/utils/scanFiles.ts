import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

/**
 * 扫描件的落盘规则（唯一真源）。
 *
 * 三条硬约定：
 *   1. 一律放 `Paths.document/scans/<docUuid>/`。**不许用 cache** ——
 *      相机临时文件在缓存目录里，系统会在空间紧张时直接删掉，用户看到的是「文档打不开」。
 *   2. 多段路径必须变参拼接（`new Directory(Paths.document, 'scans', uuid)`）。
 *      写成 `new File(dir, 'a/b.jpg')` 在 Android 上会静默错位（TapMood 实测踩过）。
 *   3. 交给原生的路径是裸路径（去掉 file:// 前缀），原生侧也各自兜一次，两处都不会漏。
 */

const SCANS = 'scans';
const EXPORT = 'export';

export function scansRoot(): Directory {
  return new Directory(Paths.document, SCANS);
}

export function documentDir(docUuid: string): Directory {
  return new Directory(Paths.document, SCANS, docUuid);
}

export function exportDir(): Directory {
  return new Directory(Paths.document, EXPORT);
}

/** 目录懒创建（幂等）。list() 在父目录不存在时会抛，所以调用前先确保存在 */
export function ensureDirectory(dir: Directory): Directory {
  try {
    if (!dir.exists) dir.create({ intermediates: true });
  } catch {
    // 已存在时 create 会抛；这里不把它当错误
  }
  return dir;
}

/** 页内文件名：raw_ 是相机原图，page_ 是成品，thumb_ 是列表缩略图 */
export const rawFilePattern = /^raw_[A-Za-z0-9-]+\.jpg$/;

export function rawFile(docUuid: string, pageUuid: string): File {
  return new File(documentDir(docUuid), `raw_${pageUuid}.jpg`);
}

export function renderFile(docUuid: string, pageUuid: string): File {
  return new File(documentDir(docUuid), `page_${pageUuid}.jpg`);
}

export function thumbFile(docUuid: string, pageUuid: string): File {
  return new File(documentDir(docUuid), `thumb_${pageUuid}.jpg`);
}

export function exportNamedFile(fileName: string): File {
  ensureDirectory(exportDir());
  return new File(exportDir(), fileName);
}

/** 时间戳文件名：20261020-1435 这种，用户拿去分享时一眼认得是哪天 */
export function stampName(prefix: string, ext: string): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `${prefix}_${stamp}.${ext}`;
}

/**
 * 把相机/相册的临时文件搬进文档目录。
 *
 * 返回值是**目的地的裸路径**；搬不动就抛错，绝不返回一个指向 cache 的路径 ——
 * 那等于把一个随时会消失的文件写进数据库。
 */
export async function relocateIntoDocument(source: string, dest: File): Promise<string> {
  ensureDirectory(dest.parentDirectory);
  const from = new File(nativePath(source));
  if (!from.exists) throw new Error(`原始图片不存在：${source}`);
  await from.move(dest, { overwrite: true });
  // move 之后 dest 实例才是有效引用；用它的 uri 反推裸路径
  if (!dest.exists) throw new Error(`搬运后文件不在预期位置：${dest.uri}`);
  return nativePath(dest.uri);
}

export function nativePath(uriOrPath: string): string {
  return uriOrPath.startsWith('file://') ? uriOrPath.slice('file://'.length) : uriOrPath;
}

export function fileUri(path: string): string {
  if (path.startsWith('file://')) return path;
  return Platform.OS === 'android' ? `file://${path}` : `file://${path}`;
}

export function fileSize(path: string | null | undefined): number {
  if (!path) return 0;
  try {
    const file = new File(nativePath(path));
    return file.exists ? (file.size ?? 0) : 0;
  } catch {
    return 0;
  }
}

export function deleteFile(path: string | null | undefined): boolean {
  if (!path) return false;
  try {
    const file = new File(nativePath(path));
    if (!file.exists) return false;
    file.delete();
    return true;
  } catch {
    return false;
  }
}

/** 整个文档目录删掉（数据库记录由调用方删；两边都要做，否则会留孤儿文件） */
export function deleteDocumentFiles(docUuid: string | null | undefined): number {
  if (!docUuid) return 0;
  try {
    const dir = documentDir(docUuid);
    if (!dir.exists) return 0;
    const count = dir.list().length;
    dir.delete();
    return count;
  } catch {
    return 0;
  }
}

/** 扫描目录下所有文档目录名（清理未引用文件时与数据库对照用） */
export function listDocumentDirs(): string[] {
  try {
    const root = scansRoot();
    if (!root.exists) return [];
    // list() 返回的是 File/Directory 实例（不是文件名），取 .name
    return root
      .list()
      .map((item) => item.name)
      .filter((name) => typeof name === 'string' && name.length > 0);
  } catch {
    return [];
  }
}

/** 目录占用字节数（管理页「存储占用」用） */
export function directoryBytes(docUuid: string): number {
  try {
    const dir = documentDir(docUuid);
    if (!dir.exists) return 0;
    let total = 0;
    for (const item of dir.list()) {
      try {
        const file = new File(dir, item.name);
        if (file.exists) total += file.size ?? 0;
      } catch {
        // 单个文件读不到不影响总量统计
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
