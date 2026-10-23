import * as SQLite from 'expo-sqlite';
import type { DocumentRecord, PageRecord, QuadPoint, ScanMode } from '../types';
import { genUuid } from '../constants';
import { safeMode } from '../utils/modeSelection';

const DB_NAME = 'tapscanner.db';

/**
 * 数据层（沿用 TapLedger 的 ledgerDB 写法：单例 + dbPromise + 幂等补列）。
 *
 * 本地优先：所有记录只在这台手机上，没有账号、没有云。
 * 图片文件不在这里存，库里只存路径；文件在 Paths/document/scans/<docUuid>/ 下，
 * 删文档时由 deleteDocumentWithFiles 一起清（否则会留下没人引用的文件）。
 */

let db: SQLite.SQLiteDatabase | null = null;
let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export async function getDB(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  if (!dbPromise) dbPromise = SQLite.openDatabaseAsync(DB_NAME);
  try {
    db = await dbPromise;
    return db;
  } catch (e) {
    db = null;
    dbPromise = null;
    throw e;
  }
}

async function hasColumn(database: SQLite.SQLiteDatabase, table: string, column: string): Promise<boolean> {
  const rows = await database.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column);
}

async function ensureColumn(
  database: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  alterSql: string,
): Promise<void> {
  if (!(await hasColumn(database, table, column))) {
    await database.execAsync(alterSql);
  }
}

export async function initDatabase(): Promise<void> {
  const database = await getDB();
  await database.execAsync('PRAGMA foreign_keys = ON;');
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      pdf_path TEXT NOT NULL DEFAULT '',
      starred INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT NOT NULL UNIQUE,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      raw_path TEXT NOT NULL DEFAULT '',
      out_path TEXT NOT NULL DEFAULT '',
      thumb_path TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'hd',
      quad TEXT NOT NULL DEFAULT '',
      metrics TEXT NOT NULL DEFAULT '',
      stages TEXT NOT NULL DEFAULT '',
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pages_doc ON pages(document_id, position);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
  // 老库升级用的幂等补列（v0.1 是首版，这里先立好机制，后续加字段不再改建表语句）
  await ensureColumn(
    database,
    'pages',
    'stages',
    "ALTER TABLE pages ADD COLUMN stages TEXT NOT NULL DEFAULT ''",
  );
  // v0.2 回收站：删除先打标记、文件原地不动，30 天内可恢复。
  // 走查里两条 blocker 的共同根因都是「一次误触就物理删掉全部图片」，软删是唯一根治办法。
  await ensureColumn(
    database,
    'documents',
    'deleted_at',
    'ALTER TABLE documents ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0',
  );
  await database.execAsync('CREATE INDEX IF NOT EXISTS idx_documents_deleted ON documents(deleted_at);');
}

// ---------- documents ----------

interface DocumentRow {
  id: number;
  uuid: string;
  title: string;
  created_at: number;
  updated_at: number;
  pdf_path: string;
  starred: number;
  deleted_at?: number;
  page_count?: number;
  cover_path?: string;
}

function toDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    uuid: row.uuid,
    title: row.title,
    pageCount: row.page_count ?? 0,
    coverPath: row.cover_path ?? null,
    pdfPath: row.pdf_path !== '' ? row.pdf_path : null,
    starred: row.starred === 1,
    deletedAt: row.deleted_at ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 建文档。
 *
 * uuid 可由调用方传入 —— 扫描页在第一次拍摄前就得决定图片目录名，
 * 而目录名必须和数据库记录同一个 uuid（否则要么搬文件、要么两边对不上，两头都是坑）。
 */
export async function createDocument(title: string, uuid?: string): Promise<DocumentRecord> {
  const database = await getDB();
  const now = Date.now();
  const docUuid = uuid && uuid.length > 0 ? uuid : genUuid();
  const result = await database.runAsync(
    `INSERT INTO documents (uuid, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [docUuid, title, now, now],
  );
  return {
    id: Number(result.lastInsertRowId),
    uuid: docUuid,
    title,
    pageCount: 0,
    coverPath: null,
    pdfPath: null,
    starred: false,
    deletedAt: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** 列表排序（走查 audit-30：原来 SQL 里写死 starred + 更新时间，用户完全换不了） */
export type DocumentSort = 'updated' | 'created' | 'title' | 'pages';

const SORT_SQL: Record<DocumentSort, string> = {
  updated: 'd.updated_at DESC',
  created: 'd.created_at DESC',
  title: 'd.title COLLATE NOCASE ASC',
  pages: 'page_count DESC',
};

export interface ListDocumentsOptions {
  /** 标题模糊搜索 */
  query?: string;
  sort?: DocumentSort;
  /** true = 只列回收站里的；默认只列没删的 */
  trashed?: boolean;
}

/** 文档列表（带页数与封面缩略图，一次查完避免列表页 N+1） */
export async function listDocuments(options: ListDocumentsOptions = {}): Promise<DocumentRecord[]> {
  const database = await getDB();
  const sort = SORT_SQL[options.sort ?? 'updated'] ?? SORT_SQL.updated;
  const like = (options.query ?? '').trim();
  const where = options.trashed ? 'd.deleted_at > 0' : 'd.deleted_at = 0';
  const clause = like.length > 0 ? where + ' AND d.title LIKE ?' : where;
  const args = like.length > 0 ? ['%' + like + '%'] : [];
  const rows = await database.getAllAsync<DocumentRow>(
    `SELECT d.*,
            (SELECT COUNT(*) FROM pages p WHERE p.document_id = d.id) AS page_count,
            (SELECT p.thumb_path FROM pages p
              WHERE p.document_id = d.id ORDER BY p.position ASC LIMIT 1) AS cover_path
       FROM documents d
      WHERE ${clause}
      ORDER BY d.starred DESC, ${sort}`,
    args,
  );
  return rows.map(toDocument);
}

export async function getDocument(id: number): Promise<DocumentRecord | null> {
  const database = await getDB();
  const row = await database.getFirstAsync<DocumentRow>(
    `SELECT d.*,
            (SELECT COUNT(*) FROM pages p WHERE p.document_id = d.id) AS page_count,
            (SELECT p.thumb_path FROM pages p
              WHERE p.document_id = d.id ORDER BY p.position ASC LIMIT 1) AS cover_path
       FROM documents d WHERE d.id = ?`,
    [id],
  );
  return row ? toDocument(row) : null;
}

export async function renameDocument(id: number, title: string): Promise<void> {
  const database = await getDB();
  await database.runAsync(`UPDATE documents SET title = ?, updated_at = ? WHERE id = ?`, [
    title,
    Date.now(),
    id,
  ]);
}

export async function setDocumentStarred(id: number, starred: boolean): Promise<void> {
  const database = await getDB();
  await database.runAsync(`UPDATE documents SET starred = ?, updated_at = ? WHERE id = ?`, [
    starred ? 1 : 0,
    Date.now(),
    id,
  ]);
}

export async function setDocumentPdfPath(id: number, pdfPath: string): Promise<void> {
  const database = await getDB();
  await database.runAsync(`UPDATE documents SET pdf_path = ?, updated_at = ? WHERE id = ?`, [
    pdfPath,
    Date.now(),
    id,
  ]);
}

/**
 * 删除 = 进回收站：只打标记、不碰文件，所以调用方拿到结果也**不要**去删目录。
 * （旧版这里直接 DELETE + 上层立刻删文件，于是「长按一下就全没了」。）
 */
export async function softDeleteDocument(id: number): Promise<void> {
  const database = await getDB();
  const now = Date.now();
  await database.runAsync('UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
}

/** 撤销删除 */
export async function restoreDocument(id: number): Promise<void> {
  const database = await getDB();
  await database.runAsync('UPDATE documents SET deleted_at = 0, updated_at = ? WHERE id = ?', [
    Date.now(),
    id,
  ]);
}

/**
 * 真正删记录（文件由调用方删）。返回该文档图片目录名（uuid）。
 * 只在「回收站里彻底删除」与「过期清理」两条路径上调用。
 */
export async function deleteDocument(id: number): Promise<string | null> {
  const database = await getDB();
  const row = await database.getFirstAsync<{ uuid: string }>('SELECT uuid FROM documents WHERE id = ?', [id]);
  // pages 由 ON DELETE CASCADE 处理；PRAGMA foreign_keys 已在 initDatabase 打开
  await database.runAsync('DELETE FROM documents WHERE id = ?', [id]);
  return row?.uuid ?? null;
}

/** 回收站列表 */
export async function listTrash(): Promise<DocumentRecord[]> {
  return listDocuments({ trashed: true });
}

/** 回收站里有几份（管理页角标用） */
export async function countTrash(): Promise<number> {
  const database = await getDB();
  const row = await database.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM documents WHERE deleted_at > 0',
  );
  return row?.n ?? 0;
}

/**
 * 清掉过期回收站（默认 30 天），返回被删掉的目录名，调用方负责删文件。
 */
export async function purgeExpiredTrash(maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<string[]> {
  const database = await getDB();
  const cutoff = Date.now() - maxAgeMs;
  const rows = await database.getAllAsync<{ id: number; uuid: string }>(
    'SELECT id, uuid FROM documents WHERE deleted_at > 0 AND deleted_at < ?',
    [cutoff],
  );
  const purged: string[] = [];
  for (const row of rows) {
    await database.runAsync('DELETE FROM documents WHERE id = ?', [row.id]);
    purged.push(row.uuid);
  }
  return purged;
}

export async function touchDocument(id: number): Promise<void> {
  const database = await getDB();
  await database.runAsync('UPDATE documents SET updated_at = ? WHERE id = ?', [Date.now(), id]);
}

// ---------- pages ----------

interface PageRow {
  id: number;
  uuid: string;
  document_id: number;
  position: number;
  raw_path: string;
  out_path: string;
  thumb_path: string;
  mode: string;
  quad: string;
  metrics: string;
  stages: string;
  width: number;
  height: number;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // 脏 JSON 只丢掉这一条附加信息，不要让整个列表页崩
    return null;
  }
}

function toPage(row: PageRow): PageRecord {
  return {
    id: row.id,
    uuid: row.uuid,
    documentId: row.document_id,
    position: row.position,
    rawPath: row.raw_path,
    outPath: row.out_path,
    thumbPath: row.thumb_path,
    mode: safeMode(row.mode),
    quad: parseJson<QuadPoint[]>(row.quad),
    metrics: parseJson<PageRecord['metrics']>(row.metrics),
    stages: parseJson<PageRecord['stages']>(row.stages),
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewPage {
  documentId: number;
  rawPath: string;
  outPath: string;
  thumbPath: string;
  mode: ScanMode;
  quad: QuadPoint[] | null;
  metrics: PageRecord['metrics'];
  stages: PageRecord['stages'];
  width: number;
  height: number;
}

export async function appendPage(page: NewPage): Promise<PageRecord> {
  const database = await getDB();
  const now = Date.now();
  const row = await database.getFirstAsync<{ next: number }>(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM pages WHERE document_id = ?',
    [page.documentId],
  );
  const position = row?.next ?? 0;
  const uuid = genUuid();
  const result = await database.runAsync(
    `INSERT INTO pages (uuid, document_id, position, raw_path, out_path, thumb_path, mode, quad, metrics, stages, width, height, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid,
      page.documentId,
      position,
      page.rawPath,
      page.outPath,
      page.thumbPath,
      page.mode,
      page.quad ? JSON.stringify(page.quad) : '',
      page.metrics ? JSON.stringify(page.metrics) : '',
      page.stages ? JSON.stringify(page.stages) : '',
      page.width,
      page.height,
      now,
      now,
    ],
  );
  await database.runAsync('UPDATE documents SET updated_at = ? WHERE id = ?', [now, page.documentId]);
  return {
    id: Number(result.lastInsertRowId),
    uuid,
    documentId: page.documentId,
    position,
    rawPath: page.rawPath,
    outPath: page.outPath,
    thumbPath: page.thumbPath,
    mode: page.mode,
    quad: page.quad,
    metrics: page.metrics,
    stages: page.stages,
    width: page.width,
    height: page.height,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listPages(documentId: number): Promise<PageRecord[]> {
  const database = await getDB();
  const rows = await database.getAllAsync<PageRow>(
    'SELECT * FROM pages WHERE document_id = ? ORDER BY position ASC',
    [documentId],
  );
  return rows.map(toPage);
}

/** 换滤镜：重跑原生后会带着新的 out/quad/metrics 回到这里 */
export async function updatePageRender(
  id: number,
  patch: {
    mode: ScanMode;
    outPath: string;
    thumbPath: string;
    quad: QuadPoint[] | null;
    metrics: PageRecord['metrics'];
    stages: PageRecord['stages'];
    width: number;
    height: number;
  },
): Promise<void> {
  const database = await getDB();
  await database.runAsync(
    `UPDATE pages SET mode = ?, out_path = ?, thumb_path = ?, quad = ?, metrics = ?, stages = ?,
            width = ?, height = ?, updated_at = ? WHERE id = ?`,
    [
      patch.mode,
      patch.outPath,
      patch.thumbPath,
      patch.quad ? JSON.stringify(patch.quad) : '',
      patch.metrics ? JSON.stringify(patch.metrics) : '',
      patch.stages ? JSON.stringify(patch.stages) : '',
      patch.width,
      patch.height,
      Date.now(),
      id,
    ],
  );
}

export async function deletePage(id: number, documentId: number): Promise<void> {
  const database = await getDB();
  await database.runAsync('DELETE FROM pages WHERE id = ?', [id]);
  // 删完必须重排，否则位置出现空洞，上下移动会算错
  await database.runAsync(
    `UPDATE pages SET position = (
       SELECT COUNT(*) - 1 FROM pages p2 WHERE p2.document_id = pages.document_id AND p2.position < pages.position
     ) WHERE document_id = ?`,
    [documentId],
  );
  await database.runAsync('UPDATE documents SET updated_at = ? WHERE id = ?', [Date.now(), documentId]);
}

/** 上移/下移：先落到 -1 这个临时位，避免中间态里两个页面同 position */
export async function swapPagePositions(documentId: number, aId: number, bId: number): Promise<void> {
  const database = await getDB();
  const rows = await database.getAllAsync<{ id: number; position: number }>(
    'SELECT id, position FROM pages WHERE id IN (?, ?)',
    [aId, bId],
  );
  const a = rows.find((r) => r.id === aId);
  const b = rows.find((r) => r.id === bId);
  if (!a || !b || a.position === b.position) return;
  await database.runAsync('UPDATE pages SET position = -1 WHERE id = ?', [aId]);
  await database.runAsync('UPDATE pages SET position = ? WHERE id = ?', [b.position, aId]);
  await database.runAsync('UPDATE pages SET position = ? WHERE id = ?', [a.position, bId]);
  await database.runAsync('UPDATE documents SET updated_at = ? WHERE id = ?', [Date.now(), documentId]);
}

/** 移到顶部/底部：10 页文档挪一位原来要按 9 次，这个比逐格上移下移实用 */
export async function movePageToEdge(
  documentId: number,
  pageId: number,
  edge: 'top' | 'bottom',
): Promise<void> {
  const database = await getDB();
  await database.runAsync(
    edge === 'top'
      ? 'UPDATE pages SET position = -1 WHERE id = ?'
      : 'UPDATE pages SET position = 100000 WHERE id = ?',
    [pageId],
  );
  await renumberPages(database, documentId);
  await database.runAsync('UPDATE documents SET updated_at = ? WHERE id = ?', [Date.now(), documentId]);
}

/**
 * 把某一页拆出去单独成一份新文档。
 *
 * 只改引用，不搬文件：pages.raw_path/out_path 记的都是绝对路径，
 * 「目录名 == docUuid」这条约定只对新建的扫描组有意义，对拆出来的单页不成立
 * （真要搬文件就得连 thumb/preview/pdf 一起搬，漏一个就是「文档打不开」，代价远大于收益）。
 */
export async function movePageToNewDocument(
  pageId: number,
  title: string,
): Promise<{ document: DocumentRecord; moved: boolean }> {
  const database = await getDB();
  const page = await database.getFirstAsync<{ id: number; document_id: number }>(
    'SELECT id, document_id FROM pages WHERE id = ?',
    [pageId],
  );
  if (!page) throw new Error('这一页不存在');
  const source = await getDocument(page.document_id);
  if (!source) throw new Error('原文档不存在');
  if (source.pageCount <= 1) return { document: source, moved: false };

  const created = await createDocument(title);
  await database.runAsync('UPDATE pages SET document_id = ?, position = 0, updated_at = ? WHERE id = ?', [
    created.id,
    Date.now(),
    pageId,
  ]);
  await renumberPages(database, source.id);
  await database.runAsync('UPDATE documents SET updated_at = ? WHERE id = ?', [Date.now(), source.id]);
  const document = await getDocument(created.id);
  return { document: document ?? created, moved: true };
}

async function renumberPages(database: SQLite.SQLiteDatabase, documentId: number): Promise<void> {
  const rows = await database.getAllAsync<{ id: number }>(
    'SELECT id FROM pages WHERE document_id = ? ORDER BY position ASC, id ASC',
    [documentId],
  );
  for (let i = 0; i < rows.length; i += 1) {
    await database.runAsync('UPDATE pages SET position = ? WHERE id = ?', [i, rows[i].id]);
  }
}

// ---------- settings ----------

export async function getSetting(key: string): Promise<string | null> {
  const database = await getDB();
  const row = await database.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
    key,
  ]);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const database = await getDB();
  await database.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const database = await getDB();
  const rows = await database.getAllAsync<{ key: string; value: string }>('SELECT * FROM settings');
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** 备份用：整库导出 */
export async function exportAll() {
  const documents = await listDocuments();
  const pages: PageRecord[] = [];
  for (const doc of documents) {
    pages.push(...(await listPages(doc.id)));
  }
  return { documents, pages, settings: await getAllSettings() };
}
