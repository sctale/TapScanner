import { genUuid } from '../constants';
import { analyzeImage, processPage, ScannerUnavailable } from '../native/ScannerNative';
import {
  documentDir,
  ensureDirectory,
  nativePath,
  rawFile,
  relocateIntoDocument,
  renderFile,
  thumbFile,
} from './scanFiles';
import { suggestMode, type ModeSuggestion } from './modeSelection';
import { FULL_FRAME_QUAD } from './quad';
import { appendPage, createDocument } from '../database/scannerDB';
import type { AnalyzeResult, ProcessResult, QuadPoint, ScanMode } from '../types';

/**
 * 一次扫描的编排：相机/相册文件 → 搬进文档目录 → 感知 → 出成品 → 落库。
 *
 * 顺序上的两个硬规定：
 *   1. **先搬文件再分析**。相机临时文件在 cache，随时会被系统回收；
 *      任何写进数据库的路径都必须已经在文档目录里。
 *   2. **docUuid 先于第一次拍摄产生**（此时还没有数据库行），
 *      保存时才 createDocument 用同一个 uuid —— 这样目录名和记录永远一一对应，
 *      中途放弃也只留下一个空目录，由管理页的「清理未引用文件」回收。
 */

export interface RawCapture {
  uuid: string;
  rawPath: string;
  /** 转正后的原始图尺寸 */
  width: number;
  height: number;
  analyze: AnalyzeResult;
  suggestion: ModeSuggestion;
}

export interface RenderedPage {
  uuid: string;
  rawPath: string;
  result: ProcessResult;
  mode: ScanMode;
  quad: QuadPoint[];
}

export interface RenderOptions {
  autoCrop: boolean;
  outputMaxSide: number;
  jpegQuality?: number;
}

/** 把相机/相册的临时文件搬进文档目录（单独一步，好让界面能分清「搬运挂」还是「感知挂」） */
export async function importSource(
  sourcePath: string,
  docUuid: string,
): Promise<{ pageUuid: string; rawPath: string }> {
  ensureDirectory(documentDir(docUuid));
  const pageUuid = genUuid();
  const dest = rawFile(docUuid, pageUuid);
  const rawPath = await relocateIntoDocument(sourcePath, dest);
  return { pageUuid, rawPath };
}

/** 对已经落在文档目录里的 raw 做感知 + 边界检测 */
export async function analyzeRaw(pageUuid: string, rawPath: string): Promise<RawCapture> {
  const analyze = await analyzeImage(rawPath);
  return {
    uuid: pageUuid,
    rawPath,
    width: analyze.width,
    height: analyze.height,
    analyze,
    suggestion: suggestMode(analyze.metrics),
  };
}

/** 相机/相册的临时文件 → 文档目录里的 raw + 感知结果 */
export async function captureRaw(sourcePath: string, docUuid: string): Promise<RawCapture> {
  const imported = await importSource(sourcePath, docUuid);
  return analyzeRaw(imported.pageUuid, imported.rawPath);
}

/**
 * 出成品。
 * quad 传 null 时沿用感知阶段的自动框；关掉自动切边时传整页框（只矫正、不裁）。
 */
export async function renderCapture(
  capture: RawCapture,
  docUuid: string,
  mode: ScanMode,
  quad: QuadPoint[] | null,
  options: RenderOptions,
): Promise<RenderedPage> {
  const out = renderFile(docUuid, capture.uuid);
  const thumb = thumbFile(docUuid, capture.uuid);
  const usedQuad = options.autoCrop ? (quad ?? capture.analyze.quad) : FULL_FRAME_QUAD;

  const result = await processPage({
    path: capture.rawPath,
    outPath: nativePath(out.uri),
    thumbPath: nativePath(thumb.uri),
    quad: usedQuad,
    mode,
    outputMaxSide: options.outputMaxSide,
    jpegQuality: options.jpegQuality ?? 92,
  });

  return { uuid: capture.uuid, rawPath: capture.rawPath, result, mode, quad: usedQuad };
}

export interface SavedDocument {
  id: number;
  uuid: string;
  title: string;
  pageCount: number;
}

/**
 * 事后换档：已归档的某一页用同一张 raw 重新出一版成品。
 *
 * 这是「自动值只是建议」在文档层的延伸 —— 当时没调对，之后仍可改，不必重拍。
 * raw 图一直在文档目录里（见 scanFiles 的第 1 条约定），所以这里永远有原始数据可回到。
 */
export async function rerenderPage(input: {
  docUuid: string;
  pageUuid: string;
  rawPath: string;
  mode: ScanMode;
  quad: QuadPoint[] | null;
  autoCrop: boolean;
  outputMaxSide: number;
  jpegQuality?: number;
}): Promise<{ result: ProcessResult; quad: QuadPoint[] }> {
  const out = renderFile(input.docUuid, input.pageUuid);
  const thumb = thumbFile(input.docUuid, input.pageUuid);
  const quad = input.autoCrop ? input.quad : FULL_FRAME_QUAD;
  const result = await processPage({
    path: input.rawPath,
    outPath: nativePath(out.uri),
    thumbPath: nativePath(thumb.uri),
    quad,
    mode: input.mode,
    outputMaxSide: input.outputMaxSide,
    jpegQuality: input.jpegQuality ?? 92,
  });
  return { result, quad: result.usedQuad };
}

/** 多页一起归档（一次拍完再存，符合「拍 → 看 → 存」的实际用法） */
export async function savePagesAsDocument(
  docUuid: string,
  title: string,
  pages: RenderedPage[],
): Promise<SavedDocument> {
  if (pages.length === 0) throw new Error('至少有一页才能保存');
  // 数据库记录复用拍摄时的 docUuid：目录名与记录天然一一对应，不需要搬文件
  const document = await createDocument(title, docUuid);
  for (const page of pages) {
    const rawPath = nativePath(rawFile(document.uuid, page.uuid).uri);
    await appendPage({
      documentId: document.id,
      rawPath,
      outPath: page.result.outPath,
      thumbPath: page.result.thumbPath,
      mode: page.mode,
      quad: page.quad,
      metrics: page.result.metricsAfter,
      stages: page.result.stages,
      width: page.result.width,
      height: page.result.height,
    });
  }
  return { id: document.id, uuid: document.uuid, title: document.title, pageCount: pages.length };
}

export { ScannerUnavailable };
