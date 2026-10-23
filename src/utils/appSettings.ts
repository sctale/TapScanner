import { DeviceEventEmitter } from 'react-native';
import { SCANNER_EVENTS, SETTING_KEYS } from '../constants';
import { getSetting, setSetting } from '../database/scannerDB';
import { safeMode } from './modeSelection';
import type { PageSizeMode, ScanMode } from '../types';

/**
 * 全局偏好（存 SQLite settings 表，不引 AsyncStorage —— Tap 系列的存储只有一条路）。
 *
 * 内存缓存一份：管理页改完立刻生效到扫描页，扫描页每次挂载时读一次。
 * 这些值全是**建议值**：扫描页上随时能换档、能关自动切边、能改四角。
 *
 * v0.2 起 updateSettings 会广播 SETTINGS_CHANGED —— 三个 Tab 常驻挂载，
 * 只在挂载时 loadSettings 一次的后果是「管理页改了设置，扫描页这一整轮根本不知道」
 * （走查 audit-15）。事件常量早就定义了却从没被发过，现在把它接上。
 */
export interface AppSettings {
  defaultMode: ScanMode;
  autoCrop: boolean;
  outputMaxSide: number;
  jpegQuality: number;
  /** PDF 页面尺寸：auto 跟随每页比例，a4/letter 归一到固定纸张 */
  pdfPageSize: PageSizeMode;
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultMode: 'hd',
  autoCrop: true,
  outputMaxSide: 3000,
  jpegQuality: 92,
  pdfPageSize: 'auto',
};

const PAGE_SIZES: PageSizeMode[] = ['auto', 'a4', 'letter'];

let cache: AppSettings = { ...DEFAULT_SETTINGS };

export function settingsSync(): AppSettings {
  return cache;
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const [mode, autoCrop, maxSide, quality, pageSize] = await Promise.all([
      getSetting(SETTING_KEYS.DEFAULT_MODE),
      getSetting(SETTING_KEYS.AUTO_CROP),
      getSetting(SETTING_KEYS.OUTPUT_MAX_SIDE),
      getSetting(SETTING_KEYS.JPEG_QUALITY),
      getSetting(SETTING_KEYS.PDF_PAGE_SIZE),
    ]);
    cache = {
      defaultMode: safeMode(mode),
      autoCrop: autoCrop === null ? true : autoCrop === '1',
      outputMaxSide: parseMaxSide(maxSide),
      jpegQuality: parseQuality(quality),
      pdfPageSize: PAGE_SIZES.includes((pageSize ?? 'auto') as PageSizeMode)
        ? ((pageSize as PageSizeMode) ?? 'auto')
        : 'auto',
    };
  } catch {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

function parseMaxSide(value: string | null): number {
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) && [2000, 3000, 4000].includes(n) ? n : DEFAULT_SETTINGS.outputMaxSide;
}

function parseQuality(value: string | null): number {
  const n = value ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 60 && n <= 100 ? n : DEFAULT_SETTINGS.jpegQuality;
}

export async function saveSetting(
  key: (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS],
  value: string,
): Promise<void> {
  try {
    await setSetting(key, value);
  } catch {
    // 写库失败只影响下次启动的默认值，不影响当前这页
  }
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  cache = { ...cache, ...patch };
  const writes: Promise<void>[] = [];
  if (patch.defaultMode) writes.push(saveSetting(SETTING_KEYS.DEFAULT_MODE, patch.defaultMode));
  if (patch.autoCrop !== undefined)
    writes.push(saveSetting(SETTING_KEYS.AUTO_CROP, patch.autoCrop ? '1' : '0'));
  if (patch.outputMaxSide)
    writes.push(saveSetting(SETTING_KEYS.OUTPUT_MAX_SIDE, String(patch.outputMaxSide)));
  if (patch.jpegQuality) writes.push(saveSetting(SETTING_KEYS.JPEG_QUALITY, String(patch.jpegQuality)));
  if (patch.pdfPageSize) writes.push(saveSetting(SETTING_KEYS.PDF_PAGE_SIZE, patch.pdfPageSize));
  await Promise.all(writes);
  DeviceEventEmitter.emit(SCANNER_EVENTS.SETTINGS_CHANGED, { keys: Object.keys(patch) });
  return cache;
}
