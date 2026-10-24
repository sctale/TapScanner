package com.tapscanner.verify

import com.tapscanner.app.Histogram
import com.tapscanner.app.Metrics
import com.tapscanner.app.QuadDetect
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfPoint
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Scalar
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random

/**
 * 边界检测的 JVM 验证台（tools/verify/run.sh 调用）。
 *
 * 为什么能在 JVM 上跑：QuadDetect.kt / Metrics.kt 只依赖 org.opencv.* 与 kotlin 标准库，
 * 不 import 任何 android.*，所以可以用桌面版 OpenCV（org.openpnp:opencv）直接编译运行 ——
 * 跑的是**将要打包进 APK 的同一份源码**，不是复刻一份 Python 原型。
 *
 * 每个场景合成一张「照片」（背景 + 透视四边形纸面 + 文字 + 光照梯度 + 噪声），
 * 拿真实四角当 ground truth，断言检出四角的 IoU。这样"不裁切"这类问题在本机就能复现和回归。
 */

private const val W = 800
private const val H = 600

data class Scenario(
  val name: String,
  /** 纸面四角（ground truth，像素坐标）；hasPaper=false 时无意义 */
  val paper: List<Point>,
  val paperGray: Double,
  val bgGray: Double,
  /** 是否叠加侧光梯度（模拟一半亮一半暗） */
  val gradient: Boolean = false,
  /** 纸上是否画深色文字（制造掩膜里的洞） */
  val text: Boolean = true,
  val noiseSigma: Double = 6.0,
  /** 画面里到底有没有纸：没有纸时只要求「别谎报检到了」 */
  val hasPaper: Boolean = true,
  val minIou: Double = 0.82
)

fun main() {
  nu.pattern.OpenCV.loadLocally()
  println("OpenCV ${Core.VERSION} on JVM (桌面版绑定，跑的是 native/android 同一份源码)")

  val cx = W / 2.0
  val cy = H / 2.0
  // 正放的大纸（占画面约 55%）
  val straight = listOf(
    Point(cx - 170, cy - 230), Point(cx + 170, cy - 230),
    Point(cx + 170, cy + 230), Point(cx - 170, cy + 230)
  )
  // 透视：上窄下宽 + 轻微旋转（真实俯拍）
  val perspective = listOf(
    Point(cx - 120, cy - 215), Point(cx + 105, cy - 235),
    Point(cx + 185, cy + 225), Point(cx - 185, cy + 205)
  )
  // 斜拍：明显梯形 + 只占画面左半
  val tilted = listOf(
    Point(120.0, 90.0), Point(430.0, 150.0), Point(390.0, 520.0), Point(80.0, 430.0)
  )
  // 只占画面一角的小纸
  val small = listOf(
    Point(60.0, 70.0), Point(420.0, 95.0), Point(405.0, 355.0), Point(50.0, 330.0)
  )
  // 几乎铺满画面（切边本就不该有收益）
  // 手机拍 A4 最常见的构图：纸几乎铺满画面，只在四周露一点桌面
  val closeup = listOf(
    Point(26.0, 32.0), Point(772.0, 22.0), Point(780.0, 566.0), Point(34.0, 574.0)
  )
  // 近拍 + 明显透视（俯拍时上边比下边短得多）
  val closeupSkew = listOf(
    Point(120.0, 40.0), Point(700.0, 26.0), Point(784.0, 574.0), Point(30.0, 560.0)
  )
  // 几乎贴着边拍：只有几像素的桌面
  val nearFull = listOf(
    Point(10.0, 12.0), Point(790.0, 8.0), Point(786.0, 590.0), Point(8.0, 586.0)
  )
  val fullFrame = listOf(
    Point(6.0, 6.0), Point(W - 6.0, 6.0), Point(W - 6.0, H - 6.0), Point(6.0, H - 6.0)
  )

  val scenarios = listOf(
    Scenario("白纸/深色木桌", straight, 238.0, 70.0),
    Scenario("白纸/浅灰桌（低对比）", straight, 242.0, 205.0, minIou = 0.75),
    Scenario("侧光阴影（半亮半暗）", perspective, 240.0, 60.0, gradient = true),
    Scenario("满页文字（掩膜有洞）", perspective, 245.0, 60.0, text = true),
    Scenario("斜拍梯形", tilted, 240.0, 80.0),
    Scenario("高噪声", straight, 238.0, 70.0, noiseSigma = 26.0, minIou = 0.75),
    // 纸比桌面暗：路A 的「亮区」只会框到桌面，这条路必须靠边缘撑住
    Scenario("深色纸/浅桌（路A失效）", straight, 55.0, 190.0, minIou = 0.7),
    // 纸只占画面一角：面积门槛 0.12 之下的误检要拦住，之上的真纸要拿到
    Scenario("小纸（占画面约 20%）", small, 240.0, 85.0, minIou = 0.75),
    // 这三条是「拍 A4」的真实构图：以前一个都没有，于是「纸一大就不裁」的坑没被发现
    Scenario("A4 近拍（占画面约 85%）", closeup, 240.0, 72.0, minIou = 0.9),
    Scenario("A4 近拍 + 强透视", closeupSkew, 240.0, 72.0, minIou = 0.9),
    Scenario("A4 贴边拍（占画面约 96%）", nearFull, 240.0, 72.0, minIou = 0.9),
    Scenario("纸基本铺满画面", fullFrame, 240.0, 70.0, minIou = 0.8),
    Scenario("无纸：纯桌面纹理", straight, 70.0, 70.0, text = false, hasPaper = false)
  )

  var failures = 0
  println()
  println("%-24s %-8s %-9s %-6s %-7s %-6s %-6s %s".format(
    "场景", "路", "detected", "IoU", "面积占比", "置信", "耗时", "结论"))
  println("-".repeat(86))
  for (s in scenarios) {
    val photo = synthesize(s)
    val gray = Mat()
    Imgproc.cvtColor(photo, gray, Imgproc.COLOR_BGR2GRAY)
    val r = QuadDetect.detect(photo, gray, light = false)
    // 回来的四角永远要拿真实纸面比一次：回退框也可能是对的（纸铺满画面时整幅就是正解）
    val quad = r.points.map { Point(it.x * W, it.y * H) }
    val iou = if (s.hasPaper) iou(quad, s.paper) else 0.0
    val ok = when {
      s.hasPaper -> iou >= s.minIou
      // 没有纸时不许谎报「检到了」：回退框可以，但 detected 必须诚实
      else -> !r.detected
    }
    if (!ok) {
      failures += 1
      println("  [${s.name}] 检出四角：${quad.map { "(${Math.round(it.x)},${Math.round(it.y)})" }.joinToString(" ")}")
      println("  [${s.name}] 真值四角：${s.paper.map { "(${Math.round(it.x)},${Math.round(it.y)})" }.joinToString(" ")}")
      diagnose(s.name, gray)
    }
    println(
      "%-24s %-8s %-9s %-6s %-7s %-6s %-6s %s".format(
        s.name, r.source, r.detected, if (s.hasPaper) fmt(iou) else "-",
        fmt(r.areaRatio), fmt(r.confidence), "${r.elapsedMs}ms",
        if (ok) "OK" else "FAIL(需>=${s.minIou})"
      )
    )
    gray.release()
    photo.release()
  }
  println("-".repeat(86))
  if (failures > 0) {
    println("✗ $failures 个场景未通过")
    System.exit(1)
  }
  println("✓ 全部场景通过")
}

/**
 * 失败时把中间量摊开：到底是哪一道闸门把纸拒了。
 *
 * 这里调的是 QuadDetect 的 internal 函数（和源码同一次 kotlinc 编译 = 同一个模块），
 * 所以打印出来的是真闸门的输出，不是在测试里复刻一份「大概一样」的逻辑。
 */
private fun diagnose(name: String, gray: Mat) {
  val w = gray.cols().toDouble()
  val h = gray.rows().toDouble()
  val imgArea = w * h
  val regionBlur = Mat()
  val edgeBlur = Mat()
  val mag = Mat()
  val mask = Mat()
  val edges = Mat()
  val contours = ArrayList<MatOfPoint>()
  val hierarchy = Mat()
  try {
    Imgproc.GaussianBlur(gray, regionBlur, Size(0.0, 0.0), 5.0)
    Imgproc.GaussianBlur(gray, edgeBlur, Size(5.0, 5.0), 1.5)
    QuadDetect.gradientMagnitude(edgeBlur, mag)
    val hist = Histogram.of(mag)
    val medianGrad = Histogram.percentile(hist, 0.5)
    val gate = QuadDetect.MIN_EDGE_SUPPORT * (medianGrad + 1)
    println("  [$name] 梯度 p50=$medianGrad p99=${Histogram.percentile(hist, 0.99)} " +
      "p99.5=${Histogram.percentile(hist, 0.995)}（支撑门槛=${fmt(gate)}）")

    val regionHist = Histogram.of(regionBlur)
    val scratch = Mat()
    val levels = intArrayOf(
      Imgproc.threshold(regionBlur, scratch, 0.0, 255.0, Imgproc.THRESH_BINARY + Imgproc.THRESH_OTSU).toInt(),
      QuadDetect.brightSplitLevel(regionHist)
    )
    scratch.release()
    for (level in levels) {
      for (inv in booleanArrayOf(false, true)) {
        val flag = if (inv) Imgproc.THRESH_BINARY_INV else Imgproc.THRESH_BINARY
        Imgproc.threshold(regionBlur, mask, level.toDouble(), 255.0, flag)
        val ratio = Core.countNonZero(mask).toDouble() / imgArea
        val tag = "路A ${if (inv) "暗" else "亮"}区(level=$level)"
        if (ratio !in 0.06..0.985) {
          println("  [$name] $tag 占比=${fmt(ratio)} -> 门槛 0.06~0.985 之外")
          continue
        }
        QuadDetect.cleanMask(mask)
        QuadDetect.fillHoles(mask)
        reportContours(tag, mask, mag, contours, hierarchy, w, h, imgArea, medianGrad, gate, name)
      }
    }

    val k = Metrics.oddAtLeast(min(edgeBlur.cols(), edgeBlur.rows()) / 12, 9)
    val kernel = Imgproc.getStructuringElement(Imgproc.MORPH_RECT, Size(k.toDouble(), k.toDouble()))
    for (q in doubleArrayOf(0.90, 0.95, 0.99)) {
      val lower = (Histogram.percentile(hist, q) * 8.0).coerceIn(12.0, 400.0)
      val upper = max(Histogram.percentile(hist, min(q + 0.005, 0.999)) * 8.0, lower + 25.0).coerceAtMost(800.0)
      Imgproc.Canny(edgeBlur, edges, lower, upper, 3, true)
      val beforeClose = Core.countNonZero(edges).toDouble() / imgArea
      Imgproc.morphologyEx(edges, edges, Imgproc.MORPH_CLOSE, kernel, Point(-1.0, -1.0), 2)
      println("  [$name] 路B q=$q 阈值=${fmt(lower)}/${fmt(upper)} 闭核=$k 闭前边缘占比=${fmt(beforeClose)}")
      reportContours("路B q$q", edges, mag, contours, hierarchy, w, h, imgArea, medianGrad, gate, name)
    }
    kernel.release()
  } finally {
    regionBlur.release()
    edgeBlur.release()
    mag.release()
    mask.release()
    edges.release()
    hierarchy.release()
    contours.forEach { it.release() }
  }
}

/** 取最大的两块，逐项报闸门：面积占比 / 能否拟合四边形 / 边界支撑 */
private fun reportContours(
  tag: String,
  src: Mat,
  mag: Mat,
  contours: ArrayList<MatOfPoint>,
  hierarchy: Mat,
  w: Double,
  h: Double,
  imgArea: Double,
  medianGrad: Int,
  gate: Double,
  name: String
) {
  Imgproc.findContours(src, contours, hierarchy, Imgproc.RETR_EXTERNAL, Imgproc.CHAIN_APPROX_SIMPLE)
  val ranked = contours.sortedByDescending { Imgproc.contourArea(it) }.take(2)
  if (ranked.isEmpty()) println("  [$name] $tag 没有连通区域")
  for (c in ranked) {
    val ratio = Imgproc.contourArea(c) / imgArea
    val quad = QuadDetect.quadFrom(c, w, h)
    val support = if (quad != null) QuadDetect.edgeSupport(mag, quad, w.toInt(), h.toInt()) else -1.0
    // 轮廓 → 凸包 → 拟合后的面积：三个数字一起看才知道损失发生在哪一步
    val cF = MatOfPoint2f(*c.toArray())
    val rect = org.opencv.imgproc.Imgproc.minAreaRect(cF)
    val boxArea = rect.size.width * rect.size.height / imgArea
    cF.release()
    val quadArea = if (quad != null) QuadDetect.quadArea(quad) / imgArea else -1.0
    val verdict = when {
      ratio < 0.12 -> "太小(<0.12)"
      ratio > 0.94 -> "太大(>0.94 等于没裁)"
      quad == null -> "拟合不出四边形"
      QuadDetect.spansFrame(quad, w, h) -> "包围盒顶满画面(被画面切断)"
      support < gate -> "边界支撑不足"
      else -> "可用"
    }
    val score = if (quad != null) QuadDetect.scoreQuad(quad, ratio, w, h) else -1.0
    println(
      "  [$name] $tag 轮廓占比=${fmt(ratio)} 外接框=${fmt(boxArea)} 拟合=${fmt(quadArea)} " +
        "四边形=${quad != null} 支撑=${fmt(support)} 分=${fmt(score)} -> $verdict"
    )
  }
  contours.forEach { it.release() }
  contours.clear()
}

/** 合成一张「照片」：背景纹理 + 纸 + 文字 + 可选光照梯度 + 高斯噪声 */
private fun synthesize(s: Scenario): Mat {
  val img = Mat(H, W, CvType.CV_8UC3, Scalar(s.bgGray, s.bgGray, s.bgGray))
  // 桌面纹理：一批随机短线，模拟木纹/桌布（对检测是干扰项）
  val rnd = Random(20261023)
  for (i in 0 until 160) {
    val x0 = rnd.nextInt(W)
    val y0 = rnd.nextInt(H)
    val len = 12 + rnd.nextInt(60)
    val dark = (s.bgGray * (0.55 + rnd.nextDouble() * 0.35)).coerceIn(0.0, 255.0)
    Imgproc.line(img, Point(x0.toDouble(), y0.toDouble()), Point((x0 + len).toDouble(), (y0 + len / 3).toDouble()),
      Scalar(dark, dark, dark), 1 + rnd.nextInt(2), Imgproc.LINE_AA)
  }
  if (s.hasPaper) {
    val pts = MatOfPoint(*s.paper.toTypedArray())
    Imgproc.fillConvexPoly(img, pts, Scalar(s.paperGray, s.paperGray, s.paperGray))
    if (s.text) {
      // 纸上的深色文字行：制造 Otsu 掩膜里的洞。
      // ⚠️ 必须先画在掩膜里、再与纸张多边形求交：直接画矩形会溢出到纸张斜边之外，
      // 那些笔画会让「纸的轮廓」出现缺口（掩膜洞与外界连通，fillHoles 补不回来）——
      // 那是合成图的假象，不是真实照片里会发生的事。
      val xs = s.paper.map { it.x }
      val ys = s.paper.map { it.y }
      val left = xs.min() + 24
      val right = xs.max() - 24
      val textMask = Mat.zeros(H, W, CvType.CV_8UC1)
      val paperMask = Mat.zeros(H, W, CvType.CV_8UC1)
      Imgproc.fillConvexPoly(paperMask, MatOfPoint(*s.paper.toTypedArray()), Scalar(255.0))
      var y = ys.min() + 40
      var line = 0
      while (y < ys.max() - 30) {
        val w = (right - left) * (if (line % 3 == 2) 0.55 else 0.92)
        Imgproc.rectangle(textMask, Point(left, y), Point(left + w, y + 9.0), Scalar(255.0), -1)
        y += 26.0
        line += 1
      }
      Core.bitwise_and(textMask, paperMask, textMask)
      img.setTo(Scalar(45.0, 45.0, 45.0), textMask)
      textMask.release()
      paperMask.release()
    }
    pts.release()
  }

  if (s.gradient) {
    // 侧光：按 x 线性压暗左半边（模拟手/身体挡光）
    // 梯度先建成 8U 单通道再一次 put —— Mat 的 double 版 put 是 vararg，逐像素调用慢一个量级
    val rampBytes = ByteArray(H * W)
    for (y in 0 until H) for (x in 0 until W) {
      val v = (255.0 * (0.55 + 0.6 * (x.toDouble() / W))).coerceIn(0.0, 255.0).toInt()
      rampBytes[y * W + x] = v.toByte()
    }
    val ramp8 = Mat(H, W, CvType.CV_8UC1)
    ramp8.put(0, 0, rampBytes)
    val ramp = Mat()
    ramp8.convertTo(ramp, CvType.CV_32F, 1.0 / 255.0)
    val rgb = ArrayList<Mat>()
    Core.split(img, rgb)
    for (c in rgb) {
      val cf = Mat()
      c.convertTo(cf, CvType.CV_32F)
      Core.multiply(cf, ramp, cf)
      cf.convertTo(c, CvType.CV_8U)
      cf.release()
    }
    Core.merge(rgb, img)
    rgb.forEach { it.release() }
    ramp.release()
    ramp8.release()
  }

  if (s.noiseSigma > 0) {
    val noise = Mat(H, W, CvType.CV_32FC3)
    Core.randn(noise, 0.0, s.noiseSigma)
    val asF = Mat()
    img.convertTo(asF, CvType.CV_32FC3)
    Core.add(asF, noise, asF)
    asF.convertTo(img, CvType.CV_8UC3)
    asF.release()
    noise.release()
  }

  // 轻微模糊：镜头软 + JPEG 压缩的综合效果
  Imgproc.GaussianBlur(img, img, Size(3.0, 3.0), 0.8)
  return img
}

/** 凸多边形 IoU（Sutherland–Hodgman 裁剪） */
private fun iou(a: List<Point>, b: List<Point>): Double {
  val inter = clipArea(a, b)
  val union = QuadDetect.quadArea(QuadDetect.orderCorners(a)) + QuadDetect.quadArea(QuadDetect.orderCorners(b)) - inter
  return if (union <= 0) 0.0 else (inter / union).coerceIn(0.0, 1.0)
}

private fun clipArea(subjectIn: List<Point>, clip: List<Point>): Double {
  val subject = QuadDetect.orderCorners(subjectIn).toMutableList()
  val clipPoly = QuadDetect.orderCorners(clip)
  for (i in clipPoly.indices) {
    if (subject.isEmpty()) return 0.0
    val a = clipPoly[i]
    val b = clipPoly[(i + 1) % clipPoly.size]
    val input = subject.toList()
    subject.clear()
    for (j in input.indices) {
      val cur = input[j]
      val nxt = input[(j + 1) % input.size]
      val curIn = side(a, b, cur) >= 0
      val nxtIn = side(a, b, nxt) >= 0
      if (curIn) subject.add(cur)
      if (curIn != nxtIn) {
        val p = intersect(cur, nxt, a, b) ?: continue
        subject.add(p)
      }
    }
  }
  return abs(QuadDetect.quadArea(subject))
}

private fun side(a: Point, b: Point, p: Point): Double =
  (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)

private fun intersect(p1: Point, p2: Point, p3: Point, p4: Point): Point? {
  val d1 = p2.x - p1.x
  val d2 = p2.y - p1.y
  val d3 = p4.x - p3.x
  val d4 = p4.y - p3.y
  val denom = d1 * d4 - d2 * d3
  if (abs(denom) < 1e-9) return null
  val t = ((p3.x - p1.x) * d4 - (p3.y - p1.y) * d3) / denom
  return Point(p1.x + t * d1, p1.y + t * d2)
}

private fun fmt(v: Double): String = String.format("%.2f", v)
