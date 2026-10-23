import type { AppSettings } from './appSettings';
import type { PageSizeMode, RenderOptions } from '../types';

/**
 * 渲染参数的唯一真源。
 *
 * 存在的理由是一条走查结论（audit-16）：扫描页的本地 Settings 接口里压根没有 jpegQuality，
 * 于是从扫描页出的成品恒为 92，从详情页出的成品用的是设置里的值 ——
 * 同一页两条路径能给出两张不同的图。参数分散在四个地方（组件 state / settings / 调用点默认值 /
 * 原生默认值）就一定会漂移，所以收成这一个纯函数：所有渲染入口都只能经过它。
 *
 * 纯函数、不碰 SQLite、不碰原生 —— 因此可以被 vitest 直接钉住。
 */
/** 解析完的渲染参数：所有渲染入口只接受这一种形状 */
export type ResolvedRenderOptions = Required<RenderOptions>;

export function resolveRenderOptions(
  settings: Pick<AppSettings, 'autoCrop' | 'outputMaxSide' | 'jpegQuality' | 'pdfPageSize'>,
  overrides: Partial<RenderOptions> = {},
): Required<RenderOptions> {
  const merged = {
    autoCrop: overrides.autoCrop ?? settings.autoCrop,
    outputMaxSide: overrides.outputMaxSide ?? settings.outputMaxSide,
    jpegQuality: overrides.jpegQuality ?? settings.jpegQuality,
    pageSizeMode: overrides.pageSizeMode ?? settings.pdfPageSize ?? 'auto',
  };
  return {
    autoCrop: merged.autoCrop,
    outputMaxSide: clampOneOf(OUTPUT_SIDES, merged.outputMaxSide, DEFAULT_OUTPUT_SIDE),
    jpegQuality: clampInt(merged.jpegQuality, 60, 100, 92),
    pageSizeMode: clampOneOf(PAGE_SIZES, merged.pageSizeMode, 'auto') as PageSizeMode,
  };
}

export const OUTPUT_SIDES = [2000, 3000, 4000] as number[];
export const PAGE_SIZES: PageSizeMode[] = ['auto', 'a4', 'letter'];
const DEFAULT_OUTPUT_SIDE = 3000;

function clampInt(value: number, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampOneOf<T>(allowed: T[], value: T | number | string, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * 「这组自动切边」与「全局默认自动切边」是两个东西（audit-15 的根因就在这里）：
 * 会话开关只管当前这一组，不该写库；全局开关才写库。
 * 这个函数把两者的优先级说清楚，供 UI 与队列共用。
 */
export function effectiveAutoCrop(sessionOverride: boolean | null, settingsAutoCrop: boolean): boolean {
  return sessionOverride ?? settingsAutoCrop;
}
