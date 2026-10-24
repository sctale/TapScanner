package com.tapscanner.verify

import com.tapscanner.app.DocPipeline
import com.tapscanner.app.PageSurface
import com.tapscanner.app.QuadDetect
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfPoint
import org.opencv.core.Point
import org.opencv.core.Scalar
import org.opencv.core.Size
import org.opencv.imgcodecs.Imgcodecs
import org.opencv.imgproc.Imgproc
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sin

import kotlin.system.exitProcess

/**
 * 弯曲纸面展开的验证台（tools/verify/run.sh 调用）。
 *
 * 这里要回答的问题只有一个：**纸在照片里不是矩形时，出图有没有变成矩形**。
 * 四角检测的 IoU 量不到这件事（四边形拟合天生会把弯边"平均"成直的），
 * 所以这条验证台跑的是完整链路：合成弯边纸 → 检测四角 → 单应矫正 → PageSurface 展开，
 * 然后**用同一把尺子量两次**：矫正后、展开后的残余弯曲度。
 *
 * 断言分两头，缺一条都不算过：
 *   - 弯的必须被掰直（残余弯曲降到噪声水平，或至少比原来直 60% 以上）；
 *   - 直的**不许被改动**（不然每一张正常扫描件都白白挨一次重采样，字会糊）。
 * 另外还量了「面积不许缩水」—— 展开是把边拉直，不是把纸裁掉。
 */

private const val W = 900
private const val H = 1200
private const val OUT_DIR = "qa-out/verify"

/** 每条边的弓高（占该边长的比例）。正 = 向内凹，负 = 向外鼓 */
data class CurvedCase(
  val name: String,
  val top: Double = 0.0,
  val bottom: Double = 0.0,
  val left: Double = 0.0,
  val right: Double = 0.0,
  val gradient: Boolean = false,
  val noiseSigma: Double = 6.0,
  /** 期望：这一条根本不该被展开（直边） */
  val expectUntouched: Boolean = false,
  /** 期望：弯边至少要有这么明显（防止场景本身没测到东西） */
  val minBefore: Double = 0.008
)

fun main() {
  nu.pattern.OpenCV.loadLocally()
  println()
  println("== 弯曲纸面展开 ==")
  java.io.File(OUT_DIR).mkdirs()

  val cases = listOf(
    CurvedCase("直边（不该动它）", expectUntouched = true),
    CurvedCase("上边向外鼓 4%", top = 0.04),
    CurvedCase("下边向内凹 5%", bottom = -0.05),
    CurvedCase("左右都外鼓（纸翘起来）", left = 0.06, right = 0.06),
    CurvedCase("四边全弯 + 侧光 + 噪声", top = 0.04, bottom = -0.03, left = 0.05, right = -0.04, gradient = true, noiseSigma = 14.0)
  )

  var failures = 0
  println(
    "%-26s %-16s %-9s %-9s %-9s %-8s %s".format(
      "场景", "路/面积", "弯(矫正后)", "弯(展开后)", "面积比", "耗时", "结论"
    )
  )
  println("-".repeat(96))
  for (c in cases) {
    val started = System.currentTimeMillis()
    val photo = synthesize(c)
    val gray = Mat()
    Imgproc.cvtColor(photo, gray, Imgproc.COLOR_BGR2GRAY)
    val quad = QuadDetect.detect(photo, gray, light = false)
    val quadPx = QuadDetect.toPixels(quad.points, W.toDouble(), H.toDouble())
    val rect = DocPipeline.warp(photo, quadPx, 1000)
    val bBefore = PageSurface.measure(rect)
    val before = bBefore?.curvature() ?: 0.0
    val surfaced = PageSurface.straighten(rect)
    val after = PageSurface.measure(surfaced.image)?.curvature() ?: 0.0
    val areaBefore = paperAreaRatio(rect)
    val areaAfter = paperAreaRatio(surfaced.image)
    val ratio = if (areaBefore > 0) areaAfter / areaBefore else 0.0
    val ms = System.currentTimeMillis() - started

    val verdict = when {
      !quad.detected -> "FAIL(没检出纸边)"
      c.expectUntouched -> {
        if (surfaced.applied) "FAIL(直边被改动了)" else "OK"
      }
      else -> when {
        before < c.minBefore -> "FAIL(场景本身弯曲不够，测不到东西)"
        !surfaced.applied -> "FAIL(弯边没被展开)"
        after > max(PageSurface.MIN_CURVATURE, before * 0.4) -> "FAIL(展开后仍然弯)"
        ratio < 0.9 -> "FAIL(展开把纸弄丢了 %.2f)".format(ratio)
        else -> "OK"
      }
    }
    if (verdict != "OK") failures++
    println(
      "%-26s %-8s %-9s %-9s %-9s %-7s %s".format(
        c.name, "${quad.source}/${quad.areaRatio}".format(), "%.4f".format(before), "%.4f".format(after),
        "%.3f".format(ratio), "${ms}ms", verdict
      )
    )

    // 诊断：四条边各自的偏移极值（量测帧像素）。弯边场景一眼能看出是哪条边在动
    println("    矫正图 ${rect.cols()}×${rect.rows()}  掩膜面积比 ${"%.3f".format(paperAreaRatio(rect))}")
    bBefore?.let {
      println(
        "    边偏移 上[%d..%d] 下[%d..%d] 左[%d..%d] 右[%d..%d]（%d×%d）".format(
          it.top.minOrNull()!!.toInt(), it.top.maxOrNull()!!.toInt(),
          it.bottom.minOrNull()!!.toInt(), it.bottom.maxOrNull()!!.toInt(),
          it.left.minOrNull()!!.toInt(), it.left.maxOrNull()!!.toInt(),
          it.right.minOrNull()!!.toInt(), it.right.maxOrNull()!!.toInt(),
          it.width, it.height
        )
      )
    } ?: println("    边偏移：量不到（掩膜不是一张纸）")

    val tag = "case-%02d".format(cases.indexOf(c) + 1)
    Imgcodecs.imwrite("$OUT_DIR/$tag-1-rectified.jpg", rect)
    Imgcodecs.imwrite("$OUT_DIR/$tag-2-straightened.jpg", surfaced.image)
    rect.release(); surfaced.image.release(); gray.release(); photo.release()
  }
  println("-".repeat(96))
  if (failures == 0) println("✓ 弯曲纸面展开全部通过") else println("✗ $failures 个弯曲场景未通过")
  if (failures > 0) kotlin.system.exitProcess(1)
}

/** 纸占画面的比例（用「比背景亮」粗分即可，这里只用来比较展开前后有没有丢内容） */
private fun paperAreaRatio(img: Mat): Double {
  val gray = Mat()
  Imgproc.cvtColor(img, gray, Imgproc.COLOR_BGR2GRAY)
  Imgproc.GaussianBlur(gray, gray, Size(0.0, 0.0), 3.0)
  val big = Mat()
  Imgproc.resize(gray, big, Size(160.0, 213.0), 0.0, 0.0, Imgproc.INTER_AREA)
  val hist = IntArray(256)
  val bytes = ByteArray(big.rows() * big.cols())
  big.get(0, 0, bytes)
  for (b in bytes) hist[b.toInt() and 0xFF]++
  // 双峰里取高的那侧作为纸（矫正图里纸占绝对多数，这个假设成立）
  var best = 0.0
  var bestLevel = 0.0
  for (level in 32..240) {
    var hi = 0
    for (v in level..255) hi += hist[v]
    var lo = 0
    for (v in 0 until level) lo += hist[v]
    val score = minOf(hi, lo).toDouble() / maxOf(1, maxOf(hi, lo))
    if (score > best) {
      best = score
      bestLevel = level.toDouble()
    }
  }
  val mask = Mat()
  Imgproc.threshold(big, mask, bestLevel, 255.0, Imgproc.THRESH_BINARY)
  val ratio = Core.countNonZero(mask).toDouble() / (mask.rows() * mask.cols())
  gray.release(); big.release(); mask.release()
  return ratio
}

/**
 * 合成一张「边是弯的」纸：桌面背景 + 弯曲多边形纸面 + 满页文字 + 可选侧光 + 噪声。
 *
 * 弯曲是按边的法向加一个半正弦弓形（sin(πt)），所以两端仍精确落在角点上 ——
 * 真实照片里翘起来的纸就是这个形状：角还在原处，边弓出去。
 */
private fun synthesize(c: CurvedCase): Mat {
  val rnd = java.util.Random(20261024)
  val bg = 74.0
  val paper = 238.0
  val photo = Mat(H, W, CvType.CV_8UC3, Scalar(bg, bg, bg))
  // 桌面木纹：横向低频条纹，给边缘腿一点干扰，不至于太干净
  for (y in 0 until H step 7) {
    Imgproc.line(
      photo, Point(0.0, y.toDouble()), Point(W.toDouble(), (y + 3).toDouble()),
      Scalar((bg - 8 + (y % 13) * 0.6), (bg - 6.0), (bg - 2.0)), 2
    )
  }
  val x0 = 120.0; val x1 = W - 120.0
  val y0 = 150.0; val y1 = H - 150.0
  val corners = listOf(Point(x0, y0), Point(x1, y0), Point(x1, y1), Point(x0, y1))
  val bows = listOf(c.top, c.right, c.bottom, c.left)
  val boundary = ArrayList<Point>()
  for (i in 0 until 4) {
    val a = corners[i]
    val b = corners[(i + 1) % 4]
    val len = hypot(b.x - a.x, b.y - a.y)
    // 单位法向（顺时针绕行 → 指向纸外）。所以 bow 为正 = 这条边向外鼓，为负 = 向内凹
    val nx = (b.y - a.y) / len
    val ny = -(b.x - a.x) / len
    val bow = bows[i] * len
    val steps = 60
    for (s in 0 until steps) {
      val t = s.toDouble() / steps
      val off = bow * sin(Math.PI * t)
      boundary.add(Point(a.x + (b.x - a.x) * t + nx * off, a.y + (b.y - a.y) * t + ny * off))
    }
  }
  val pts = MatOfPoint(*boundary.toTypedArray())
  val mask = Mat.zeros(H, W, CvType.CV_8UC1)
  Imgproc.fillPoly(mask, listOf(pts), Scalar(255.0))
  val sheet = Mat(H, W, CvType.CV_8UC3, Scalar(paper, paper, paper))
  // 满页文字：横向笔画，让掩膜里有洞（和真实文档一样）
  var y = y0 + 40
  while (y < y1 - 30) {
    Imgproc.line(sheet, Point(x0 + 30, y), Point(x1 - 30, y), Scalar(40.0, 40.0, 40.0), 4)
    Imgproc.line(sheet, Point(x0 + 30, y + 14), Point(x1 - 120, y + 14), Scalar(70.0, 70.0, 70.0), 3)
    y += 34
  }
  sheet.copyTo(photo, mask)
  if (c.gradient) {
    // 侧光：左亮右暗的乘性梯度（真实桌面最常见的坏情况）
    val rampValues = FloatArray(H * W)
    for (row in 0 until H) {
      for (col in 0 until W) rampValues[row * W + col] = (0.62 + 0.55 * col / W).toFloat()
    }
    val ramp = Mat(H, W, CvType.CV_32FC1)
    ramp.put(0, 0, rampValues)
    val planes = ArrayList<Mat>()
    Core.split(photo, planes)
    for (p in planes) {
      val f = Mat(); p.convertTo(f, CvType.CV_32FC1)
      Core.multiply(f, ramp, f)
      f.convertTo(p, CvType.CV_8UC1)
      f.release()
    }
    Core.merge(planes, photo)
    planes.forEach { it.release() }
    ramp.release()
  }
  if (c.noiseSigma > 0) {
    val noiseValues = FloatArray(H * W) { (rnd.nextGaussian() * c.noiseSigma + 128.0).toFloat() }
    val noise = Mat(H, W, CvType.CV_32FC1)
    noise.put(0, 0, noiseValues)
    val planes = ArrayList<Mat>()
    Core.split(photo, planes)
    for (p in planes) {
      val f = Mat(); p.convertTo(f, CvType.CV_32FC1)
      Core.subtract(f, noise, f)
      f.convertTo(p, CvType.CV_8UC1)
      f.release()
    }
    Core.merge(planes, photo)
    planes.forEach { it.release() }
    noise.release()
  }
  pts.release(); mask.release(); sheet.release()
  return photo
}
