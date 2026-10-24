package com.tapscanner.verify

import com.tapscanner.app.DocPipeline
import com.tapscanner.app.Metrics
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
import java.io.File

/**
 * 真实照片验证台（tools/verify/run.sh 的第二段）。
 *
 * 为什么要有它：QuadDetectVerify 用的是合成图 —— 光照、噪声、纹理都是我自己画的，
 * 可能刚好绕开了真实照片的难点（反光、白纸白桌、纸有一边被画面切掉、印刷品文字贴着纸边）。
 * 这里直接吃 qa-out/photos/ 下的真实照片，把「检测四角」和「透视矫正结果」都画出来，
 * 让人（我）能用眼睛复核，而不是只看一个 IoU 数字。
 *
 * 跑法：把照片丢进 qa-out/photos/ 目录（jpg/png），然后 bash tools/verify/run.sh。
 * 产物：qa-out/photos/out/<name>-overlay.jpg（绿框=检出，黄框=回退）
 *      qa-out/photos/out/<name>-warp.jpg（按检出四角矫正后的成品，未做增强）
 */
private const val ANALYSIS_SIDE = 1200

fun main(args: Array<String>) {
  nu.pattern.OpenCV.loadLocally()
  val root = File(if (args.isNotEmpty()) args[0] else "qa-out/photos")
  val outDir = File(root, "out")
  outDir.mkdirs()
  val photos = root.listFiles { f -> f.isFile && !f.name.startsWith("ref-") && f.extension.lowercase() in setOf("jpg", "jpeg", "png") }
    ?.sortedBy { it.name } ?: emptyList()
  if (photos.isEmpty()) {
    println("没有照片：把真实拍摄的图片放进 ${root.path} 再跑")
    return
  }
  val refFile = File(root, "ref-camscanner.jpg")
  println("%-24s %-8s %-8s %-8s %-8s %s".format("照片", "路", "detected", "面积占比", "置信", "耗时"))
  println("-".repeat(78))
  for (file in photos) {
    val original = Imgcodecs.imread(file.path, Imgcodecs.IMREAD_COLOR)
    if (original.empty()) {
      println("读不出来：${file.name}")
      continue
    }
    val started = System.currentTimeMillis()
    val analysis = resizeTo(original, ANALYSIS_SIDE)
    val gray = Mat()
    Imgproc.cvtColor(analysis, gray, Imgproc.COLOR_BGR2GRAY)
    val result = QuadDetect.detect(analysis, gray, light = false)

    for (row in QuadDetect.debugCandidates(original, gray)) println("   候选 $row")
    // 真实照片的取色探针：纸/桌/键盘各自到底是多少 S/V —— 白纸腿的阈值只能这样定
    run {
      val hsv = Mat()
      Imgproc.cvtColor(original, hsv, Imgproc.COLOR_BGR2HSV)
      val probes = listOf(
        "纸中心" to (0.58 to 0.60), "纸左上" to (0.33 to 0.22), "纸右下" to (0.80 to 0.74),
        "浅木桌" to (0.08 to 0.50), "桌面下方" to (0.42 to 0.95), "白键盘" to (0.22 to 0.86),
        "数据线" to (0.13 to 0.10)
      )
      val line = probes.joinToString("  ") { (name, p) ->
        val px = (p.first * original.cols()).toInt().coerceIn(0, original.cols() - 1)
        val py = (p.second * original.rows()).toInt().coerceIn(0, original.rows() - 1)
        val v = hsv.get(py, px)
        "%s(S=%d V=%d)".format(name, v[1].toInt(), v[2].toInt())
      }
      println("   HSV $line")
      hsv.release()
    }
    println(
      "%-24s %-8s %-8s %-8s %-8s %s".format(
        file.name, result.source, result.detected,
        "%.2f".format(result.areaRatio), "%.2f".format(result.confidence), "${result.elapsedMs}ms"
      )
    )

    // 1) 把四角画在**原图**上（不是分析小图），这样才能看出映射对不对
    val overlay = original.clone()
    val pts = result.points.map { Point(it.x * original.cols(), it.y * original.rows()) }
    drawQuad(overlay, pts, if (result.detected) Scalar(60.0, 200.0, 60.0) else Scalar(0.0, 210.0, 255.0))
    for ((i, p) in pts.withIndex()) {
      Imgproc.circle(overlay, p, 10, Scalar(60.0, 200.0, 60.0), -1)
      Imgproc.putText(
        overlay, "P${i + 1}", Point(p.x + 14, p.y - 8),
        Imgproc.FONT_HERSHEY_SIMPLEX, 0.9, Scalar(60.0, 200.0, 60.0), 2
      )
    }
    Imgcodecs.imwrite(File(outDir, "${file.nameWithoutExtension}-overlay.jpg").path, overlay)
    overlay.release()

    // 1.5) 若存在「竞品效果图」，用特征匹配把它配准回原图，反解出真值四角 ——
    //      这比人工点四个角准，也不需要任何标注工具。
    if (refFile.exists() && file.name == "20261024_093429.jpg") {
      val gt = registerRefQuad(refFile, original)
      if (gt != null) {
        val gtNorm = gt.map { Point(it.x / original.cols(), it.y / original.rows()) }
        println("   GT 四角：" + gtNorm.joinToString(" ") { "(%.2f,%.2f)".format(it.x, it.y) })
        println("   与检出 IoU = %.2f".format(quadIou(result.points, gtNorm)))
        drawQuad(original, gt, Scalar(255.0, 80.0, 40.0))
        Imgcodecs.imwrite(File(outDir, "${file.nameWithoutExtension}-gt.jpg").path, original)
      }
    }

    // 2) 用同一套几何做一次矫正（不增强），看矫正结果是否「只剩纸」
    val quadPixels = QuadDetect.toPixels(result.points, original.cols().toDouble(), original.rows().toDouble())
    val ordered = QuadDetect.orderCorners(quadPixels)
    val target = QuadDetect.targetSize(ordered, 1600)
    val srcTri = org.opencv.core.MatOfPoint2f(*ordered.toTypedArray())
    val dstTri = org.opencv.core.MatOfPoint2f(
      Point(0.0, 0.0),
      Point(target.width.toDouble(), 0.0),
      Point(target.width.toDouble(), target.height.toDouble()),
      Point(0.0, target.height.toDouble())
    )
    val m = Imgproc.getPerspectiveTransform(srcTri, dstTri)
    val warped = Mat()
    Imgproc.warpPerspective(original, warped, m, Size(target.width.toDouble(), target.height.toDouble()))
    Imgcodecs.imwrite(File(outDir, "${file.nameWithoutExtension}-warp.jpg").path, warped)
    println("   → 矫正尺寸 ${target.width}×${target.height}，产物在 ${outDir.path}/")
    warped.release()
    m.release()
    srcTri.release()
    dstTri.release()
    analysis.release()
    gray.release()
    original.release()
    println("   总耗时 ${System.currentTimeMillis() - started}ms")
  }
}

/**
 * 把竞品导出的「已裁切效果图」配准回原照片，反解出纸的四角（真值）。
 * 原理：效果图就是纸面展开后的图，两者有大量可匹配的纹理（表格线/文字）。
 */
private fun registerRefQuad(refFile: File, original: Mat): List<Point>? {
  val ref = Imgcodecs.imread(refFile.path, Imgcodecs.IMREAD_GRAYSCALE)
  if (ref.empty()) return null
  val g1 = Mat(); val g2 = Mat()
  Imgproc.cvtColor(original, g1, Imgproc.COLOR_BGR2GRAY)
  val s = 1200.0 / maxOf(original.cols(), original.rows())
  Imgproc.resize(g1, g2, Size((original.cols().toDouble() * s).toInt().toDouble(), (original.rows().toDouble() * s).toInt().toDouble()))
  val refSmall = Mat()
  Imgproc.resize(ref, refSmall, Size(600.0, (600.0 * ref.rows() / ref.cols()).toInt().toDouble()))
  val orb = org.opencv.features2d.ORB.create(4000)
  val kp1 = org.opencv.core.MatOfKeyPoint(); val d1 = Mat()
  val kp2 = org.opencv.core.MatOfKeyPoint(); val d2 = Mat()
  val m1 = Mat(); val m2 = Mat()
  orb.detectAndCompute(g2, m1, kp1, d1)
  orb.detectAndCompute(refSmall, m2, kp2, d2)
  if (d1.empty() || d2.empty()) return null
  val matcher = org.opencv.features2d.BFMatcher.create(org.opencv.core.Core.NORM_HAMMING, true)
  val matches = org.opencv.core.MatOfDMatch()
  matcher.match(d2, d1, matches) // ref → original
  val sorted = matches.toArray().sortedBy { it.distance }.take(120)
  if (sorted.size < 20) return null
  val refPts = ArrayList<Point>(); val origPts = ArrayList<Point>()
  val kpRef = kp2.toArray(); val kpOrig = kp1.toArray()
  for (m in sorted) {
    refPts.add(kpRef[m.queryIdx].pt)
    val p = kpOrig[m.trainIdx].pt
    origPts.add(Point(p.x / s, p.y / s))
  }
  val h = org.opencv.calib3d.Calib3d.findHomography(
    org.opencv.core.MatOfPoint2f(*refPts.toTypedArray()),
    org.opencv.core.MatOfPoint2f(*origPts.toTypedArray()),
    org.opencv.calib3d.Calib3d.RANSAC, 4.0
  )
  if (h.empty()) return null
  val corners = org.opencv.core.MatOfPoint2f(
    Point(0.0, 0.0), Point(ref.cols().toDouble(), 0.0),
    Point(ref.cols().toDouble(), ref.rows().toDouble()), Point(0.0, ref.rows().toDouble())
  )
  val out = org.opencv.core.MatOfPoint2f()
  Core.perspectiveTransform(corners, out, h)
  return out.toArray().toList()
}

/** 归一化四边形的 IoU（栅格化，够用且不会算错） */
private fun quadIou(a: List<Point>, b: List<Point>): Double {
  val W = 800; val H = 600
  val ma = Mat.zeros(H, W, CvType.CV_8UC1); val mb = Mat.zeros(H, W, CvType.CV_8UC1)
  fun toPx(q: List<Point>) = MatOfPoint(*q.map { Point(it.x * W, it.y * H) }.toTypedArray())
  Imgproc.fillPoly(ma, listOf(toPx(a)), Scalar(255.0))
  Imgproc.fillPoly(mb, listOf(toPx(b)), Scalar(255.0))
  val inter = Mat(); val union = Mat()
  Core.bitwise_and(ma, mb, inter); Core.bitwise_or(ma, mb, union)
  val i = Core.countNonZero(inter).toDouble(); val u = Core.countNonZero(union).toDouble()
  ma.release(); mb.release(); inter.release(); union.release()
  return if (u <= 0.0) 0.0 else i / u
}

/** 与 DocPipeline.toAnalysis 同一条规则：长边缩到 maxSide，INTER_AREA */
private fun resizeTo(src: Mat, maxSide: Int): Mat {
  val longest = maxOf(src.cols(), src.rows()).toDouble()
  if (longest <= maxSide) return src.clone()
  val scale = maxSide / longest
  val out = Mat()
  Imgproc.resize(
    src, out,
    Size(
      Math.max(1.0, Math.round(src.cols() * scale).toDouble()),
      Math.max(1.0, Math.round(src.rows() * scale).toDouble())
    ),
    0.0, 0.0, Imgproc.INTER_AREA
  )
  return out
}

private fun drawQuad(img: Mat, quad: List<Point>, color: Scalar) {
  val poly = MatOfPoint(*quad.toTypedArray())
  Imgproc.polylines(img, listOf(poly), true, color, 6, Imgproc.LINE_AA)
  poly.release()
}
