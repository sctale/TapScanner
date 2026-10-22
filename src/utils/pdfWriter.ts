import { File } from 'expo-file-system';
import { assemblePdf, type PdfMeta, type PdfPageBytes } from './pdfBytes';
import { withFileScheme } from './filePaths';

/**
 * PDF 的文件层：读 JPEG 字节 → 交给纯字节层组装 → 写盘。
 *
 * 组 PDF 的逻辑在 pdfBytes.ts（不 import RN/expo，因此能在 vitest 里逐字节断言）；
 * 这一层只碰文件系统，故意薄到没什么可错。
 */

export { assemblePdf, objectIdForPage } from './pdfBytes';
export type { PdfMeta, PdfPageBytes } from './pdfBytes';

export interface PdfPageFile {
  /** JPEG 路径（裸路径或 file:// 都行） */
  path: string;
  widthPx: number;
  heightPx: number;
  dpi?: number;
}

/** 读文件 → 组 PDF 字节。任何一页缺文件都直接抛，不产出「少一页的 PDF」 */
export async function buildPdfFromFile(pages: PdfPageFile[], meta?: PdfMeta): Promise<Uint8Array> {
  const entries: PdfPageBytes[] = [];
  for (const page of pages) {
    const file = new File(withFileScheme(page.path));
    if (!file.exists) throw new Error(`PDF 缺少一页：${page.path}`);
    const buffer = await file.arrayBuffer();
    entries.push({
      jpeg: new Uint8Array(buffer),
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      dpi: page.dpi,
    });
  }
  return assemblePdf(entries, meta);
}

/** 写二进制到文件（expo-file-system 的 write 接受 ArrayBuffer/ArrayBufferView） */
export async function writeBytes(path: string, bytes: Uint8Array): Promise<number> {
  const file = new File(withFileScheme(path));
  try {
    if (!file.parentDirectory.exists) file.parentDirectory.create({ intermediates: true });
  } catch {
    // 目录已存在时 create 会抛；这里不当错误
  }
  file.write(bytes);
  return file.size ?? bytes.length;
}
