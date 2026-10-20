import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { DeviceEventEmitter } from 'react-native';
import { EXPORT_VERSION, SCANNER_EVENTS, SETTING_KEYS } from '../constants';
import { appendPage, createDocument, exportAll, setSetting } from '../database/scannerDB';
import { directoryBytes, documentDir, exportNamedFile, stampName } from './scanFiles';
import { safeFileName } from './exportActions';
import { FULL_FRAME_QUAD } from './quad';
import type { QuadPoint, ScanMode } from '../types';

/**
 * 备份：导出记录 + 文件清单，导入时校验图片是否还在本机。
 *
 * 刻意不把图片塞进 JSON（base64 会把一份几十 MB 的扫描件变成一个几百 MB 的文件，
 * 分享面板会直接卡死）。Tap 系列的备份定位是「换机/重装后先把记录结构拿回来」，
 * 图片本体要靠把 scans/ 目录一起拷过去 —— 这一点在管理页写清楚，不含糊。
 */

const EXCLUDED_SETTING_PREFIX = 'sync.'; // 本项目没有同步，但保留剔除私有键的机制（沿用 TapLedger 的安全约定）

export interface BackupPayload {
  version: number;
  exportedAt: string;
  documents: number;
  pages: number;
  settings: Record<string, string>;
  rows: Awaited<ReturnType<typeof exportAll>>;
}

function sanitizeSettings(settings: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith(EXCLUDED_SETTING_PREFIX)) continue;
    out[key] = value;
  }
  return out;
}

export async function exportBackupJson(): Promise<{ ok: boolean; message: string }> {
  const all = await exportAll();
  if (all.documents.length === 0) return { ok: false, message: '还没有可导出的文档' };

  const payload: BackupPayload = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    documents: all.documents.length,
    pages: all.pages.length,
    settings: sanitizeSettings(all.settings),
    rows: all,
  };

  const file = exportNamedFile(safeFileName(stampName('tapscanner_backup', 'json')));
  file.create({ intermediates: true, overwrite: true });
  file.write(JSON.stringify(payload, null, 2));

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      dialogTitle: '导出备份',
      UTI: 'public.json',
    });
    return { ok: true, message: `已导出 ${all.documents.length} 份文档、${all.pages.length} 页` };
  }
  return { ok: true, message: `备份已写到 ${file.name}，但这台设备不支持分享面板` };
}

export interface ImportResult {
  ok: boolean;
  documents: number;
  skipped: number;
  message?: string;
}

/**
 * 导入：文件名靠 File.pickFileAsync 选（不引 expo-document-picker，少一个原生模块）。
 * 每一页都先确认 raw/out 两个文件真的还在，缺文件的文档整份跳过 ——
 * 导进一堆打不开的记录比少几份记录更糟。
 */
export async function importBackupJson(): Promise<ImportResult> {
  let file: File | null = null;
  try {
    const picked = await File.pickFileAsync();
    if (!picked.canceled && picked.result) {
      file = Array.isArray(picked.result) ? (picked.result[0] ?? null) : picked.result;
    }
  } catch {
    return { ok: false, documents: 0, skipped: 0, message: '这台设备没提供文件选择入口' };
  }
  if (!file) return { ok: false, documents: 0, skipped: 0, message: '已取消' };

  let payload: BackupPayload;
  try {
    const text = await file.text();
    payload = JSON.parse(text) as BackupPayload;
  } catch {
    return { ok: false, documents: 0, skipped: 0, message: '这个文件不是合法的备份 JSON' };
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.rows?.documents)) {
    return { ok: false, documents: 0, skipped: 0, message: '备份内容不对（缺 documents）' };
  }

  let imported = 0;
  let skipped = 0;
  for (const doc of payload.rows.documents) {
    const pages = payload.rows.pages.filter((p) => p.documentId === doc.id);
    if (pages.length === 0) {
      skipped += 1;
      continue;
    }
    // 图片必须在这台机器上：目录存在 + 至少一页成品在
    const dir = documentDir(doc.uuid);
    if (!dir.exists || directoryBytes(doc.uuid) <= 0) {
      skipped += 1;
      continue;
    }
    if (await getDocumentByUuid(doc.uuid)) {
      skipped += 1; // 已经在了，不重复导入
      continue;
    }
    const created = await createDocument(doc.title, doc.uuid);
    for (const page of pages) {
      await appendPage({
        documentId: created.id,
        rawPath: page.rawPath,
        outPath: page.outPath,
        thumbPath: page.thumbPath,
        mode: page.mode as ScanMode,
        quad:
          Array.isArray(page.quad) && page.quad.length === 4 ? (page.quad as QuadPoint[]) : FULL_FRAME_QUAD,
        metrics: page.metrics,
        stages: page.stages,
        width: page.width,
        height: page.height,
      });
    }
    imported += 1;
  }

  for (const [key, value] of Object.entries(payload.settings ?? {})) {
    if (key.startsWith(EXCLUDED_SETTING_PREFIX)) continue;
    if (!ALL_SETTING_KEYS.has(key)) continue;
    await setSetting(key, value);
  }

  if (imported > 0) DeviceEventEmitter.emit(SCANNER_EVENTS.DATA_IMPORTED, { imported });
  return {
    ok: imported > 0,
    documents: imported,
    skipped,
    message:
      imported === 0
        ? `没有可导入的文档（${skipped} 份缺图片或已存在）。图片没拷过来的话，先把 scans 目录一起搬过去`
        : undefined,
  };
}

const ALL_SETTING_KEYS = new Set<string>(Object.values(SETTING_KEYS) as string[]);

async function getDocumentByUuid(uuid: string): Promise<boolean> {
  // 没有按 uuid 查的接口，用列表查一次即可（导入是一次性操作，不追求快）
  const { listDocuments } = await import('../database/scannerDB');
  const docs = await listDocuments();
  return docs.some((d) => d.uuid === uuid);
}
