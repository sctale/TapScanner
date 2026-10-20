package com.tapscanner.app

import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfInt
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Size
import org.opencv.imgcodecs.Imgcodecs
import org.opencv.imgproc.Imgproc
import java.io.File
import kotlin.math.max
import kotlin.math.min

/**
 * 智能高清增强管线 —— 扫描全能王那套「感知 → 决策 → 执行」里的执行层。
 *
 * 说清边界（README 也照这个写）：
 *   做：自动切边、梯形矫正、光照/阴影摊平、对比度增强、纸面提白、锐化、降噪、五种输出模式
 *   不做：曲面矫正、透字去除、手指区域补图（这三项要深度学习模型，本 App 不带模型）
 *   「去阴影」是除法归一化（Retinex 摊平）近似，不是 GAN
 *
 * Mat 所有权约定（这里漏一个就是 OOM 或花屏）：
 *   - 每个私有增强函数**消费**传进来的 Mat（除flattenLighting 之外都自己 new 输出）
 *   - 所有中间 Mat 在 finally 里 release
 *   - enhance() 的返回 Mat 归调用方（ScannerModule）释放
 */
object DocPipeline {
  const val MODE_HD = "hd"
  const val MODE_ENHANCE = "enhance"
  const val MODE_GRAY = "gray"
  const val MODE_BW = "bw"
  const val MODE_RAW = "raw"

  data class Options(
    val mode: String,
    val outputMaxSide: Int = 3000,
    val jpegQuality: Int = 92,
    /** 光照摊平（「去阴影」） */
    val flatten: Boolean = true,
    /** 边缘保持降噪；摩尔纹场景必须关，bilateral 会把纹放大 */
    val denoise: Boolean = true,
    val claheClip: Double = 1.8,
    val unsharpAmount: Double = 0.6,
    val unsharpSigma: Double = 1.2,
    /** 纸面目标白点 */
    val whitePoint: Int = 250
  )

  /** 模式 → 默认参数。界面上换档就是换这张表（不做滑杆，取舍理由见 AGENTS.md） */
  fun presetFor(mode: String?): Options = when (mode) {
    MODE_ENHANCE -> Options(
      mode = MODE_ENHANCE, flatten = false, denoise = false, claheClip = 2.5, unsharpAmount = 0.8
    )

    MODE_GRAY -> Options(
      mode = MODE_GRAY, flatten = true, denoise = false, claheClip = 1.4, unsharpAmount = 0.4
    )

    MODE_BW -> Options(
      mode = MODE_BW, flatten = true, denoise = false, claheClip = 0.0, unsharpAmount = 0.0
    )

    MODE_RAW -> Options(
      mode = MODE_RAW, flatten = false, denoise = false, claheClip = 0.0, unsharpAmount = 0.0
    )

    else -> Options(mode = MODE_HD)
  }

  fun isMode(mode: String?): Boolean =
    mode == MODE_HD || mode == MODE_ENHANCE || mode == MODE_GRAY || mode == MODE_BW || mode == MODE_RAW

  // ---------- 解码 / 编码 ----------

  fun decode(path: String): Mat {
    val clean = path.removePrefix("file://")
    if (!File(clean).exists()) {
      throw PipelineError(ScanErrors.DECODE, "文件不存在：$clean")
    }
    val mat = Imgcodecs.imread(clean, Imgcodecs.IMREAD_COLOR)
    if (mat.empty()) {
      mat.release()
      throw PipelineError(ScanErrors.DECODE, "读不出这张图片（格式不支持或已损坏）：$clean")
    }
    return mat
  }

  fun encodeBgr(bgr: Mat, path: String, quality: Int): Boolean {
    val clean = path.removePrefix("file://")
    File(clean).parentFile?.mkdirs()
    val params = MatOfInt(Imgcodecs.IMWRITE_JPEG_QUALITY, quality.coerceIn(1, 100))
    return try {
      Imgcodecs.imwrite(clean, bgr, params)
    } finally {
      params.release()
    }
  }

  /** EXIF 朝向 → 正立图像。相机写盘时像素通常是转过的，这里不转就等着出 90° 歪的扫描件 */
  fun applyRotation(src: Mat, degrees: Int): Mat {
    if (degrees == 0) return src
    val code = when (degrees) {
      90 -> Core.ROTATE_90_CLOCKWISE
      180 -> Core.ROTATE_180
      270 -> Core.ROTATE_90_COUNTERCLOCKWISE
      else -> return src
    }
    val dst = Mat()
    Core.rotate(src, dst, code)
    src.release()
    return dst
  }

  // ---------- 几何 ----------

  /** 四角（像素坐标，顺序 TL,TR,BR,BL）→ 拉正后的图 */
  fun warp(src: Mat, quadPixels: List<Point>, outputMaxSide: Int): Mat {
    if (quadPixels.size != 4) throw PipelineError(ScanErrors.BAD_INPUT, "四角必须是 4 个点")
    val target = QuadDetect.targetSize(quadPixels, outputMaxSide)
    val dstW = target.width.toDouble()
    val dstH = target.height.toDouble()
    val srcPts = MatOfPoint2f(*quadPixels.toTypedArray())
    val dstPts = MatOfPoint2f(
      Point(0.0, 0.0),
      Point(dstW, 0.0),
      Point(dstW, dstH),
      Point(0.0, dstH)
    )
    val m = Imgproc.getPerspectiveTransform(srcPts, dstPts)
    val dst = Mat()
    try {
      Imgproc.warpPerspective(
        src, dst, m, Size(dstW, dstH), Imgproc.INTER_LINEAR, Core.BORDER_REPLICATE
      )
    } finally {
      srcPts.release()
      dstPts.release()
      m.release()
    }
    return dst
  }

  /** 没有切边需求时（原图档）也走一次等比缩放，保证输出尺寸不超过 maxSide */
  fun clampSize(src: Mat, outputMaxSide: Int): Mat {
    val longest = max(src.cols(), src.rows()).toDouble()
    if (longest <= outputMaxSide) return src.clone()
    val scale = outputMaxSide / longest
    val dst = Mat()
    Imgproc.resize(
      src, dst,
      Size(
        max(1.0, Math.round(src.cols() * scale).toDouble()),
        max(1.0, Math.round(src.rows() * scale).toDouble())
      ),
      0.0,
      0.0,
      Imgproc.INTER_AREA
    )
    return dst
  }

  // ---------- 像素增强 ----------

  fun enhance(bgr: Mat, opts: Options): Mat = when (opts.mode) {
    MODE_RAW -> bgr.clone()
    MODE_GRAY -> grayscale(bgr.clone(), opts)
    MODE_BW -> blackWhite(bgr.clone(), opts)
    else -> colorEnhanced(bgr.clone(), opts)
  }

  /** 智能高清 / 增强：Lab 上只动亮度通道，保留墨迹与图片颜色 */
  private fun colorEnhanced(bgr: Mat, opts: Options): Mat {
    val lab = Mat()
    val channels = ArrayList<Mat>()
    var l = Mat()
    try {
      Imgproc.cvtColor(bgr, lab, Imgproc.COLOR_BGR2Lab)
      Core.split(lab, channels)
      if (channels.size < 3) throw PipelineError(ScanErrors.NATIVE, "Lab 通道拆分异常")
      channels[0].copyTo(l)

      if (opts.flatten) l = consumeFlatten(l)
      if (opts.claheClip > 0.0) l = consumeClahe(l, opts)
      val stretched = Mat()
      whitePointStretch(l, stretched, opts.whitePoint)
      l.release()
      l = stretched

      // 只换 L，a/b 原样合并 → 颜色不跑偏、纸面变白
      val merged = Mat()
      Core.merge(listOf(l, channels[1], channels[2]), merged)
      val out = Mat()
      Imgproc.cvtColor(merged, out, Imgproc.COLOR_Lab2BGR)
      merged.release()
      bgr.release()
      return postSharpen(out, opts)
    } finally {
      lab.release()
      l.release()
      channels.forEach { it.release() }
    }
  }

  private fun grayscale(bgr: Mat, opts: Options): Mat {
    var work = Mat()
    Imgproc.cvtColor(bgr, work, Imgproc.COLOR_BGR2GRAY)
    bgr.release()
    try {
      if (opts.flatten) work = consumeFlatten(work)
      if (opts.claheClip > 0.0) work = consumeClahe(work, opts)
      val stretched = Mat()
      whitePointStretch(work, stretched, opts.whitePoint)
      work.release()
      work = stretched

      val out = Mat()
      Imgproc.cvtColor(work, out, Imgproc.COLOR_GRAY2BGR)
      return postSharpen(out, opts.copy(denoise = false))
    } finally {
      work.release()
    }
  }

  /**
   * 黑白：自适应阈值。
   *
   * 刻意不用 Otsu —— 全局阈值在这个模式被使用的场景（侧光、半边阴影）下必然
   * 一半糊成黑、一半全是白。自适应阈值拿局部均值当基准，光照梯度直接被吃掉。
   */
  private fun blackWhite(bgr: Mat, opts: Options): Mat {
    var gray = Mat()
    Imgproc.cvtColor(bgr, gray, Imgproc.COLOR_BGR2GRAY)
    bgr.release()
    try {
      if (opts.flatten) gray = consumeFlatten(gray)
      val blockBase = (min(gray.cols(), gray.rows()) * 0.02).toInt()
      val blockSize = Metrics.oddAtLeast(blockBase, 15)
      val binarized = Mat()
      Imgproc.adaptiveThreshold(
        gray, binarized, 255.0,
        Imgproc.ADAPTIVE_THRESH_GAUSSIAN_C, Imgproc.THRESH_BINARY, blockSize, 12.0
      )
      val out = Mat()
      Imgproc.cvtColor(binarized, out, Imgproc.COLOR_GRAY2BGR)
      binarized.release()
      return out
    } finally {
      gray.release()
    }
  }

  /**
   * 光照摊平：大核高斯估背景，再做除法归一（Retinex 的一维近似）。
   *
   * 纸面被拉成均匀白，墨迹因局部对比保留而仍然黑。这一步同时消掉手影、侧光和渐变底色，
   * 是「智能高清」里最值钱的一下。
   */
  private fun flattenLighting(src: Mat): Mat {
    val k = Metrics.oddAtLeast((min(src.cols(), src.rows()) * 0.05).toInt(), 31)
    val bg = Mat()
    val srcF = Mat()
    val bgF = Mat()
    val ratio = Mat()
    val out = Mat()
    try {
      Imgproc.GaussianBlur(src, bg, Size(k.toDouble(), k.toDouble()), 0.0)
      src.convertTo(srcF, CvType.CV_32F)
      bg.convertTo(bgF, CvType.CV_32F)
      // dst = scale * src1 / src2；scale 取 255 让「背景本身」正好落到 255
      Core.divide(srcF, bgF, ratio, 255.0)
      // 过亮处会超 255，convertScaleAbs 自带饱和截断
      Core.convertScaleAbs(ratio, out, 1.0, 0.0)
      return out
    } finally {
      bg.release()
      srcF.release()
      bgF.release()
      ratio.release()
    }
  }

  /** 消费输入、返回新 Mat 的统一写法（省掉每个调用点一遍 if !== 判断） */
  private fun consumeFlatten(src: Mat): Mat {
    val out = flattenLighting(src)
    src.release()
    return out
  }

  private fun consumeClahe(src: Mat, opts: Options): Mat {
    val out = Mat()
    // Algorithm 在 Java 绑定里没有 release()/delete()，只有 finalize() 里回收 native 对象；
    // 用完不再引用即可，别去调不存在的方法（javap org.opencv.core.Algorithm 实测）。
    val clahe = Imgproc.createCLAHE(opts.claheClip, Size(8.0, 8.0))
    clahe.apply(src, out)
    src.release()
    return out
  }

  /** 纸面提白：p2 → 0，p97 → whitePoint。拉直方图而不是加亮度，暗部不会被一起抬起来 */
  private fun whitePointStretch(src: Mat, dst: Mat, whitePoint: Int) {
    val hist = Histogram.of(src)
    val p02 = Histogram.percentile(hist, 0.02)
    val p97 = Histogram.percentile(hist, 0.97)
    val span = (p97 - p02).toDouble()
    if (span <= 1.0) {
      src.copyTo(dst)
      return
    }
    val alpha = whitePoint / span
    val beta = -p02 * alpha
    Core.convertScaleAbs(src, dst, alpha, beta)
  }

  /** 降噪 + 锐化；**消费**传入的 Mat。摩尔纹档把 bilateral 关掉 */
  private fun postSharpen(bgr: Mat, opts: Options): Mat {
    var work = bgr
    if (opts.denoise) {
      val smoothed = Mat()
      Imgproc.bilateralFilter(work, smoothed, 5, 35.0, 35.0)
      work.release()
      work = smoothed
    }
    if (opts.unsharpAmount <= 0.0) return work
    // 注意：work 只能在确实不再返回它的时候释放（早前写成 finally 统一释放，
    // 而 unsharpAmount<=0 的分支要原样返回 work，那条路径会交出已释放的 Mat）
    val blur = Mat()
    val out = Mat()
    try {
      // 核给 0 让 OpenCV 按 sigma 定；σ 太小只会把噪点 sharpen 出来
      Imgproc.GaussianBlur(work, blur, Size(0.0, 0.0), opts.unsharpSigma)
      Core.addWeighted(work, 1.0 + opts.unsharpAmount, blur, -opts.unsharpAmount, 0.0, out)
    } finally {
      blur.release()
      work.release()
    }
    return out
  }

  /** 缩略图（文档卡片用）：INTER_AREA 缩小 + 78% 质量，够小且不发虚 */
  fun writeThumb(bgr: Mat, path: String, maxSide: Int): Boolean {
    val longest = max(bgr.cols(), bgr.rows()).toDouble()
    if (longest <= maxSide) return encodeBgr(bgr, path, 78)
    val scale = maxSide / longest
    val small = Mat()
    try {
      Imgproc.resize(
        bgr, small,
        Size(
          max(1.0, Math.round(bgr.cols() * scale).toDouble()),
          max(1.0, Math.round(bgr.rows() * scale).toDouble())
        ),
        0.0,
        0.0,
        Imgproc.INTER_AREA
      )
      return encodeBgr(small, path, 78)
    } finally {
      small.release()
    }
  }

  /** 分析用小图 + 灰度（一次算出来给 Metrics 和 QuadDetect 复用） */
  fun toAnalysis(bgr: Mat, maxSide: Int): Pair<Mat, Mat> {
    val longest = max(bgr.cols(), bgr.rows()).toDouble()
    val small = Mat()
    if (longest > maxSide) {
      val scale = maxSide / longest
      Imgproc.resize(
        bgr, small,
        Size(
          max(1.0, Math.round(bgr.cols() * scale).toDouble()),
          max(1.0, Math.round(bgr.rows() * scale).toDouble())
        ),
        0.0,
        0.0,
        Imgproc.INTER_AREA
      )
    } else {
      bgr.copyTo(small)
    }
    val gray = Mat()
    Imgproc.cvtColor(small, gray, Imgproc.COLOR_BGR2GRAY)
    return Pair(small, gray)
  }
}
