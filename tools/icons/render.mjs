/**
 * TapScanner 图标生成器（设计稿即代码，可复现）
 *
 * 概念叙事（一个概念、一个焦点）：
 *   「一张斜放的纸，被取景框当场框正。」
 *   白纸 = 文档；四角括号 = 扫描取景；纸是斜的 = 不用摆正、不用找角度也能拍。
 *   这正好是产品那一句「拍一下就是一张干净的扫描件」的图形版本 —— 不识字也能认出「扫文档」。
 *
 * 风格：Tap 系列的扁平语言（对齐 TapLedger：纯色底 + 白色主体，铺满画布，不做圆角卡片描边），
 *   底色用系列强调靛蓝 #7986CB，纸面纯白，文字线用 accentDark 压一层深度。
 *   刻意不铺渐变、不加高光：渐变在小尺寸上只会变成一坨脏色。
 *
 * 小尺寸优先（这是图标唯一真正的验收标准）：
 *   1. 识别度靠**大块**（白纸）承担，不靠细线；缩小后先看到块，再看到框
 *   2. 四角括号是 2.5mm 级的粗短条，48px 下仍然是四个可辨的角，而不是糊掉的点
 *   3. 纸上的文字线只留 3 条，且第 3 条故意短 —— 一眼是「文字」，不需要读出来
 *   4. 所有元素收在自适应图标的安全圆内（108dp 里中间 66dp 保证可见 → 半径 1024×66/108/2 ≈ 313）
 *
 * 可复现性：纯几何 + 固定角度，没有任何随机源，重跑逐字节一致。
 *
 * 产物（与 app.json 的引用一一对应）：
 *   assets/icon.png                      1024  全幅图标（含底色）
 *   assets/android-icon-background.png   1024  自适应图标背景层
 *   assets/android-icon-foreground.png   1024  自适应图标前景层（透明底）
 *   assets/android-icon-monochrome.png   1024  单色层（白色剪影，供系统主题着色）
 *   assets/splash-icon.png               1024  启动图备用
 *   assets/favicon.png                   48    Web favicon
 *   tools/icons/preview.png                    遮罩预览（圆形/圆角/水滴 + 桌面实景）
 *   tools/icons/sizes.png                      1024/192/96/48 尺寸阶梯预览
 *
 * 用法：node tools/icons/render.mjs   （sharp 是 devDependency，不要 --no-save）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ASSETS = path.join(ROOT, 'assets');
const OUT_DIR = path.join(ROOT, 'tools', 'icons');

const SIZE = 1024;
const CENTER = SIZE / 2;

// ===== Tap 系列配色（与 src/constants/index.ts 同源）=====
const ACCENT = '#7986CB'; // 背景：柔和靛蓝
const ACCENT_DARK = '#5C6BC0'; // 纸上的文字线
const PAPER = '#FFFFFF'; // 纸面

// 自适应图标安全圆半径（1024 画布）
const SAFE_RADIUS = 313;

// ===== 几何参数（唯一真源，预览与产物共用）=====
// 尺寸按「自适应图标安全圆」反推：主体最外点距中心必须 ≤ SAFE_RADIUS，
// 否则圆形/水滴遮罩会把尖角切掉（第一版 372×500 时是 348 > 313，被切）。
const SHEET = {
  w: 360, // 纸宽
  h: 490, // 纸高
  tilt: -9, // 倾斜角（负值 = 逆时针，纸的右上角翘起）
  radius: 26, // 纸张圆角
};
/**
 * 取景括号**抠在白纸内部**（用背景色 knockout），不是画在蓝底上。
 *
 * 第一版把括号画在纸外的靛蓝底上、还用 accentDark 上色 —— 同色系几乎看不见，
 * 「取景框」这个概念直接丢了，48px 下更是一个像素都不剩。
 * 括号压在白纸上才有对比，也才有「框正在扫描的纸」这个动作。
 *
 * 笔画粗细按 48px 反推：30/1024 缩到桌面 48px 只剩 1.4px，会糊成噪点；
 * 44/1024 ≈ 2px 才是「四个可辨的角」。纸幅也从 330×450 放大到 360×490（半对角 304，仍在安全圆内）。
 */
const BRACKET_CFG = {
  inset: 20, // 括号距纸边的距离
  arm: 104, // 每条边的长度
  thickness: 44, // 笔画粗细
};

/** 纸上文字线：2 条，第 2 条短 —— 一眼是「文字」，不需要读出来 */
const LINE_CFG = {
  thickness: 34,
  widths: [0.58, 0.34],
  yRatios: [-0.12, 0.1],
};

function svgDoc(inner, { width = SIZE, height = SIZE, background = null } = {}) {
  const bg = background ? `<rect width="${width}" height="${height}" fill="${background}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${SIZE} ${SIZE}">${bg}${inner}</svg>`;
}

/** 只有纸（不含文字线） */
function paperOnly({ fill }) {
  const { w, h, radius } = SHEET;
  return `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${radius}" fill="${fill}"/>`;
}

/** 只有文字线（局部坐标同 paperOnly） */
function linesOnly({ fill }) {
  const { w } = SHEET;
  const t = LINE_CFG.thickness;
  return LINE_CFG.yRatios
    .map((ratio, i) => {
      const lw = w * LINE_CFG.widths[i];
      return `<rect x="${-w * 0.29}" y="${SHEET.h * ratio - t / 2}" width="${lw}" height="${t}" rx="${t / 2}" fill="${fill}"/>`;
    })
    .join('');
}

/**
 * 纸张 + 纸上的文字线（局部坐标：以纸中心为原点）
 */
function sheetGroup({ paperFill, lineFill }) {
  return paperOnly({ fill: paperFill }) + linesOnly({ fill: lineFill });
}

/**
 * 四角取景括号，画在**纸内侧**贴住四个角（dx/dy 指向纸中心）。
 * 每条括号 = 一横一竖两根圆头粗条；用背景色填充即为「抠掉」效果。
 */
function bracketGroup({ fill }) {
  const halfW = SHEET.w / 2 - BRACKET_CFG.inset;
  const halfH = SHEET.h / 2 - BRACKET_CFG.inset;
  const { arm, thickness: th } = BRACKET_CFG;
  const corners = [
    [-halfW, -halfH, 1, 1],
    [halfW, -halfH, -1, 1],
    [halfW, halfH, -1, -1],
    [-halfW, halfH, 1, -1],
  ];
  return corners
    .map(([cx, cy, dx, dy]) => {
      const hBar = `<rect x="${dx > 0 ? cx : cx - arm}" y="${dy > 0 ? cy : cy - th}" width="${arm}" height="${th}" rx="${th / 2}" fill="${fill}"/>`;
      const vBar = `<rect x="${dx > 0 ? cx : cx - th}" y="${dy > 0 ? cy : cy - arm}" width="${th}" height="${arm}" rx="${th / 2}" fill="${fill}"/>`;
      return hBar + vBar;
    })
    .join('');
}

/** 把一组元素平移到画布中心并旋转 */
function placed(inner, rotate) {
  return `<g transform="translate(${CENTER} ${CENTER}) rotate(${rotate})">${inner}</g>`;
}

// ===== 各产物 =====

/** 全幅图标：靛蓝底 + 倾斜白纸，纸上抠出四角取景括号（概念：框正在把斜放的纸拉正） */
function renderFull() {
  const inner =
    placed(sheetGroup({ paperFill: PAPER, lineFill: ACCENT_DARK }), SHEET.tilt) +
    placed(bracketGroup({ fill: ACCENT }), SHEET.tilt);
  return svgDoc(inner, { background: ACCENT });
}

/** 自适应前景层：透明底，只画主体（括号仍按背景蓝抠色，与背景层拼回完整图） */
function renderForeground() {
  const inner =
    placed(sheetGroup({ paperFill: PAPER, lineFill: ACCENT_DARK }), SHEET.tilt) +
    placed(bracketGroup({ fill: ACCENT }), SHEET.tilt);
  return svgDoc(inner);
}

/**
 * 单色层：白纸 + **镂空**的括号与文字线。
 *
 * 系统主题图标会把这一层整体着色，所以层内不能靠颜色区分任何东西 ——
 * 第一版画成纯白剪影（文字线也涂白），预览里就是一张空白方块，概念全丢。
 * 正确做法是把括号和文字线挖成透明洞（dest-out）：着色后它们透出背景，
 * 无论系统换成什么颜色，都还认得出「取景框 + 纸 + 文字」。
 */
async function renderMonochromeBuffer() {
  const paper = svgDoc(placed(paperOnly({ fill: PAPER }), SHEET.tilt));
  const holes = svgDoc(placed(linesOnly({ fill: PAPER }) + bracketGroup({ fill: PAPER }), SHEET.tilt));
  const base = await sharp(Buffer.from(paper)).png().toBuffer();
  const mask = await sharp(Buffer.from(holes)).png().toBuffer();
  return sharp(base).composite([{ input: mask, blend: 'dest-out' }]).png().toBuffer();
}

/** 启动图：暖米白底 + 靛蓝纸（启动页不该是第二块广告，颜色反过来更安静） */
function renderSplash() {
  const inner =
    placed(sheetGroup({ paperFill: ACCENT, lineFill: '#FFFFFF' }), SHEET.tilt) +
    placed(bracketGroup({ fill: '#F8F6F3' }), SHEET.tilt);
  return svgDoc(inner, { background: '#F8F6F3' });
}

async function writePng(svg, file, resize) {
  const buf = await sharp(Buffer.from(svg))
    .resize(resize ? { width: resize, height: resize, fit: 'contain' } : undefined)
    .png()
    .toBuffer();
  fs.writeFileSync(file, buf);
  console.log(`saved ${path.relative(ROOT, file)} (${buf.length} bytes)`);
  return buf;
}

/** 遮罩预览：同一张图标在圆形/圆角方/水滴三种 launcher 遮罩下的样子 + 桌面实景 */
async function buildPreview(files) {
  const full = files.full;
  const masks = [
    { label: 'circle', svg: '<circle cx="64" cy="64" r="64" fill="#000"/>' },
    { label: 'rounded', svg: '<rect x="0" y="0" width="128" height="128" rx="30" fill="#000"/>' },
    { label: 'squircle', svg: '<rect x="4" y="4" width="120" height="120" rx="42" fill="#000"/>' },
  ];
  const tiles = [];
  for (const m of masks) {
    const maskBuf = await sharp(Buffer.from(`<svg width="128" height="128">${m.svg}</svg>`)).png().toBuffer();
    const masked = await sharp(full)
      .resize(128, 128)
      .composite([{ input: maskBuf, blend: 'dest-in' }])
      .png()
      .toBuffer();
    tiles.push(masked);
  }
  // 桌面实景：暖米白壁纸 + 图标 + 名字，检查「白纸上靛蓝线」在真实壁纸前是否糊
  const homeBg = await sharp({
    create: { width: 320, height: 160, channels: 4, background: '#EFE9E1' },
  })
    .png()
    .toBuffer();
  const homeIcon = await sharp(full).resize(104, 104).png().toBuffer();
  const home = await sharp(homeBg)
    .composite([{ input: homeIcon, left: 108, top: 22 }])
    .png()
    .toBuffer();

  const row = await sharp({
    create: { width: 128 * 3 + 320, height: 200, channels: 4, background: '#FFFFFF' },
  })
    .composite([
      { input: tiles[0], left: 0, top: 36 },
      { input: tiles[1], left: 136, top: 36 },
      { input: tiles[2], left: 272, top: 36 },
      { input: home, left: 408, top: 20 },
    ])
    .png()
    .toFile(path.join(OUT_DIR, 'preview.png'));
  console.log('saved tools/icons/preview.png', `${row.width}x${row.height}`);
}

/** 尺寸阶梯：48px 是真正的验收线，必须和 1024 并排看 */
async function buildSizes(full) {
  const sizes = [1024, 192, 96, 48];
  const MAX_DISPLAY = 192;
  const composites = [];
  let left = 10;
  for (const s of sizes) {
    // 先按真实尺寸缩（这才是「小尺寸长什么样」），再为排版把大图显示尺寸压回画布内
    const real = await sharp(full).resize(s, s).png().toBuffer();
    const display = Math.min(s, MAX_DISPLAY);
    const buf = display === s ? real : await sharp(real).resize(display, display).png().toBuffer();
    composites.push({ input: buf, left, top: 10 });
    left += display + 20;
  }
  const out = await sharp({
    create: { width: left + 10, height: MAX_DISPLAY + 20, channels: 4, background: '#FFFFFF' },
  })
    .composite(composites)
    .png()
    .toFile(path.join(OUT_DIR, 'sizes.png'));
  console.log('saved tools/icons/sizes.png', `${out.width}x${out.height}`);
}

async function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const fullSvg = renderFull();
  const full = await writePng(fullSvg, path.join(ASSETS, 'icon.png'));
  await writePng(svgDoc(`<rect width="${SIZE}" height="${SIZE}" fill="${ACCENT}"/>`), path.join(ASSETS, 'android-icon-background.png'));
  await writePng(renderForeground(), path.join(ASSETS, 'android-icon-foreground.png'));
  const mono = await renderMonochromeBuffer();
  fs.writeFileSync(path.join(ASSETS, 'android-icon-monochrome.png'), mono);
  console.log(`saved assets/android-icon-monochrome.png (${mono.length} bytes，镂空单色层)`);
  await writePng(renderSplash(), path.join(ASSETS, 'splash-icon.png'));
  await writePng(fullSvg, path.join(ASSETS, 'favicon.png'), 48);

  await buildPreview({ full });
  await buildSizes(full);
  const reach = Math.hypot(SHEET.w / 2, SHEET.h / 2);
  console.log(
    `\n安全区检查：主体（纸）半对角 = ${Math.round(reach)}（限 ${SAFE_RADIUS}）${reach <= SAFE_RADIUS ? '✓ 圆形/水滴遮罩不会切到纸角' : '✗ 超出安全圆，会被遮罩切角'}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
