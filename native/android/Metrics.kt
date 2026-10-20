package com.tapscanner.app

import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfDouble
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc

/**
 * 图像感知 —— 对标扫描全能王「智能高清」的第一层：先看清这张图有什么问题。
 *
 * 刻意只出指标、不出结论：判定表在 src/utils/modeSelection.ts（纯 JS，可被 vitest 覆盖）。
 * 这样阈值调正是产品决策，有单测兜着；原生层只负责量得准。
 *
 * 所有指标都在降采样副本上算（调用方传进来的就是分析用小图），全分辨率只用来出成品。
 * 签名全部按本机 OpenCV 4.13.0 AAR 的 javap 结果写：
 *   Core.meanStdDev(Mat, MatOfDouble, MatOfDouble)、Core.mean(Mat): Scalar、Core.split(Mat, List<Mat>)。
 * （Core 没有 median(Mat)，中位数用直方图取分位数，见 Histogram.percentile）
 */
object Metrics {
  data class Values(
    /** 平均亮度 0..255 */
    val brightness: Double,
    /** 亮度标准差（对比度） */
    val contrast: Double,
    /** 色彩丰富度：HSV 的 S 通道均值 0..255（>60 视为彩色内容） */
    val saturation: Double,
    /** 亮度中位数 0..255：Canny 自适应阈值的基准 */
    val median: Double,
    /** Laplacian 方差：越小越糊（经验分界 ~90） */
    val blurScore: Double,
    /** 背景（光照）动态范围归一：越大说明侧光/阴影越重 */
    val shadowScore: Double,
    /** 高频能量占比：摩尔纹的粗判，只用来决定「要不要开降噪」，不做去纹 */
    val moireScore: Double,
    /** 白场覆盖率：>=235 的像素占比，衡量纸面有多白 */
    val whiteCoverage: Double,
    /** 量化指标，便于 QA 台回放 */
    val elapsedMs: Long
  )

  fun measure(bgr: Mat): Values {
    val started = System.currentTimeMillis()
    val gray = Mat()
    val hsv = Mat()
    val lap = Mat()
    val bg = Mat()
    val highpass = Mat()
    try {
      Imgproc.cvtColor(bgr, gray, Imgproc.COLOR_BGR2GRAY)
      Imgproc.cvtColor(bgr, hsv, Imgproc.COLOR_BGR2HSV)

      val grayHist = Histogram.of(gray)
      val mean = MatOfDouble()
      val std = MatOfDouble()
      Core.meanStdDev(gray, mean, std)
      val brightness = mean.toArray()[0]
      val contrast = std.toArray()[0]
      mean.release()
      std.release()

      val channels = ArrayList<Mat>()
      Core.split(hsv, channels)
      val saturation = if (channels.size > 1) Core.mean(channels[1]).`val`[0] else 0.0
      channels.forEach { it.release() }

      Imgproc.Laplacian(gray, lap, CvType.CV_64F)
      val lapMean = MatOfDouble()
      val lapStd = MatOfDouble()
      Core.meanStdDev(lap, lapMean, lapStd)
      val lapStdDev = lapStd.toArray()[0]
      val blurScore = lapStdDev * lapStdDev
      lapMean.release()
      lapStd.release()

      // 光照不均：把细节抹掉只剩背景，再看背景自身的动态范围。
      // 核尺寸取短边 1/4（分析图上约 300px 级别的低频），保证墨迹被抹平而光照梯度保留。
      val k = oddAtLeast(minOf(gray.cols(), gray.rows()) / 4, 9)
      Imgproc.GaussianBlur(gray, bg, Size(k.toDouble(), k.toDouble()), 0.0)
      val bgHist = Histogram.of(bg)
      val bgHigh = Histogram.percentile(bgHist, 0.95)
      val bgLow = Histogram.percentile(bgHist, 0.08)
      val shadowScore =
        if (bgHigh <= 0) 0.0 else ((bgHigh - bgLow).toDouble() / bgHigh).coerceIn(0.0, 1.0)

      // 高频层 = 原图 - 背景；它的标准差归一后作为摩尔纹的粗判（拍屏会明显偏高）
      Core.subtract(gray, bg, highpass)
      val hpMean = MatOfDouble()
      val hpStd = MatOfDouble()
      Core.meanStdDev(highpass, hpMean, hpStd)
      val hpStdDev = hpStd.toArray()[0]
      val moireScore = (hpStdDev / 255.0 * 4.0).coerceIn(0.0, 1.0)
      hpMean.release()
      hpStd.release()

      return Values(
        brightness = brightness,
        contrast = contrast,
        saturation = saturation,
        median = Histogram.percentile(grayHist, 0.5).toDouble(),
        blurScore = blurScore,
        shadowScore = shadowScore,
        moireScore = moireScore,
        whiteCoverage = Histogram.fractionAtLeast(grayHist, 235),
        elapsedMs = System.currentTimeMillis() - started
      )
    } finally {
      gray.release()
      hsv.release()
      lap.release()
      bg.release()
      highpass.release()
    }
  }

  /** OpenCV 的高斯核尺寸必须是正奇数 */
  fun oddAtLeast(value: Int, minimum: Int): Int {
    val v = maxOf(value, minimum)
    return if (v % 2 == 0) v + 1 else v
  }
}

/**
 * 8U 单通道直方图与分位数。
 *
 * 比 Core.sort / 逐像素取值快一个量级，也不需要把整张图搬进 float。
 * 非连续 Mat（submat 之后的常见情况）按行读，保证不读错位。
 */
object Histogram {
  fun of(gray: Mat): LongArray {
    val hist = LongArray(256)
    if (gray.empty() || gray.type() != CvType.CV_8UC1) return hist
    if (gray.isContinuous()) {
      val bytes = ByteArray(gray.rows() * gray.cols())
      gray.get(0, 0, bytes)
      for (b in bytes) hist[b.toInt() and 0xFF] += 1L
      return hist
    }
    val row = ByteArray(gray.cols())
    for (y in 0 until gray.rows()) {
      gray.get(y, 0, row)
      for (b in row) hist[b.toInt() and 0xFF] += 1L
    }
    return hist
  }

  /** p ∈ [0,1] 的分位数（返回灰阶值 0..255） */
  fun percentile(hist: LongArray, p: Double): Int {
    val total = hist.sum()
    if (total <= 0L) return 0
    val target = Math.round(total * p.coerceIn(0.0, 1.0))
    var acc = 0L
    for (v in hist.indices) {
      acc += hist[v]
      if (acc >= target) return v
    }
    return 255
  }

  fun fractionAtLeast(hist: LongArray, threshold: Int): Double {
    val total = hist.sum()
    if (total <= 0L) return 0.0
    var above = 0L
    for (v in threshold.coerceIn(0, 255)..255) above += hist[v]
    return above.toDouble() / total
  }
}
