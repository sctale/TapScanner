import { describe, expect, it } from 'vitest';
import { assemblePdf, objectIdForPage, type PdfPageBytes } from '../pdfBytes';
import { DEFAULT_SCAN_DPI } from '../pageSize';

/** 造一段「像 JPEG 的」字节即可：写出器不解析 JPEG，只原样嵌入并按 /Length 记账 */
function fakeJpeg(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = x % 256;
  }
  // JPEG magic 前后缀，便于人肉检查
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[length - 2] = 0xff;
  bytes[length - 1] = 0xd9;
  return bytes;
}

function asText(bytes: Uint8Array): string {
  // 只用Latin-1 还原结构文本（高位字节不参与断言）
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b < 128 ? b : 63);
  return out;
}

function onePage(): PdfPageBytes[] {
  return [{ jpeg: fakeJpeg(7, 220), widthPx: 2480, heightPx: 3508, dpi: DEFAULT_SCAN_DPI }];
}

describe('assemblePdf 结构', () => {
  it('以 %PDF-1.4 开头、以 %%EOF 结尾', () => {
    const bytes = assemblePdf(onePage());
    const text = asText(bytes);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.endsWith('%%EOF\n')).toBe(true);
  });

  it('对象数量 = 3 + 每页 3 个（Catalog/Pages/Info + Page/Contents/Image）', () => {
    const bytes = assemblePdf([onePage()[0], { jpeg: fakeJpeg(9, 180), widthPx: 1000, heightPx: 1500 }]);
    const text = asText(bytes);
    const objectCount = (text.match(/\n\d+ 0 obj/g) ?? []).length;
    expect(objectCount).toBe(3 + 2 * 3);
    // xref 表头声明的条目数 = 最大编号 + 1（含编号 0 的空条目）：2 页 → 3 + 6 = 9 个对象 → Size 10
    expect(text).toContain('xref\n0 10\n');
  });

  it('每个 xref 偏移都真的落在对应的 "N 0 obj" 上（错一位整份 PDF 就打不开）', () => {
    const bytes = assemblePdf(onePage());
    const text = asText(bytes);
    const startxref = Number(
      text
        .slice(text.indexOf('startxref') + 9)
        .trim()
        .split('\n')[0],
    );
    expect(Number.isFinite(startxref)).toBe(true);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');

    const table = text.slice(startxref);
    const entries = table.match(/^\d{10} \d{5} [nf] \r/gm) ?? [];
    // 第一条是编号 0 的空条目，其余按编号递增
    expect(entries.length).toBe(1 + 6);
    for (let id = 1; id <= 6; id += 1) {
      const raw = entries[id];
      const offset = Number(raw.slice(0, 10));
      expect(text.slice(offset, offset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
    }
  });

  it('DCTDecode 的 /Length 等于 JPEG 实际字节数（不重编码，所以必须逐字节一致）', () => {
    const jpeg = fakeJpeg(3, 512);
    const bytes = assemblePdf([{ jpeg, widthPx: 800, heightPx: 1200 }]);
    const text = asText(bytes);
    expect(text).toContain(`/Filter /DCTDecode /Length ${jpeg.length}`);
    // 字节级回捞：从 stream 标记后按 /Length 取出来，应与原图完全一致
    const imageId = objectIdForPage(0).image;
    const objStart = text.indexOf(`${imageId} 0 obj`);
    const streamStart = text.indexOf('stream\n', objStart) + 'stream\n'.length;
    const embedded = bytes.slice(streamStart, streamStart + jpeg.length);
    expect(Array.from(embedded)).toEqual(Array.from(jpeg));
  });

  it('页面尺寸按 pt = px * 72 / dpi 写进 MediaBox', () => {
    const bytes = assemblePdf(onePage());
    const text = asText(bytes);
    expect(text).toContain('/MediaBox [0 0 595.2 841.92]');
  });

  it('Contents 流引用本页的 Image XObject，且 cm 用页面尺寸', () => {
    const bytes = assemblePdf([
      { jpeg: fakeJpeg(1, 100), widthPx: 1000, heightPx: 1000, dpi: 100 },
      { jpeg: fakeJpeg(2, 100), widthPx: 2000, heightPx: 1000, dpi: 100 },
    ]);
    const text = asText(bytes);
    // cm 矩阵是 [w 0 0 h 0 0]，把整页位图铺满 MediaBox
    expect(text).toContain('q 720 0 0 720 0 0 cm /Im0 Do Q');
    expect(text).toContain('q 1440 0 0 720 0 0 cm /Im1 Do Q');
    expect(text).toContain('/XObject << /Im0 6 0 R >>');
    expect(text).toContain('/XObject << /Im1 9 0 R >>');
  });

  it('中文标题走 UTF-16BE 十六进制字符串，不留裸中文', () => {
    const bytes = assemblePdf(onePage(), { title: '发票扫描' });
    const text = asText(bytes);
    expect(text).toContain('/Title <FEFF');
    expect(text).not.toContain('/Title (发票');
  });

  it('空页列表直接抛，不出一个空 PDF', () => {
    expect(() => assemblePdf([])).toThrow();
  });

  it('trailer 的 /Size 与 Root/Info 引用齐全', () => {
    const text = asText(assemblePdf(onePage()));
    expect(text).toMatch(/trailer\n<< \/Size 7 \/Root 1 0 R \/Info 3 0 R >>/);
  });
});
