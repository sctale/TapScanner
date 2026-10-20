package com.tapscanner.app

import org.opencv.core.Mat
import org.opencv.core.MatOfPoint
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Size
import org.opencv.core.TermCriteria
import org.opencv.imgproc.Imgproc
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * 文档边界检测 —— 智能高清的第一步：把纸从背景里摘出来。
 *
 * 只做经典 CV：Canny（阈值按图中位数自适应）→ 闭运算接起断口 → 外轮廓 →
 * 多边形拟合 → 四边形校验（凸性/面积/四角角度/最短边）→ 亚像素精化。
 *
 * 两条硬规矩：
 *   1. **一定要返回四角**。检测不到就退到最小外接矩形，再不行退到 3% 内缩框 ——
 *      用户总能自己拖，绝不能出现「没检测到所以没法切边」的死路。
 *   2. 置信度如实上报，界面据此决定要不要把框显示成「需要你确认」。
 *
 * 输入是降采样图（分析尺寸），输出归一化 0..1；调用方按全分辨率还原。
 */
object QuadDetect {
  /** 面积至少占画面这么多才算「这是一张纸」 */
  private const val MIN_AREA_RATIO = 0.18

  /** 四角允许的角度区间（纸张透视后不会是尖锐的角） */
  private const val MIN_ANGLE_DEG = 55.0
  private const val MAX_ANGLE_DEG = 125.0

  /** 最短边不能小于图长的 8%，否则是细长误检（桌沿、书脊） */
  private const val MIN_EDGE_RATIO = 0.08

  /** 兜底内缩框：从边缘往里收 3% */
  private const val FALLBACK_INSET_RATIO = 0.03

  /** 精化后角点重合的判定阈值（归一化坐标） */
  private const val DEGENERATE_EPS = 1e-3

  data class Result(
    /** 归一化四角，顺序固定 左上→右上→右下→左下 */
    val points: List<Point>,
    /** true = 真检测到了轮廓；false = 走了回退框 */
    val detected: Boolean,
    /** 0..1，面积占比与角度规整度的综合 */
    val confidence: Double,
    val elapsedMs: Long
  ) {
    /** 拍平给 RN bridge：[x0,y0,x1,y1,...] 归一化 */
    fun flat(): List<Double> = points.flatMap { listOf(it.x, it.y) }
  }

  /**
   * @param gray      已算好的灰度图（复用调用方的，别重复 cvtColor）
   * @param light     实时取景档位：跳过亚像素精化，预览帧只要求跟手
   */
  fun detect(bgr: Mat, gray: Mat, light: Boolean = false): Result {
    val started = System.currentTimeMillis()
    val w = bgr.cols().toDouble()
    val h = bgr.rows().toDouble()
    if (w <= 0 || h <= 0) {
      return Result(insetQuadNormalized(), false, 0.0, 0L)
    }
    val imgArea = w * h

    val work = Mat()
    val edges = Mat()
    val hierarchy = Mat()
    val contours = ArrayList<MatOfPoint>()
    var closeKernel: Mat? = null
    var growKernel: Mat? = null
    try {
      Imgproc.cvtColor(bgr, work, Imgproc.COLOR_BGR2GRAY)
      Imgproc.GaussianBlur(work, work, Size(5.0, 5.0), 1.5)

      // 阈值跟着图中位数走：暗光和亮室用同一套判定，不需要用户先「调好光线」
      val med = Histogram.percentile(Histogram.of(work), 0.5).toDouble()
      val lower = max(0.0, 0.67 * med)
      val upper = min(255.0, 1.33 * med)
      Imgproc.Canny(work, edges, lower, upper, 3, true)

      closeKernel = Imgproc.getStructuringElement(Imgproc.MORPH_RECT, Size(5.0, 5.0))
      Imgproc.morphologyEx(edges, edges, Imgproc.MORPH_CLOSE, closeKernel!!)
      growKernel = Imgproc.getStructuringElement(Imgproc.MORPH_RECT, Size(3.0, 3.0))
      Imgproc.dilate(edges, edges, growKernel!!)

      Imgproc.findContours(
        edges, contours, hierarchy, Imgproc.RETR_EXTERNAL, Imgproc.CHAIN_APPROX_SIMPLE
      )

      val candidates = contours
        .map { it to Imgproc.contourArea(it) }
        .filter { it.second > imgArea * MIN_AREA_RATIO }
        .sortedByDescending { it.second }
        .take(5)
        .map { it.first }

      for (contour in candidates) {
        val pixelQuad = quadFrom(contour, w, h) ?: continue
        val refined = if (light) pixelQuad else refine(gray, pixelQuad, w, h) ?: pixelQuad
        val normalized = normalized(orderCorners(refined), w, h)
        return Result(
          points = normalized,
          detected = true,
          confidence = confidenceOf(refined, imgArea),
          elapsedMs = System.currentTimeMillis() - started
        )
      }

      // 回退 1：最大轮廓的最小外接矩形（纸被压斜、边缘断成弧时仍然能用）
      val biggest = contours.maxByOrNull { Imgproc.contourArea(it) }
      if (biggest != null && Imgproc.contourArea(biggest) > imgArea * 0.08) {
        val rectQuad = quadFromMinAreaRect(biggest, w, h)
        if (rectQuad != null) {
          return Result(
            points = normalized(orderCorners(rectQuad), w, h),
            detected = true,
            confidence = 0.35,
            elapsedMs = System.currentTimeMillis() - started
          )
        }
      }
    } finally {
      work.release()
      edges.release()
      hierarchy.release()
      closeKernel?.release()
      growKernel?.release()
      contours.forEach { it.release() }
    }

    // 回退 2：3% 内缩框 —— 绝不空手而归
    return Result(
      points = insetQuadNormalized(),
      detected = false,
      confidence = 0.0,
      elapsedMs = System.currentTimeMillis() - started
    )
  }

  // ---------- 内部实现 ----------

  /** 多边形拟合 + 四边形校验；不合格返回 null，交给下一个候选 */
  private fun quadFrom(contour: MatOfPoint, w: Double, h: Double): List<Point>? {
    val pts = contour.toArray()
    if (pts.size < 4) return null
    if (!Imgproc.isContourConvex(contour)) return null
    val asFloat = MatOfPoint2f(*pts)
    val approx = MatOfPoint2f()
    return try {
      val perimeter = Imgproc.arcLength(asFloat, true)
      if (perimeter <= 0) return null
      Imgproc.approxPolyDP(asFloat, approx, 0.02 * perimeter, true)
      val corners = approx.toArray()
      if (corners.size != 4) return null
      if (Imgproc.contourArea(asFloat) < w * h * MIN_AREA_RATIO) return null

      val list = corners.toList()
      val maxDim = max(w, h)
      val edgeLengths = listOf(distance(list[0], list[1]), distance(list[1], list[2]),
        distance(list[2], list[3]), distance(list[3], list[0]))
      if (edgeLengths.min() < maxDim * MIN_EDGE_RATIO) return null

      // 四角都要接近直角（透视后允许 55°~125°）
      for (i in list.indices) {
        val angle = angleDeg(list[(i + 3) % 4], list[i], list[(i + 1) % 4])
        if (angle < MIN_ANGLE_DEG || angle > MAX_ANGLE_DEG) return null
      }
      list
    } finally {
      asFloat.release()
      approx.release()
    }
  }

  /** 亚像素精化：把角点吸附到真实边缘上，矫正后文字才不会歪 */
  private fun refine(gray: Mat, quad: List<Point>, w: Double, h: Double): List<Point>? {
    if (gray.empty() || quad.size != 4) return null
    val corners = MatOfPoint2f(*quad.toTypedArray())
    return try {
      Imgproc.cornerSubPix(
        gray,
        corners,
        Size(5.0, 5.0),
        Size(-1.0, -1.0),
        TermCriteria(TermCriteria.EPS + TermCriteria.COUNT, 50, 0.01)
      )
      val refined = corners.toArray().toList()
      val insideAll = refined.all {
        it.x >= 0.0 && it.y >= 0.0 && it.x <= w && it.y <= h
      }
      // 精化偶尔会把角点甩出画面或甩到一起；两种情况都当作精化失败
      val degenerate = refined.indices.any { i ->
        refined.withIndex().any { (j, pj) ->
          j != i && distance(pj, refined[i]) < DEGENERATE_EPS * max(w, h)
        }
      }
      if (insideAll && !degenerate) refined else null
    } finally {
      corners.release()
    }
  }

  private fun quadFromMinAreaRect(contour: MatOfPoint, w: Double, h: Double): List<Point>? {
    val asFloat = MatOfPoint2f(*contour.toArray())
    val box = MatOfPoint2f()
    return try {
      val rect = Imgproc.minAreaRect(asFloat)
      Imgproc.boxPoints(rect, box)
      val pts = box.toArray().toList()
      if (pts.size != 4) return null
      if (rect.size.width * rect.size.height < w * h * 0.05) return null
      pts
    } finally {
      asFloat.release()
      box.release()
    }
  }

  private fun normalized(quad: List<Point>, w: Double, h: Double): List<Point> =
    quad.map { Point(it.x / w, it.y / h) }

  private fun insetQuadNormalized(): List<Point> {
    val i = FALLBACK_INSET_RATIO
    return listOf(Point(i, i), Point(1 - i, i), Point(1 - i, 1 - i), Point(i, 1 - i))
  }

  /**
   * 固定成 左上→右上→右下→左下。
   *
   * 用 sum/diff 而不是极角排序：轮廓返回的起点是任意的；
   * 而顺序一旦错了，透视变换会把纸翻面 —— 那是最贵的一类 bug，因为「看起来还是一张纸」。
   */
  fun orderCorners(points: List<Point>): List<Point> {
    if (points.size != 4) return points
    val tl = points.minByOrNull { it.x + it.y } ?: return points
    val br = points.maxByOrNull { it.x + it.y } ?: return points
    val tr = points.maxByOrNull { it.x - it.y } ?: return points
    val bl = points.minByOrNull { it.x - it.y } ?: return points
    return listOf(tl, tr, br, bl)
  }

  private fun confidenceOf(quad: List<Point>, imgArea: Double): Double {
    val areaScore = (quadArea(quad) / imgArea).coerceIn(0.0, 1.0)
    var deviation = 0.0
    for (i in quad.indices) {
      val angle = angleDeg(quad[(i + 3) % 4], quad[i], quad[(i + 1) % 4])
      deviation += abs(angle - 90.0)
    }
    val angleScore = 1.0 - (deviation / 4.0 / 45.0).coerceIn(0.0, 1.0)
    return (0.6 * areaScore + 0.4 * angleScore).coerceIn(0.0, 1.0)
  }

  /** 鞋带公式（像素或归一化坐标都成立，只要一致） */
  fun quadArea(quad: List<Point>): Double {
    var sum = 0.0
    for (i in quad.indices) {
      val j = (i + 1) % quad.size
      sum += quad[i].x * quad[j].y - quad[j].x * quad[i].y
    }
    return abs(sum) / 2.0
  }

  fun distance(a: Point, b: Point): Double = hypot(a.x - b.x, a.y - b.y)

  private fun angleDeg(a: Point, b: Point, c: Point): Double {
    val v1x = a.x - b.x
    val v1y = a.y - b.y
    val v2x = c.x - b.x
    val v2y = c.y - b.y
    val dot = v1x * v2x + v1y * v2y
    val cross = v1x * v2y - v1y * v2x
    return Math.toDegrees(atan2(abs(cross), dot))
  }

  // ---------- 给 DocPipeline / QA 台复用的几何 ----------

  data class TargetSize(val width: Int, val height: Int)

  /**
   * 四角 → 矫正后的目标尺寸（顺序必须是 TL,TR,BR,BL）。
   * 边长取对边较大者，长宽比按像素数保留；超过 maxSide 整体等比缩。
   */
  fun targetSize(quad: List<Point>, maxSide: Int): TargetSize {
    if (quad.size != 4) return TargetSize(maxSide, maxSide)
    val top = distance(quad[0], quad[1])
    val bottom = distance(quad[3], quad[2])
    val left = distance(quad[0], quad[3])
    val right = distance(quad[1], quad[2])
    var w = max(top, bottom)
    var h = max(left, right)
    if (w < 1 || h < 1) return TargetSize(1, 1)
    val longest = max(w, h)
    if (longest > maxSide) {
      val scale = maxSide / longest
      w *= scale
      h *= scale
    }
    return TargetSize(w.toInt().coerceAtLeast(1), h.toInt().coerceAtLeast(1))
  }

  /** 归一化四角 → 像素四角 */
  fun toPixels(quad: List<Point>, w: Double, h: Double): List<Point> =
    quad.map { Point(it.x * w, it.y * h) }
}
