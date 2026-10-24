package com.tapscanner.app

import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfPoint
import org.opencv.core.Point
import org.opencv.core.Scalar
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * 四条边各自的「向内凹 / 向外弓」偏移曲线。
 *
 * 单位是**量测帧**的像素（measure 里那张 ≤900px 的小图），已经减过均值 ——
 * 也就是只保留「弯曲」，不保留「整体位移」。这不是偷懒：
 * 整体位移该由四角决定（用户拖角、向外放边都在管这件事），
 * 这里只管把弓起来的边掰直。两边各管一件事，才不会互相把对方的成果抹掉。
 *
 * 符号约定（都是「纸往画面里缩了多少」，正值 = 缩）：
 *  top[x]    这一列的纸边界离顶边多远     bottom[x] 离底边多远
 *  left[y]   这一行的纸边界离左边多远     right[y]  离右边多远
 */
class Boundary(
  val width: Int,
  val height: Int,
  val top: DoubleArray,
  val bottom: DoubleArray,
  val left: DoubleArray,
  val right: DoubleArray,
) {
  /** 最大弯曲 ÷ 所在边长。0.004 = 千分之四，低于它就是噪声 */
  fun curvature(): Double {
    val w = max(1, width).toDouble()
    val h = max(1, height).toDouble()
    return maxOf(top.maxAbs() / w, bottom.maxAbs() / w, left.maxAbs() / h, right.maxAbs() / h)
  }
}

private fun DoubleArray.maxAbs(): Double {
  var m = 0.0
  for (v in this) {
    val a = abs(v)
    if (a > m) m = a
  }
  return m
}

/**
 * 弯曲纸面展开 —— 纸在照片里不是方方正正的矩形时，把它掰成矩形。
 *
 * ## 为什么需要它（四角 + 单应不够）
 * 单应变换只能处理「纸是矩形、但被斜着拍」。它对**直线**保持性是无能为力的反面：
 * 一张纸翘起来、压在书脊上、或者桌面本身把纸顶成弧形时，纸的四条边在照片里是**曲线**，
 * 四个角再怎么拖准，裁出来仍然是「一边鼓出来、一边切进去」，而且鼓出来的那条常常正是桌面。
 *
 * ## 做法（经典的两步边界驱动网格，不用神经网络）
 *   1. 先按四角做单应 —— 斜的先拉正，四角精确落到矩形四角；
 *   2. 在拉正后的图里量四条边各自还剩多少弯曲（纸掩膜的外轮廓，逐列/逐行取边界）；
 *   3. 把这份弯曲当成一个平滑位移场：目标矩形里的每个点，按它在四条边之间的
 *      相对位置，向对应的边界偏移插值出源点（Coons 形式的双线性混合，
 *      角上偏移天然为 0，所以不会跟第一步的成果打架）；
 *   4. remap 一次，弯边变直，纸内部跟着平滑展开。
 *
 * 位移场是在**小图**上算的（≤900px），再双线性放大到全分辨率 ——
 * 放大本身就是平滑，既省掉 600 万次逐像素循环，也让展开结果不会有台阶。
 *
 * ## 什么时候不动
 * 弯曲小于 [MIN_CURVATURE]（边长的千分之四）时原样返回：直边照片硬要「展开」
 * 只会引入插值模糊。宁可不修，也不要修坏。
 */
object PageSurface {

  /** 量测帧最长边。再大也不会更准，只会更慢 */
  private const val MEASURE_MAX_SIDE = 900.0

  /** 低于这个弯曲度就当纸是直的（边长的千分之四） */
  const val MIN_CURVATURE = 0.004

  /** 弯曲位移的上限（相对所在边长）：轮廓被噪声撕开时不让它把整页拽飞 */
  private const val MAX_DEVIATION_RATIO = 0.18

  /** 平滑窗口（相对边长）：纸边的弓形是低频的，字和纹理是高频的 */
  private const val SMOOTH_RATIO = 0.05

  data class Result(val image: Mat, val curvature: Double, val applied: Boolean)

  /**
   * 拉直一张已经按四角矫正过的图。
   * 返回的 Mat 一定是新分配的（调用方负责 release）；没动时也返回克隆，
   * 好让调用方的释放逻辑只有一套。
   */
  fun straighten(rectified: Mat, minCurvature: Double = MIN_CURVATURE): Result {
    val boundary = measure(rectified)
      ?: return Result(rectified.clone(), 0.0, false)
    val curvature = boundary.curvature()
    if (curvature < minCurvature) return Result(rectified.clone(), curvature, false)
    val warped = remap(rectified, boundary) ?: return Result(rectified.clone(), curvature, false)
    return Result(warped, curvature, true)
  }

  /** 位移场 → 目标图。任何一步不成（尺寸异常、remap 抛错）都返回 null，让调用方退回原图 */
  private fun remap(rectified: Mat, b: Boundary): Mat? {
    val w = rectified.cols()
    val h = rectified.rows()
    if (w < 16 || h < 16) return null
    val gw = b.width
    val gh = b.height
    val xs = FloatArray(gw * gh)
    val ys = FloatArray(gw * gh)
    for (j in 0 until gh) {
      val v = if (gh > 1) j.toDouble() / (gh - 1) else 0.0
      val dl = b.left[j]
      val dr = b.right[j]
      for (i in 0 until gw) {
        val u = if (gw > 1) i.toDouble() / (gw - 1) else 0.0
        // 目标点落在「左右两条边之间」的相对位置 u，就按同样的相对位置去源图取
        val ox = (1.0 - u) * dl - u * dr
        val oy = (1.0 - v) * b.top[i] - v * b.bottom[i]
        xs[j * gw + i] = ((i + ox) * w / gw).toFloat()
        ys[j * gw + i] = ((j + oy) * h / gh).toFloat()
      }
    }
    val mapX = Mat(gh, gw, CvType.CV_32FC1)
    val mapY = Mat(gh, gw, CvType.CV_32FC1)
    val bigX = Mat()
    val bigY = Mat()
    val dst = Mat()
    try {
      mapX.put(0, 0, xs)
      mapY.put(0, 0, ys)
      Imgproc.resize(mapX, bigX, Size(w.toDouble(), h.toDouble()), 0.0, 0.0, Imgproc.INTER_LINEAR)
      Imgproc.resize(mapY, bigY, Size(w.toDouble(), h.toDouble()), 0.0, 0.0, Imgproc.INTER_LINEAR)
      Imgproc.remap(rectified, dst, bigX, bigY, Imgproc.INTER_LINEAR, Core.BORDER_REPLICATE)
    } catch (t: Throwable) {
      dst.release()
      return null
    } finally {
      mapX.release(); mapY.release(); bigX.release(); bigY.release()
    }
    if (dst.empty()) {
      dst.release()
      return null
    }
    return dst
  }

  /**
   * 量四条边还剩多少弯。量不到（纸掩膜不像一张纸）返回 null。
   *
   * 为什么按「轮廓顺序 + 四个角点」切边，而不是逐行逐列扫掩膜、也不是按最近边分点：
   *  - 扫掩膜会串台：靠近顶弧的那几行，「第一个纸像素」落在弧上而不是左边上，
   *    左边被量出上百像素的假弯曲（实测第一版就是这么坏的）；
   *  - 按最近边分点会丢信息：弧的两端本来就贴着左右边，被判给左右，
   *    于是「上边」只剩弧顶那一段 —— 而弧顶往往正好被裁到画面外，量出来全是 0。
   * 轮廓是有序的闭合曲线，先找到离矩形四角最近的四个点，按顺序切成四段，
   * 一段就是一条边，弓形完整地留在自己那条边上。
   */
  fun measure(rect: Mat): Boundary? {
    val w = rect.cols()
    val h = rect.rows()
    if (w < 64 || h < 64) return null
    val scale = min(1.0, MEASURE_MAX_SIDE / max(w, h).toDouble())
    val sw = max(64, Math.round(w * scale).toInt())
    val sh = max(64, Math.round(h * scale).toInt())
    val small = Mat()
    Imgproc.resize(rect, small, Size(sw.toDouble(), sh.toDouble()), 0.0, 0.0, Imgproc.INTER_AREA)
    val contour = paperContour(small) ?: run { small.release(); return null }
    try {
      val pts = contour.toArray()
      if (pts.size < 32) return null
      val top = DoubleArray(sw) { Double.NaN }
      val bottom = DoubleArray(sw) { Double.NaN }
      val left = DoubleArray(sh) { Double.NaN }
      val right = DoubleArray(sh) { Double.NaN }
      val n = pts.size
      val targets = arrayOf(
        Point(0.0, 0.0), Point((sw - 1).toDouble(), 0.0),
        Point((sw - 1).toDouble(), (sh - 1).toDouble()), Point(0.0, (sh - 1).toDouble())
      )
      val at = IntArray(4) { k ->
        var best = 0
        var bestD = Double.MAX_VALUE
        for (i in 0 until n) {
          val dx = pts[i].x - targets[k].x
          val dy = pts[i].y - targets[k].y
          val d = dx * dx + dy * dy
          if (d < bestD) { bestD = d; best = i }
        }
        best
      }
      val gap = max(2, n / 16)
      val usable = (0 until 4).all { k ->
        val a = at[k]
        val b = at[(k + 1) % 4]
        val forward = if (b >= a) b - a else b + n - a
        forward >= gap
      }
      if (!usable) return null
      if (System.getenv("SURFACE_DEBUG") != null) {
        println("    [measure] n=$n at=${at.joinToString()} 尺寸=${sw}x$sh p0=${pts[0]} pMid=${pts[n / 2]} 类型=${pts::class.java.componentType}")
      }
      // 轮廓的绕行方向不保证（OpenCV 给的外轮廓常常是 TL→BL→BR→TR，正好和角点编号反过来）。
      // 所以先把四个角点在轮廓里的**出现顺序**排出来，相邻两点之间的那一段就是一条边 ——
      // 直接按 0→1→2→3 走会把「左边+底边+右边」当成顶边，实测直边纸因此被量出 18% 的假弯曲。
      val order = (0 until 4).sortedBy { at[it] }
      for (m in 0 until 4) {
        val from = at[order[m]]
        val to = at[order[(m + 1) % 4]]
        val side = when (setOf(order[m], order[(m + 1) % 4])) {
          setOf(0, 1) -> 0 // 左上↔右上
          setOf(1, 2) -> 1 // 右上↔右下
          setOf(2, 3) -> 2 // 右下↔左下
          else -> 3        // 左下↔左上
        }
        var i = from
        while (true) {
          val p = pts[i]
          val col = Math.round(p.x).toInt().coerceIn(0, sw - 1)
          val row = Math.round(p.y).toInt().coerceIn(0, sh - 1)
          when (side) {
            0 -> top[col] = deeper(top[col], p.y)
            1 -> right[row] = deeper(right[row], (sw - 1) - p.x)
            2 -> bottom[col] = deeper(bottom[col], (sh - 1) - p.y)
            else -> left[row] = deeper(left[row], p.x)
          }
          if (i == to) break
          i = (i + 1) % n
        }
      }
      if (System.getenv("SURFACE_DEBUG") != null) {
        println(
          "    [measure] n=$n 角点顺序=${order.joinToString()} 原始极值 上=${rawRange(top)} 下=${rawRange(bottom)} " +
            "左=${rawRange(left)} 右=${rawRange(right)}"
        )
      }
      return Boundary(sw, sh, clean(top, sw), clean(bottom, sw), clean(left, sh), clean(right, sh))
    } finally {
      small.release()
      contour.release()
    }
  }

  /**
   * 「这条边在这一列/行上往里缩了多少」—— 取更靠内的值。
   *
   * 不能用 max()：kotlin.math.max 走 java.lang.Math.max，**任一侧是 NaN 就返回 NaN**，
   * 于是「还没量到」的格子永远量不到东西（实测四条边全 NaN，弯度恒为 0）。
   */
  private fun deeper(cur: Double, v: Double): Double = if (cur.isNaN()) v else max(cur, v)

  private fun rawRange(a: DoubleArray): String {
    var lo = Double.MAX_VALUE
    var hi = -Double.MAX_VALUE
    var n = 0
    for (v in a) if (!v.isNaN()) {
      n++
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    return if (n == 0) "-" else "%.0f..%.0f".format(lo, hi)
  }

  /**
   * NaN（这一列/行根本没有轮廓点）→ 线性补齐 → 平滑 → 限幅。
   *
   * 两件事是踩过坑才知道的：
   *  1. **负值一律当 0**：纸伸出画面之外（四角框比纸大）时，那条边在矫正图里根本看不见，
   *     量到的「-150px」是裁切不是弯曲，拿它去展开等于把桌面拉进纸里；
   *  2. **不减均值**：位移场要用的恰恰是「这条边往里缩了多少」这个绝对量 ——
   *     减掉均值之后，目标顶行采到的是画面顶行（也就是桌面），弯边原样留在成品里。
   *     实测就是这样「展开了但一点没直」。
   */
  private fun clean(raw: DoubleArray, side: Int): DoubleArray {
    val filled = interpolateGaps(raw)
    val smoothed = movingAverage(filled, max(3, (filled.size * SMOOTH_RATIO).toInt() or 1))
    val limit = side * MAX_DEVIATION_RATIO
    return DoubleArray(smoothed.size) { smoothed[it].coerceIn(0.0, limit) }
  }

  private fun interpolateGaps(src: DoubleArray): DoubleArray {
    val out = src.copyOf()
    var i = 0
    while (i < out.size) {
      if (out[i].isNaN()) {
        var j = i
        while (j < out.size && out[j].isNaN()) j++
        val before = if (i > 0 && !src[i - 1].isNaN()) src[i - 1] else if (j < out.size) src[j] else 0.0
        val after = if (j < out.size && !src[j].isNaN()) src[j] else before
        val span = max(1, j - i + 1)
        for (k in i until j) out[k] = before + (after - before) * (k - i + 1) / (span + 1)
        i = j
      } else i++
    }
    return out
  }

  private fun movingAverage(src: DoubleArray, window: Int): DoubleArray {
    if (src.isEmpty()) return src
    val half = max(1, window / 2)
    val out = DoubleArray(src.size)
    for (i in src.indices) {
      var sum = 0.0
      var n = 0
      var k = i - half
      while (k <= i + half) {
        if (k >= 0 && k < src.size) {
          sum += src[k]; n++
        }
        k++
      }
      out[i] = if (n > 0) sum / n else src[i]
    }
    return out
  }

  /**
   * 纸的轮廓（矫正图坐标系，像素）。量不到一张「像纸那么大」的区域时返回 null。
   *
   * 掩膜 = 低饱和 + 够亮（白纸），闭运算补上笔画留下的缝，取外轮廓里最大的那块。
   * 不用凸包 —— 凸包正好会把「弓起来的边」抹平成直线，而那正是要量的东西。
   */
  private fun paperContour(bgr: Mat): MatOfPoint? {
    val hsv = Mat()
    val mask = Mat()
    val contours = ArrayList<MatOfPoint>()
    val hierarchy = Mat()
    try {
      // 光照归一化后再二值化：直接卡「V ≥ 90」在侧光下会把纸的一半当成桌面
      // （实测「四边全弯 + 侧光 + 噪声」场景整条掩膜碎成斑马纹，量不到边界）。
      // 纸/桌的**比值**才是不随光照变的量：gray ÷ 低频光照 ≈ 常数。
      val gray = Mat()
      val low = Mat()
      val gf = Mat()
      val lf = Mat()
      val flat = Mat()
      val sat = Mat()
      Imgproc.cvtColor(bgr, gray, Imgproc.COLOR_BGR2GRAY)
      // 低频光照图：先缩到 48×48 再模糊，最后放大回来。
      // 直接在 900px 上做大 sigma 的高斯核要几秒（sigma=112 时核宽 ~450，实测一次 1.4s）——
      // 而光照本来就是极低频的，48×48 足够。
      val tiny = Mat()
      Imgproc.resize(gray, tiny, Size(48.0, 48.0), 0.0, 0.0, Imgproc.INTER_AREA)
      Imgproc.GaussianBlur(tiny, tiny, Size(0.0, 0.0), 5.0)
      Imgproc.resize(tiny, low, Size(bgr.cols().toDouble(), bgr.rows().toDouble()), 0.0, 0.0, Imgproc.INTER_LINEAR)
      tiny.release()
      gray.convertTo(gf, CvType.CV_32FC1)
      low.convertTo(lf, CvType.CV_32FC1)
      Core.divide(gf, lf, flat)
      flat.convertTo(mask, CvType.CV_8UC1, 128.0)
      Imgproc.threshold(mask, mask, 0.0, 255.0, Imgproc.THRESH_BINARY + Imgproc.THRESH_OTSU)
      // 饱和度这一关还是要：白纸配浅色桌面时，比值图分不开，但桌面通常是暖色的
      Imgproc.cvtColor(bgr, hsv, Imgproc.COLOR_BGR2HSV)
      val planes = ArrayList<Mat>()
      Core.split(hsv, planes)
      Core.inRange(planes[1], Scalar(0.0), Scalar(140.0), sat)
      planes.forEach { it.release() }
      Core.bitwise_and(mask, sat, mask)
      val k = Imgproc.getStructuringElement(
        Imgproc.MORPH_ELLIPSE, Size(max(5.0, bgr.cols() / 120.0), max(5.0, bgr.rows() / 120.0))
      )
      Imgproc.morphologyEx(mask, mask, Imgproc.MORPH_CLOSE, k)
      k.release()
      gray.release(); low.release(); gf.release(); lf.release(); flat.release(); sat.release()
      Imgproc.findContours(mask, contours, hierarchy, Imgproc.RETR_EXTERNAL, Imgproc.CHAIN_APPROX_NONE)
      val best = contours.maxByOrNull { Imgproc.contourArea(it) } ?: return null
      val area = Imgproc.contourArea(best)
      // sanity：纸应该占这张矫正图的绝大部分，否则「边界」量的是别的东西
      if (area < 0.5 * bgr.cols() * bgr.rows()) return null
      return MatOfPoint(*best.toArray())
    } finally {
      hsv.release(); mask.release(); hierarchy.release()
      contours.forEach { it.release() }
    }
  }
}
