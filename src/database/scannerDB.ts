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
    createdAt: now,
    updatedAt: now,
  };
}

/** 文档列表（带页数与封面缩略图，一次查完避免列表页 N+1） */
export async function listDocuments(): Promise<DocumentRecord[]> {
  const database = await getDB();
  const rows = await database.getAllAsync<DocumentRow>(
    `SELECT d.*,
            (SELECT COUNT(*) FROM pages p WHERE p.document_id = d.id) AS page_count,
            (SELECT p.thumb_path FROM pages p
              WHERE p.document_id = d.id ORDER BY p.position ASC LIMIT 1) AS cover_path
       FROM documents d
      ORDER BY d.starred DESC, d.updated_at DESC`,
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

/** 返回该文档的图片文件相对目录名（uuid），供调用方删文件用；库里只留引用关系 */
export async function deleteDocument(id: number): Promise<string | null> {
  const database = await getDB();
  const row = await database.getFirstAsync<{ uuid: string }>('SELECT uuid FROM documents WHERE id = ?', [id]);
  // pages 由 ON DELETE CASCADE 处理；PRAGMA foreign_keys 已在 initDatabase 打开
  await database.runAsync('DELETE FROM documents WHERE id = ?', [id]);
  return row?.uuid ?? null;
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
