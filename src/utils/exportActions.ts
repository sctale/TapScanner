import * as Sharing from 'expo-sharing';
import { getDocument, listPages } from '../database/scannerDB';
import { buildPdfFromFile, writeBytes } from './pdfWriter';
import { ensureDirectory, exportDir, exportNamedFile, fileUri, nativePath, stampName } from './scanFiles';
import { DEFAULT_SCAN_DPI } from './pageSize';
import type { DocumentRecord } from '../types';

/**
 * 导出与分享。
 *
 * PDF 走 DCTDecode 直传（见 pdfWriter.ts），所以导出不会让画质掉一档；
 * 分享一律用系统面板，因此不做「MediaStore 保存到下载目录」这条路 ——
 * 面板里本来就有「保存到文件/下载」，多写一套原生存储代码只是多一份权限与崩的机会。
 */

export interface ExportResult {
  path: string;
  pages: number;
  bytes: number;
}

export async function exportDocumentPdf(documentId: number): Promise<ExportResult> {
  const document = await getDocument(documentId);
  if (!document) throw new Error('文档不存在');
  const pages = await listPages(documentId);
  if (pages.length === 0) throw new Error('这份文档还没有页面');

  const usable = pages.filter((p) => p.outPath && p.width > 0 && p.height > 0);
  if (usable.length !== pages.length) {
    // 有页缺成品图（处理失败或文件被清）时，绝不能出一份「少一页但看起来完整」的 PDF
    throw new Error(`${pages.length - usable.length} 页没有成品图，请重拍那一页再导出`);
  }

  ensureDirectory(exportDir());
  const bytes = await buildPdfFromFile(
    usable.map((p) => ({
      path: p.outPath,
      widthPx: p.width,
      heightPx: p.height,
      dpi: DEFAULT_SCAN_DPI,
    })),
    { title: document.title },
  );
  const file = exportNamedFile(safeFileName(`${stampName(document.title, 'pdf')}`));
  const written = await writeBytes(nativePath(file.uri), bytes);

  // 记在库上，管理页能看出这份文档已经出过 PDF
  const { setDocumentPdfPath } = await import('../database/scannerDB');
  await setDocumentPdfPath(document.id, nativePath(file.uri));
  return { path: nativePath(file.uri), pages: usable.length, bytes: written };
}

/** 单页成品图直接分享（JPG 原样，不重编码） */
export async function sharePageJpg(outPath: string, title: string): Promise<void> {
  await shareFile(outPath, 'image/jpeg', title);
}

export async function shareFile(path: string, mimeType: string, dialogTitle: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('这台设备不支持分享');
  await Sharing.shareAsync(fileUri(path), { mimeType, dialogTitle, UTI: mimeType });
}

/** 文件名安全化：标题里带 / : ? * 时不能直接当文件名（写盘会失败，而错误信息看不出为什么） */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 96);
}

export function describeDocument(document: DocumentRecord): string {
  return `${document.title} · ${document.pageCount} 页`;
}
