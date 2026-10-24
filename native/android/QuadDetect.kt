package com.tapscanner.app

import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfInt
import org.opencv.core.MatOfPoint
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Rect
import org.opencv.core.Scalar
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
 * ## 为什么重写成双路（v0.1.4，真机「不裁切」换来的）
 *
 * 旧版只有一条「Canny 边缘 → 直接 findContours」的路，三个致命问题：
 *   1. findContours 跑在**细线**上，拿到的是「线的轮廓」而不是「纸的区域」；
 *      边缘一有缺口就漏成整幅，再叠上 isContourConvex 对细线的判定，
 *      真实照片基本全被拒 → 掉回退框 → 用户看到的正是「不会自动裁切」。
 *   2. Canny 阈值取 0.67·med / 1.33·med：med 量的是**亮度**不是**对比度**。
 *      室内亮图（med≈200）会得到 134/255，白纸配浅桌这种低对比场景一个边缘都检不出。
 *   3. 完全没有「亮区」这条腿，而室内俯拍里纸几乎总是比桌面亮。
 *
 * 验证台（tools/verify）实测出的第二件事：**Otsu 在「白纸 + 浅灰桌」上同样是坏的**。
 * 满幅两团亮值（桌面 205 / 纸 242）外加一堆深色笔画，Otsu 把阈值甩到 171，
 * 于是掩膜 = 整幅（面积占比 1.00），被「等于没裁」的门槛拒掉 → 照样掉回退框。
 * 所以亮区这条腿改用**上半区直方图再二分**（brightSplitLevel）：
 * 先把不高于中位数的像素（字、桌纹、阴影）整个扔掉，只在剩下的亮部里找那道谷。
 * 205/242 这种 37 级的差，二分完落在 223 —— 一刀切开。
 *
 * 边缘这条腿把阈值挂到**梯度幅度的分位数**上（量的才是对比度），
 * 再用大核闭运算把「纸边 + 密集字线」连成一整块，取外轮廓 → 凸包。
 * 分位数要扫三个（p90/p95/p99）：满页文字时最高的那撮梯度是笔画，纸边在它们下面，
 * 只取 p99 的话这条路整条空转（实测闭前边缘占比 0.00）。
 *
 * 两条路的候选统一过：面积 → 凸包 → 多边形拟合 → 四边形校验 → 包围盒不许顶满画面
 * → **边界支撑**（四条边取样带内梯度 p90 要显著高于全图中位梯度）。
 * 最后这一关是拿来毙掉「阈值扫出来的漂亮但根本不存在的方块」。
 *
 * 还有一条反向的规矩：**纸真的铺满画面时不要裁**。这时区域腿会报 fillsFrame，
 * 直接返回整页 —— 让边缘腿去「收紧」的话，它会从字里行间挑一个方块，把真页切掉 20%。
 *
 * ## 两条硬规矩（没变）
 *   1. **一定要返回四角**：真检不到就退最小外接矩形，再退 3% 内缩框，用户永远能自己拖。
 *   2. **如实报出用了哪条路**（source）+ 面积占比：界面上能看到，
 *      真机再出问题一张截图就知道是哪条腿断了，不用靠猜。
 *
 * 输入是降采样图（分析尺寸），输出归一化 0..1；调用方按全分辨率还原。
 */
object QuadDetect {
  /** 面积至少占画面这么多才算「这是一张纸」 */
  private const val MIN_AREA_RATIO = 0.12

  /** 超过这个占比说明纸基本铺满画面：切边没有收益，不如诚实地按整页处理 */
  private const val FULL_FRAME_RATIO = 0.985

  /** 包围盒在两个方向上都顶到画面边的这个比例 → 区域是被画面切出来的，不是纸 */
  private const val SPANS_FRAME_RATIO = 0.97

  /** 四角允许的角度区间（纸张透视后可以是相当斜的四边形） */
  private const val MIN_ANGLE_DEG = 45.0
  private const val MAX_ANGLE_DEG = 135.0

  /** 最短边不能小于图长的 8%，否则是细长误检（桌沿、书脊） */
  private const val MIN_EDGE_RATIO = 0.08

  /** 兜底内缩框 */
  private const val FALLBACK_INSET_RATIO = 0.03

  /** 精化后角点重合的判定阈值（占图长比例） */
  private const val DEGENERATE_RATIO = 1e-3

  /** 多边形拟合容差（占周长比例） */
  private const val APPROX_EPS = 0.02

  /**
   * 边界支撑门槛：四条边取样带内梯度 p90 至少要达到全图中位梯度的这个倍数。
   *
   * 实测：真纸边（含最弱的白纸/浅灰桌 37 级差）是中位数的 7~60 倍，
   * 空气方块是 1 倍。2 倍是很宽的口子，只求毙掉后者。
   */
  internal const val MIN_EDGE_SUPPORT = 2.0

  /** 路的来源，用于诊断显示 */
  const val SRC_BRIGHT = "bright"
  const val SRC_DARK = "dark"
  const val SRC_EDGE = "edge"
  const val SRC_RECT = "rect"
  const val SRC_FULL = "full"
  const val SRC_INSET = "inset"

  data class Result(
    /** 归一化四角，顺序固定 左上→右上→右下→左下 */
    val points: List<Point>,
    /** true = 真检测到了纸边；false = 走了回退框 */
    val detected: Boolean,
    /** 0..1，面积占比与角度规整度的综合 */
    val confidence: Double,
    /** 用了哪条路：bright / dark / edge / full / rect / inset */
    val source: String,
    /** 检出四边形占画面面积比（诊断用） */
    val areaRatio: Double,
    val elapsedMs: Long
  ) {
    /** 拍平给 RN bridge：[x0,y0,x1,y1,...] 归一化 */
    fun flat(): List<Double> = points.flatMap { listOf(it.x, it.y) }
  }

  /** 候选四边形（像素坐标）+ 打分 */
  private data class Candidate(val quad: List<Point>, val score: Double, val source: String)

  /**
   * @param gray  已算好的灰度图（复用调用方的，别重复 cvtColor）
   * @param light 实时取景档位：跳过亚像素精化，预览帧只要求跟手
   */
  fun detect(bgr: Mat, gray: Mat, light: Boolean = false): Result {
    val started = System.currentTimeMillis()
    val w = bgr.cols().toDouble()
    val h = bgr.rows().toDouble()
    if (w <= 0 || h <= 0 || gray.empty()) {
      return Result(insetQuadNormalized(), false, 0.0, SRC_INSET, 0.87, 0L)
    }
    val imgArea = w * h

    // 两张模糊 + 一张梯度图各算一次，两条路和「边界支撑」这一关共用
    val regionBlur = Mat()
    val edgeBlur = Mat()
    val mag = Mat()
    val candidates = ArrayList<Candidate>()
    val magHist: LongArray
    // 门槛 = 全图中位梯度的若干倍（+1 防除零）：空气方块踩在平坦处，支撑≈中位数
    // 两条腿和两个回退共用同一个门槛，所以提到外面
    var gate = 0.0
    try {
      Imgproc.GaussianBlur(gray, regionBlur, Size(0.0, 0.0), 5.0)
      Imgproc.GaussianBlur(gray, edgeBlur, Size(5.0, 5.0), 1.5)
      gradientMagnitude(edgeBlur, mag)
      magHist = Histogram.of(mag)
      gate = MIN_EDGE_SUPPORT * (Histogram.percentile(magHist, 0.5) + 1)
      // 区域腿只负责产候选；「要不要裁」交给打分与闸门判断
      collectRegionCandidates(regionBlur, mag, magHist, w, h, imgArea, gate, candidates)
      // 纸快铺满画面时不再让边缘腿去「收紧」：那条路上找到的是字里行间的方块，
      // 实测会把真实纸页切掉 20%（验证台「纸基本铺满画面」场景）。整页才是正解。
      collectEdgeCandidates(edgeBlur, mag, magHist, w, h, imgArea, gate, light, candidates)
    } finally {
      regionBlur.release()
      edgeBlur.release()
      mag.release()
    }

    val best = pickBest(candidates)
    if (best != null) {
      val refined = if (light) best.quad else (refine(gray, best.quad, w, h) ?: best.quad)
      val ordered = orderCorners(refined)
      return Result(
        points = normalized(ordered, w, h),
        detected = true,
        confidence = confidenceOf(ordered, imgArea),
        source = best.source,
        areaRatio = quadArea(ordered) / imgArea,
        elapsedMs = System.currentTimeMillis() - started
      )
    }

    // 回退 1：亮区掩膜最大区域的最小外接矩形（纸被压斜、边缘断成弧时仍然能用）
    val rectQuad = biggestRegionRect(regionBlur, mag, w, h, imgArea, gate)
    if (rectQuad != null) {
      val ordered = orderCorners(rectQuad)
      return Result(
        points = normalized(ordered, w, h),
        detected = true,
        confidence = 0.3,
        source = SRC_RECT,
        areaRatio = quadArea(ordered) / imgArea,
        elapsedMs = System.currentTimeMillis() - started
      )
    }

    // 回退 2：3% 内缩框 —— 绝不空手而归
    val inset = insetQuadNormalized()
    return Result(
      points = inset,
      detected = false,
      confidence = 0.0,
      source = SRC_INSET,
      areaRatio = quadArea(inset),
      elapsedMs = System.currentTimeMillis() - started
    )
  }

  /**
   * 两条腿之间选谁。
   *
   * 区域腿 = 闭合的亮/暗区域（纸本身），边缘腿 = 闭合的边缘环（兜底）。
   * 两者都过了支撑闸门、而边缘腿的分数略高时，仍应信区域腿 ——
   * 因为边缘环在「纸有一边贴着画面边」时会退化成贴着画面边的矩形（四条边全是 90°、对边等长，
   * 角度与平衡双满分），实测会把纸切掉 8%~12%。只有当区域腿没给出面积相当的结果时才用边缘腿。
   */
  private fun pickBest(candidates: List<Candidate>): Candidate? {
    if (candidates.isEmpty()) return null
    val overall = candidates.maxByOrNull { it.score } ?: return null
    if (overall.source != SRC_EDGE) return overall
    val region = candidates
      .filter { it.source == SRC_BRIGHT || it.source == SRC_DARK }
      .filter { quadArea(it.quad) >= quadArea(overall.quad) * 0.92 }
      .maxByOrNull { it.score }
    return region ?: overall
  }

  // ---------- 路 A：区域分割（亮纸 + 暗纸两种极性） ----------

  /**
   * 「把和桌面不同明度的那一团抠出来」就是纸。
   *
   * 两个阈值 × 两种极性一共四张掩膜，谁合格听打分的：
   *  - 上半区二分（[brightSplitLevel]）：白纸配浅桌的救命阈值。整幅 Otsu 在这种图上
   *    会被深色笔画拽到 171，纸和桌面一起进掩膜 → 等于没裁（验证台实测）。
   *  - 整幅 Otsu：深色封面/灰纸配浅桌 —— 纸在暗的那一侧，上半区二分根本看不到它。
   *  - 正向取亮团、反向取暗团：同一阈值下两种归属都试，反方向那份在白纸场景里
   *    只会得到「贴着画面边的桌面环」，被下面的「等于没裁」和包围盒两道判定自然滤掉。
   *
   * 四张掩膜的代价在这条路上是划算的：一次阈值 + 开闭 + 找轮廓，分析图上不到 10ms。
   */
  private fun collectRegionCandidates(
    regionBlur: Mat,
    mag: Mat,
    magHist: LongArray,
    w: Double,
    h: Double,
    imgArea: Double,
    gate: Double,
    out: ArrayList<Candidate>
  ) {
    val hist = Histogram.of(regionBlur)
    val scratch = Mat()
    val levels = intArrayOf(
      Imgproc.threshold(regionBlur, scratch, 0.0, 255.0, Imgproc.THRESH_BINARY + Imgproc.THRESH_OTSU).toInt(),
      brightSplitLevel(hist)
    )
    scratch.release()
    for (level in levels) {
      if (level <= 1 || level >= 254) continue
      collectOneRegionMask(
        regionBlur, level, Imgproc.THRESH_BINARY, SRC_BRIGHT, mag, magHist, w, h, imgArea, gate, out
      )
      collectOneRegionMask(
        regionBlur, level, Imgproc.THRESH_BINARY_INV, SRC_DARK, mag, magHist, w, h, imgArea, gate, out
      )
    }
  }

  private fun collectOneRegionMask(
    regionBlur: Mat,
    level: Int,
    flag: Int,
    source: String,
    mag: Mat,
    magHist: LongArray,
    w: Double,
    h: Double,
    imgArea: Double,
    gate: Double,
    out: ArrayList<Candidate>
  ) {
    val mask = Mat()
    val contours = ArrayList<MatOfPoint>()
    val hierarchy = Mat()
    try {
      Imgproc.threshold(regionBlur, mask, level.toDouble(), 255.0, flag)
      val ratio = Core.countNonZero(mask).toDouble() / imgArea
      // 掩膜几乎铺满（纸真的铺满，或阈值没切开）或几乎没有 → 这份不可信
      if (ratio < 0.06 || ratio > 0.985) return
      cleanMask(mask)
      fillHoles(mask)
      Imgproc.findContours(mask, contours, hierarchy, Imgproc.RETR_EXTERNAL, Imgproc.CHAIN_APPROX_SIMPLE)
      addQuadCandidates(contours, w, h, imgArea, source, mag, magHist, gate, out)
    } finally {
      mask.release()
      hierarchy.release()
      contours.forEach { it.release() }
    }
  }

  /**
   * 上半区二分阈值：先扔掉不高于中位数的像素，再在剩下的亮部里找类间方差最大的那道谷。
   *
   * 返回的是灰阶值。中位数以下不参与，是因为纸扫描里「暗的东西」永远不是纸本体
   * （字、桌纹、阴影），让它们参与 Otsu 只会把阈值拽到深色一侧。
   */
  internal fun brightSplitLevel(hist: LongArray): Int {
    val total = hist.sum()
    if (total <= 0L) return 128
    val half = total / 2
    var acc = 0L
    var lo = 0
    while (lo < 255 && acc + hist[lo] < half) {
      acc += hist[lo]
      lo += 1
    }
    val hi = 255
    if (hi - lo < 2) return lo + 1

    // 在 [lo, hi] 上做标准 Otsu（类间方差最大）
    var sumAll = 0.0
    var sumWeightedAll = 0.0
    for (v in lo..hi) {
      sumAll += hist[v]
      sumWeightedAll += hist[v] * v
    }
    var bestLevel = lo + 1
    var bestVariance = -1.0
    var w0 = 0.0
    var sum0 = 0.0
    for (v in lo..hi) {
      w0 += hist[v]
      sum0 += hist[v] * v
      val w1 = sumAll - w0
      if (w0 <= 0.0 || w1 <= 0.0) continue
      val mean0 = sum0 / w0
      val mean1 = (sumWeightedAll - sum0) / w1
      val variance = w0 * w1 * (mean0 - mean1) * (mean0 - mean1)
      if (variance > bestVariance) {
        bestVariance = variance
        bestLevel = v
      }
    }
    return bestLevel.coerceIn(1, 254)
  }

  // ---------- 路 B：梯度边缘 + 闭运算 ----------

  /**
   * 低对比/深色纸场景靠边界而不是亮暗。
   *
   * 阈值挂在梯度幅度的分位数上（量的才是对比度；旧版挂在亮度中位数上，
   * 本质是拿「房间多亮」当「边界多强」，白纸浅桌必挂）。
   * 闭运算用短边 1/12 的大核：把断掉的纸边接上，同时把密集的字线糊成一整块 ——
   * 之后 findContours 的外轮廓面积就是「纸这块区域」，而不是细线的面积。
   *
   * 为什么要扫三个分位数而不是取一个：满页文字的图里，最高的那一撮梯度是**笔画**，
   * 纸边比笔画低（实测 p99 被笔画顶到 384，纸边只有 150 → 只取 p99 时闭前边缘占比 0.00，
   * 这条路直接空转）。所以 0.90/0.95/0.99 都跑一遍，候选交给打分和边界支撑去挑。
   * 三次 Canny+闭运算是这条路的成本，只在按快门后跑（light 档只取中间那个）。
   */
  private fun collectEdgeCandidates(
    edgeBlur: Mat,
    mag: Mat,
    magHist: LongArray,
    w: Double,
    h: Double,
    imgArea: Double,
    gate: Double,
    light: Boolean,
    out: ArrayList<Candidate>
  ) {
    val edges = Mat()
    val contours = ArrayList<MatOfPoint>()
    val hierarchy = Mat()
    var closeKernel: Mat? = null
    try {
      val quantiles = if (light) doubleArrayOf(0.95) else doubleArrayOf(0.90, 0.95, 0.99)
      val k = Metrics.oddAtLeast(min(edgeBlur.cols(), edgeBlur.rows()) / 12, 9)
      closeKernel = Imgproc.getStructuringElement(Imgproc.MORPH_RECT, Size(k.toDouble(), k.toDouble()))

      for (q in quantiles) {
        // mag 存的是 真梯度/8（见 gradientMagnitude），换算回 Canny 的量纲要乘 8
        val lower = (Histogram.percentile(magHist, q) * 8.0).coerceIn(12.0, 400.0)
        val upper = max(Histogram.percentile(magHist, min(q + 0.005, 0.999)) * 8.0, lower + 25.0)
          .coerceAtMost(800.0)
        Imgproc.Canny(edgeBlur, edges, lower, upper, 3, true)
        Imgproc.morphologyEx(
          edges, edges, Imgproc.MORPH_CLOSE, closeKernel!!, Point(-1.0, -1.0), 2
        )
        contours.forEach { it.release() }
        contours.clear()
        Imgproc.findContours(edges, contours, hierarchy, Imgproc.RETR_EXTERNAL, Imgproc.CHAIN_APPROX_SIMPLE)
        if (contours.isEmpty()) continue
        addQuadCandidates(contours, w, h, imgArea, SRC_EDGE, mag, magHist, gate, out)
      }
    } finally {
      edges.release()
      hierarchy.release()
      closeKernel?.release()
      contours.forEach { it.release() }
    }
  }

  /**
   * 梯度幅度图（8U，饱和）。
   *
   * 存的是 L2 梯度 / 8：Sobel(3) 在 8U 图上最大约 4·255·√2 ≈ 1442，除以 8 刚好落回 8U 不截顶。
   * 阈值和「边界支撑」都从这张图取分位数，再乘回 8 换算成 Canny 的量纲。
   */
  internal fun gradientMagnitude(blur: Mat, out: Mat) {
    val gx = Mat()
    val gy = Mat()
    val gxf = Mat()
    val gyf = Mat()
    val m = Mat()
    try {
      Imgproc.Sobel(blur, gx, CvType.CV_16S, 1, 0, 3)
      Imgproc.Sobel(blur, gy, CvType.CV_16S, 0, 1, 3)
      gx.convertTo(gxf, CvType.CV_32F)
      gy.convertTo(gyf, CvType.CV_32F)
      Core.magnitude(gxf, gyf, m)
      m.convertTo(out, CvType.CV_8U, 1.0 / 8.0)
    } finally {
      gx.release()
      gy.release()
      gxf.release()
      gyf.release()
      m.release()
    }
  }

  // ---------- 公共：轮廓 → 四边形 → 校验 → 打分 ----------

  private fun addQuadCandidates(
    contours: List<MatOfPoint>,
    w: Double,
    h: Double,
    imgArea: Double,
    source: String,
    mag: Mat,
    magHist: LongArray,
    gate: Double,
    out: ArrayList<Candidate>
  ) {
    val ranked = contours
      .map { it to Imgproc.contourArea(it) }
      .filter { it.second > imgArea * MIN_AREA_RATIO }
      .sortedByDescending { it.second }
      .take(4)
    for ((contour, area) in ranked) {
      val ratio = area / imgArea
      // 只有「几乎就是整幅画面」才算真的没得裁（0.985 以上）
      if (ratio > FULL_FRAME_RATIO) continue
      val quad = quadFrom(contour, w, h) ?: continue
      // 边缘腿的候选如果四边都顶到画面边，那是「被画面切断的区域」而不是纸
      // （区域腿不能套这条：近拍 A4 的纸本身就贴着画面边，那正是要裁的地方）
      if (source == SRC_EDGE && spansFrame(quad, w, h)) continue
      // 最后一道：这个方块的边上到底有没有真实边界
      // 支撑只做闸门、不参与排名：它分不清「纸边」和「密集文字边」（文字边的支撑更高），
      // 拿它排名会把一簇字当成纸（实测低对比场景直接掉到 IoU 0.62）。
      val support = edgeSupport(mag, quad, w.toInt(), h.toInt())
      if (support < gate) continue
      out.add(Candidate(quad, scoreQuad(quad, ratio, w, h), source))
    }
  }

  /** 包围盒几乎等于整幅画面 → 这块区域是被画面边界切出来的，不是纸边 */
  internal fun spansFrame(quad: List<Point>, w: Double, h: Double): Boolean {
    if (quad.size != 4) return false
    val xs = quad.map { it.x }
    val ys = quad.map { it.y }
    val spanW = (requireNotNull(xs.max()) - requireNotNull(xs.min())) / w
    val spanH = (requireNotNull(ys.max()) - requireNotNull(ys.min())) / h
    return spanW >= SPANS_FRAME_RATIO && spanH >= SPANS_FRAME_RATIO
  }

  /**
   * 边界支撑 = 四边形四条边取样带内梯度的 p90。
   *
   * 拿它和全图中位梯度比：真纸边的支撑是中位数的几十倍，
   * 而阈值扫出来的「空气方块」四条边踩在平坦桌面上，支撑≈中位数。
   *
   * 为什么用 p90 而不是平均值（第一版用平均，把低对比的真纸毙了）：
   * 取样带 3~5px 宽，真实边界只占其中 1~2px，平均值被带内的平坦像素摊平 ——
   * 白纸浅桌那种 37 级的弱边摊完只剩 3，而门槛算出来是 6，正好卡在真纸身上。
   */
  internal fun edgeSupport(mag: Mat, quad: List<Point>, w: Int, h: Int): Double {
    if (quad.size != 4 || mag.empty() || mag.type() != CvType.CV_8UC1) return 0.0
    val ring = Mat.zeros(h, w, CvType.CV_8UC1)
    val pts = MatOfPoint(*quad.map { Point(it.x.toLong().toDouble(), it.y.toLong().toDouble()) }.toTypedArray())
    try {
      Imgproc.drawContours(ring, listOf(pts), -1, Scalar(255.0), borderThickness(h))
      val hist = LongArray(256)
      val magRow = ByteArray(w)
      val ringRow = ByteArray(w)
      for (y in 0 until h) {
        mag.get(y, 0, magRow)
        ring.get(y, 0, ringRow)
        for (x in 0 until w) {
          if (ringRow[x].toInt() != 0) hist[magRow[x].toInt() and 0xFF] += 1L
        }
      }
      return Histogram.percentile(hist, 0.90).toDouble()
    } finally {
      ring.release()
      pts.release()
    }
  }

  /** 边界取样带的宽度：太窄会被抗锯齿抖掉，太宽就摊平了真实梯度 */
  private fun borderThickness(h: Int): Int = max(3, h / 120)

  /** 多边形拟合 + 四边形校验；不合格返回 null，交给下一个候选 */
  /**
   * 多边形拟合 + 四边形校验；不合格返回 null，交给下一个候选。
   *
   * internal 不是给自己人用的 —— 是**只**给 tools/verify 开的缝：
   * 验证台和这些源码在同一次 kotlinc 调用里编译（同一个模块），所以能直接调真函数，
   * 失败时打印的是这道闸门的真实输出，而不是在测试里复刻一份「大概一样」的逻辑。
   */
  internal fun quadFrom(contour: MatOfPoint, w: Double, h: Double): List<Point>? {
    val pts = contour.toArray()
    if (pts.size < 4) return null
    val hullPoints = MatOfPoint2f()
    val approx = MatOfPoint2f()
    return try {
      // 先取凸包再拟合：实心区域常被桌面纹理啃出凹陷，直接在凹陷轮廓上 approxPolyDP
      // 会得到 5~8 个角，然后被下面的 size != 4 全部拒掉（旧版正是这样把真纸拒光的）
      val hullIdx = MatOfInt()
      try {
        // convexHull 的 Java 绑定只收 MatOfPoint（CV_32SC2）；返回的索引就是 pts 的下标
        Imgproc.convexHull(contour, hullIdx)
        val idx = hullIdx.toArray()
        if (idx.isEmpty()) return null
        hullPoints.fromArray(*Array(idx.size) { i -> pts[idx[i]] })
      } finally {
        hullIdx.release()
      }
      val perimeter = Imgproc.arcLength(hullPoints, true)
      if (perimeter <= 0) return null
      Imgproc.approxPolyDP(hullPoints, approx, APPROX_EPS * perimeter, true)
      val corners = approx.toArray()
      if (corners.size != 4) return null
      if (Imgproc.contourArea(approx) < w * h * MIN_AREA_RATIO) return null

      val list = corners.toList()
      val maxDim = max(w, h)
      val edges4 = listOf(
        distance(list[0], list[1]), distance(list[1], list[2]),
        distance(list[2], list[3]), distance(list[3], list[0])
      )
      if (edges4.min() < maxDim * MIN_EDGE_RATIO) return null

      for (i in list.indices) {
        val angle = angleDeg(list[(i + 3) % 4], list[i], list[(i + 1) % 4])
        if (angle < MIN_ANGLE_DEG || angle > MAX_ANGLE_DEG) return null
      }
      list
    } finally {
      hullPoints.release()
      approx.release()
    }
  }

  /**
   * 打分：面积占比落在 0.2~0.85 最好（太小是误检，太接近 1 说明等于没裁），
   * 角度越接近直角越好，对边越等长越好（纸是矩形）。
   */
  /**
   * 候选打分。
   *
   * `support` 这一项是这次近拍 A4 事故的直接解药：边缘腿经常产出一个「四边贴着画面边、
   * 四条边全是 90°」的漂亮矩形（因为它是被画面切出来的区域），角度与对边平衡都满分；
   * 而它的支撑很低（贴着画面边的地方没有梯度）。真纸边的支撑通常是它的几倍。
   * 不把支撑算进分数，就会在「纸大 + 有一边靠画面边」时输给这个假矩形 ——
   * 表现为「只裁了一部分 / 右边少一条」。
   */
  internal fun scoreQuad(quad: List<Point>, areaRatio: Double, w: Double, h: Double): Double {
    // 0.85 以上不再扣分：手机拍 A4 本来就该占画面 85%~97%，
    // 旧公式从 0.85 就开始惩罚「太大」，结果主动选了更小的框 —— 等于替用户把纸切掉一圈。
    // 你正在扫一张纸：它至少占画面 35% 才接近满分（20% 的小纸也够用，只是分低些）。
    // 0.9~0.97 是「近拍 A4」的正确区间，不扣分；再往上才是「等于没裁」。
    val areaScore = when {
      areaRatio >= 0.97 -> (1.0 - (areaRatio - 0.97) / 0.03 * 0.6).coerceIn(0.4, 1.0)
      areaRatio >= 0.9 -> 1.0
      areaRatio >= 0.35 -> 0.95 + (areaRatio - 0.35) / 0.55 * 0.05
      areaRatio >= 0.12 -> 0.45 + (areaRatio - 0.12) / 0.23 * 0.5
      else -> (areaRatio / 0.12) * 0.45
    }
    var deviation = 0.0
    for (i in quad.indices) {
      deviation += abs(angleDeg(quad[(i + 3) % 4], quad[i], quad[(i + 1) % 4]) - 90.0)
    }
    val angleScore = 1.0 - (deviation / 4.0 / 45.0).coerceIn(0.0, 1.0)
    val ordered = orderCorners(quad)
    val top = distance(ordered[0], ordered[1])
    val bottom = distance(ordered[3], ordered[2])
    val left = distance(ordered[0], ordered[3])
    val right = distance(ordered[1], ordered[2])
    val balance = (1.0 - abs(top - bottom) / max(top, bottom)).coerceIn(0.0, 1.0) *
      (1.0 - abs(left - right) / max(left, right)).coerceIn(0.0, 1.0)
    return areaScore * 0.45 + angleScore * 0.3 + balance * 0.25
  }

  /** 掩膜清理：开运算去噪点，闭运算接缝隙 */
  internal fun cleanMask(mask: Mat) {
    // 闭运算核要跟「文字行距」同量级：分析图短边 900 时给到 ~23px。
    // 原来固定 9px，满页文字的纸会被啃成梳齿（实测近拍 A4：真值 0.85，拟合只有 0.68）。
    val short = min(mask.cols(), mask.rows())
    val closeK = Metrics.oddAtLeast(short / 40, 9).toDouble()
    val open = Imgproc.getStructuringElement(Imgproc.MORPH_RECT, Size(5.0, 5.0))
    val close = Imgproc.getStructuringElement(Imgproc.MORPH_RECT, Size(closeK, closeK))
    try {
      Imgproc.morphologyEx(mask, mask, Imgproc.MORPH_OPEN, open)
      Imgproc.morphologyEx(mask, mask, Imgproc.MORPH_CLOSE, close)
    } finally {
      open.release()
      close.release()
    }
  }

  /**
   * 填洞：Otsu 会把纸上的深色文字/图片判成背景，洞不填的话轮廓会沿着字迹绕进去，
   * approxPolyDP 就永远凑不出四个角。取外轮廓重画一遍即为填实。
   */
  internal fun fillHoles(mask: Mat) {
    val contours = ArrayList<MatOfPoint>()
    val hierarchy = Mat()
    try {
      Imgproc.findContours(mask, contours, hierarchy, Imgproc.RETR_EXTERNAL, Imgproc.CHAIN_APPROX_SIMPLE)
      if (contours.isEmpty()) return
      mask.setTo(Scalar(0.0))
      Imgproc.drawContours(mask, contours, -1, Scalar(255.0), -1)
    } finally {
      hierarchy.release()
      contours.forEach { it.release() }
    }
  }

  /** 回退 1：亮区掩膜最大区域的最小外接矩形 */
  internal fun biggestRegionRect(
    regionBlur: Mat,
    mag: Mat,
    w: Double,
    h: Double,
    imgArea: Double,
    gate: Double
  ): List<Point>? {
    val mask = Mat()
    val contours = ArrayList<MatOfPoint>()
    val hierarchy = Mat()
    val asFloat = MatOfPoint2f()
    val box = MatOfPoint2f()
    try {
      val level = brightSplitLevel(Histogram.of(regionBlur))
      Imgproc.threshold(regionBlur, mask, level.toDouble(), 255.0, Imgproc.THRESH_BINARY)
      if (Core.countNonZero(mask) <= 0) return null
      cleanMask(mask)
      fillHoles(mask)
      Imgproc.findContours(mask, contours, hierarchy, Imgproc.RETR_EXTERNAL, Imgproc.CHAIN_APPROX_SIMPLE)
      val biggest = contours.maxByOrNull { Imgproc.contourArea(it) } ?: return null
      if (Imgproc.contourArea(biggest) < imgArea * 0.08) return null
      asFloat.fromArray(*biggest.toArray())
      val rect = Imgproc.minAreaRect(asFloat)
      if (rect.size.width * rect.size.height < imgArea * 0.05) return null
      Imgproc.boxPoints(rect, box)
      val pts = box.toArray().toList()
      if (pts.size != 4) return null
      // 回退框也要过边界支撑这一关，否则「整幅桌面」会被当成一张纸
      if (edgeSupport(mag, pts, w.toInt(), h.toInt()) < gate) return null
      return pts
    } finally {
      mask.release()
      hierarchy.release()
      contours.forEach { it.release() }
      asFloat.release()
      box.release()
    }
  }

  // ---------- 几何工具 ----------

  /** 亚像素精化：把角点吸附到真实边缘上，矫正后文字才不会歪 */
  private fun refine(gray: Mat, quad: List<Point>, w: Double, h: Double): List<Point>? {
    if (gray.empty() || quad.size != 4) return null
    val corners = MatOfPoint2f(*quad.toTypedArray())
    return try {
      Imgproc.cornerSubPix(
        gray, corners, Size(5.0, 5.0), Size(-1.0, -1.0),
        TermCriteria(TermCriteria.EPS + TermCriteria.COUNT, 40, 0.05)
      )
      val refined = corners.toArray().toList()
      val insideAll = refined.all { it.x >= 0.0 && it.y >= 0.0 && it.x <= w && it.y <= h }
      val eps = DEGENERATE_RATIO * max(w, h)
      val degenerate = refined.indices.any { i ->
        refined.withIndex().any { (j, pj) -> j != i && distance(pj, refined[i]) < eps }
      }
      if (insideAll && !degenerate) refined else null
    } finally {
      corners.release()
    }
  }

  private fun normalized(quad: List<Point>, w: Double, h: Double): List<Point> =
    quad.map { Point(it.x / w, it.y / h) }

  /** 整幅 = 不裁 */
  private fun fullFrameQuad(): List<Point> =
    listOf(Point(0.0, 0.0), Point(1.0, 0.0), Point(1.0, 1.0), Point(0.0, 1.0))

  private fun insetQuadNormalized(): List<Point> {
    val i = FALLBACK_INSET_RATIO
    return listOf(Point(i, i), Point(1 - i, i), Point(1 - i, 1 - i), Point(i, 1 - i))
  }

  /**
   * 固定成 左上→右上→右下→左下。
   *
   * 用 sum/diff 而不是极角排序：轮廓返回的起点是任意的；顺序一旦错了，
   * 透视变换会把纸翻面 —— 那是最贵的一类 bug，因为「看起来还是一张纸」。
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
      deviation += abs(angleDeg(quad[(i + 3) % 4], quad[i], quad[(i + 1) % 4]) - 90.0)
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
    return Math.toDegrees(atan2(abs(v1x * v2y - v1y * v2x), v1x * v2x + v1y * v2y))
  }

  // ---------- 给 DocPipeline / 验证台复用的几何 ----------

  data class TargetSize(val width: Int, val height: Int)

  /** 四角 → 矫正后的目标尺寸（顺序必须是 TL,TR,BR,BL） */
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

  /** 验证台构造合成图用的矩形 */
  fun rectToQuad(rect: Rect): List<Point> = listOf(
    Point(rect.x.toDouble(), rect.y.toDouble()),
    Point((rect.x + rect.width).toDouble(), rect.y.toDouble()),
    Point((rect.x + rect.width).toDouble(), (rect.y + rect.height).toDouble()),
    Point(rect.x.toDouble(), (rect.y + rect.height).toDouble())
  )
}
