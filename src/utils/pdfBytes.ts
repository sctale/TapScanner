import { pdfPageSize } from './pageSize';

/**
 * 手写的最小 PDF 字节层：把已经压好的 JPEG **原样**塞进 PDF（DCTDecode 直传）。
 *
 * 这一层刻意不 import 任何 RN / expo 模块 —— 于是它能在 vitest 里逐字节断言
 * （xref 偏移必须真的落在 "N 0 obj" 上，错一位整份 PDF 就打不开，
 * 而那时用户只会说「PDF 坏了」，根本想不到是偏移表数错了）。
 * 读写文件的部分在 pdfWriter.ts。
 *
 * 为什么不用 expo-print：它把 HTML 交给 WebView 渲染成 PDF，每页重新编码一次（画质掉一档），
 * 还要在一次绘制里持有全部页面的大位图（8 页 3000px 就是 OOM 现场）。
 * 为什么不用 android.graphics.pdf.PdfDocument：只能往 Canvas 画，同样是解码再编码。
 *
 * 直传 = 零重编码、零解码、约 40ms/页，打印级画质不打折。
 */

const encoder = new TextEncoder();

export interface PdfPageBytes {
  /** JPEG 原始字节 */
  jpeg: Uint8Array;
  widthPx: number;
  heightPx: number;
  dpi?: number;
}

export interface PdfMeta {
  title?: string;
  producer?: string;
}

/**
 * PDF 头 + 二进制注释行。
 *
 * 注释那 4 个字节必须 >127（告诉工具「这文件是二进制的」），
 * 而 TextEncoder 会把 U+00E2 编成 2 个字节 —— 所以手写字节数组，
 * 不让编码层替我决定长度。
 */
const PDF_HEADER = new Uint8Array([
  0x25,
  0x50,
  0x44,
  0x46,
  0x2d,
  0x31,
  0x2e,
  0x34,
  0x0a, // %PDF-1.4\n
  0x25,
  0xe2,
  0xe3,
  0xcf,
  0xd3,
  0x0a, // %<4 个高位字节>\n
]);

function ascii(text: string): Uint8Array {
  return encoder.encode(text);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * PDF 字符串字面量：非 ASCII（中文标题）必须走 UTF-16BE + FEFF BOM，
 * 否则不同阅读器各自猜编码，标题变成乱码方块。
 */
export function pdfString(value: string): string {
  const safeAscii = /^[\x20-\x27\x2A-\x7E]*$/.test(value);
  if (safeAscii) return `(${value})`;
  const withBom = new Uint8Array(value.length * 2 + 2);
  withBom[0] = 0xfe;
  withBom[1] = 0xff;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    withBom[i * 2 + 2] = (code >> 8) & 0xff;
    withBom[i * 2 + 3] = code & 0xff;
  }
  let hex = '';
  for (const b of withBom) hex += b.toString(16).padStart(2, '0');
  return `<${hex.toUpperCase()}>`;
}

/** 对象编号从 1 开始：1 Catalog、2 Pages、3 Info，之后每页 3 个（Page/Contents/Image） */
export function objectIdForPage(index: number): { page: number; contents: number; image: number } {
  const base = 4 + index * 3;
  return { page: base, contents: base + 1, image: base + 2 };
}

export function assemblePdf(pages: PdfPageBytes[], meta: PdfMeta = {}): Uint8Array {
  if (pages.length === 0) throw new Error('PDF 至少需要一页');

  const parts: Uint8Array[] = [PDF_HEADER];
  let cursor = PDF_HEADER.length;
  const offsets: number[] = [];

  const push = (bytes: Uint8Array) => {
    parts.push(bytes);
    cursor += bytes.length;
  };

  /** 普通字典对象 */
  const pushDict = (id: number, body: string) => {
    offsets[id] = cursor;
    push(ascii(`${id} 0 obj\n${body}\nendobj\n`));
  };

  /** 带二进制的对象：`<< ... >> stream\n<bytes>\nendstream` */
  const pushStream = (id: number, dict: string, stream: Uint8Array) => {
    offsets[id] = cursor;
    push(ascii(`${id} 0 obj\n${dict}stream\n`));
    push(stream);
    push(ascii('\nendstream\nendobj\n'));
  };

  const kids = pages.map((_, i) => `${objectIdForPage(i).page} 0 R`).join(' ');

  pushDict(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  pushDict(2, `<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`);
  pushDict(
    3,
    `<< /Producer ${pdfString(meta.producer ?? 'TapScanner')} /CreationDate (D:19700101)${
      meta.title ? ` /Title ${pdfString(meta.title)}` : ''
    } >>`,
  );

  pages.forEach((page, index) => {
    const size = pdfPageSize(page.widthPx, page.heightPx, page.dpi);
    const ids = objectIdForPage(index);
    pushDict(
      ids.page,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.widthPt} ${size.heightPt}] ` +
        `/Resources << /XObject << /Im${index} ${ids.image} 0 R >> /ProcSet [/PDF /ImageC] >> ` +
        `/Contents ${ids.contents} 0 R >>`,
    );
    const content = `q ${size.widthPt} 0 0 ${size.heightPt} 0 0 cm /Im${index} Do Q`;
    pushStream(ids.contents, `<< /Length ${content.length} >>`, ascii(content));
    pushStream(
      ids.image,
      `<< /Type /XObject /Subtype /Image /Width ${page.widthPx} /Height ${page.heightPx} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >> `,
      page.jpeg,
    );
  });

  // 传统（未压缩）交叉引用表：每条固定 20 字节 = 10 位偏移 + 空格 + 5 位代号 + 空格 + n/f + \r\n
  const maxId = offsets.length - 1;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \r\n`;
  for (let id = 1; id <= maxId; id += 1) {
    xref += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \r\n`;
  }
  push(
    ascii(`${xref}trailer\n<< /Size ${maxId + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${cursor}\n%%EOF\n`),
  );

  return concat(parts);
}
