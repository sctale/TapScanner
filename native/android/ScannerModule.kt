package com.tapscanner.app

import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import org.opencv.android.OpenCVLoader
import org.opencv.core.Core
import org.opencv.core.Mat
import org.opencv.core.Point
import java.util.concurrent.Executors

/**
 * TapScanner 原生扫描模块（JS 契约见 src/native/ScannerNative.ts，一一对应）。
 *
 * 三个方法就是「智能高清」的全部对外面：
 *   isReady   —— OpenCV 加载判据（M1 的验收项，也是「装上就崩」的兜底自检）
 *   analyze   —— 只量不画：指标 + 自动四角 + 是否真检测到
 *   process   —— 出成品：切边矫正 → 增强 → 落盘 + 缩略图 + 前后指标
 *
 * 线程与内存纪律：
 *   - 单线程 Executor，并发 1。4000×3000 的 BGR 约 36MB，两张同时在飞就有被系统杀掉的风险
 *   - 每个 Mat 都在 finally 里 release；增强子函数一律「消费输入」，避免两处各释放一半
 *   - **任何异常都必须变成 reject**，不许逃出 Executor 线程：那是一次未处理异常，
 *     用户看到的是 App 直接没了，而不是「这张没处理成」
 *
 * 没有做进度事件：bridgeless 下事件通道在本系列项目里没有先例，
 * 而单页处理只有 1.4~2 秒 —— 用忙碌态 + 事后回报各阶段耗时更稳，也更简单。
 */
class ScannerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "ScannerModule"

    @Volatile
    private var openCvReady: Boolean? = null

    /** initLocal 幂等，但结果如实缓存（OpenCV 4.9 起已删除 OpenCV Manager，别再去找它） */
    fun ensureOpenCv(): Boolean {
      openCvReady?.let { return it }
      val loaded = try {
        OpenCVLoader.initLocal()
      } catch (t: Throwable) {
        false
      }
      openCvReady = loaded
      return loaded
    }
  }

  private val executor = Executors.newSingleThreadExecutor()

  override fun getName(): String = NAME

  // ---------- 对外方法 ----------

  @ReactMethod
  fun isReady(promise: Promise) {
    val loaded = ensureOpenCv()
    val map = Arguments.createMap()
    map.putBoolean("ready", loaded)
    map.putString("version", if (loaded) Core.VERSION else "")
    map.putString("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "")
    promise.resolve(map)
  }

  /**
   * 图像感知 + 边界检测。不改像素、不落盘。
   * @param maxSide 分析图最长边，默认 1200（够算指标和轮廓，又能把耗时压到几十毫秒）
   */
  @ReactMethod
  fun analyze(path: String, maxSide: Double, promise: Promise) {
    executor.execute {
      var full: Mat? = null
      var small: Mat? = null
      var gray: Mat? = null
      try {
        requireOpenCv()
        val started = System.currentTimeMillis()
        val decoded = DocPipeline.decode(path)
        val exif = ExifOrientation.read(path)
        full = DocPipeline.applyRotation(decoded, exif.rotationDegrees)

        val limit = if (maxSide <= 0) ANALYSIS_MAX_SIDE else maxSide.toInt()
        val pair = DocPipeline.toAnalysis(full, limit)
        small = pair.first
        gray = pair.second

        val metrics = Metrics.measure(small)
        val quad = QuadDetect.detect(small, gray, light = false)

        val map = Arguments.createMap()
        map.putMap("metrics", metricsToMap(metrics))
        map.putArray("quad", pointsToArray(quad.points))
        map.putBoolean("detected", quad.detected)
        map.putDouble("confidence", quad.confidence)
        map.putDouble("width", full.cols().toDouble())
        map.putDouble("height", full.rows().toDouble())
        map.putDouble("rotationDegrees", exif.rotationDegrees.toDouble())
        map.putDouble("detectMs", quad.elapsedMs.toDouble())
        map.putDouble("totalMs", (System.currentTimeMillis() - started).toDouble())
        promise.resolve(map)
      } catch (e: PipelineError) {
        promise.reject(e.code, e.message)
      } catch (t: Throwable) {
        promise.reject(ScanErrors.NATIVE, "分析失败：${t.message ?: t.javaClass.simpleName}")
      } finally {
        small?.release()
        gray?.release()
        full?.release()
      }
    }
  }

  /**
   * 出成品扫描件。
   *
   * @param quad 归一化四角（8 个数）；传 null 表示「按自动检测的结果来」
   *             —— 自动检测失败时仍会用回退框，并在返回里以 autoCropped=false 如实说明
   * @param mode hd / enhance / gray / bw / raw，见 DocPipeline.presetFor
   */
  @ReactMethod
  fun process(
    path: String,
    outPath: String,
    thumbPath: String,
    quad: ReadableArray?,
    mode: String,
    outputMaxSide: Double,
    jpegQuality: Double,
    promise: Promise
  ) {
    executor.execute {
      var full: Mat? = null
      var beforeSmall: Mat? = null
      var beforeGray: Mat? = null
      var warped: Mat? = null
      var enhanced: Mat? = null
      try {
        requireOpenCv()
        if (!DocPipeline.isMode(mode)) {
          promise.reject(ScanErrors.BAD_INPUT, "未知的处理模式：$mode")
          return@execute
        }
        val started = System.currentTimeMillis()
        val decoded = DocPipeline.decode(path)
        val exif = ExifOrientation.read(path)
        full = DocPipeline.applyRotation(decoded, exif.rotationDegrees)
        val decodeMs = System.currentTimeMillis() - started

        var opts = DocPipeline.presetFor(mode)
        if (outputMaxSide > 0) opts = opts.copy(outputMaxSide = outputMaxSide.toInt())
        if (jpegQuality > 0) opts = opts.copy(jpegQuality = jpegQuality.toInt())

        val fullW = full.cols().toDouble()
        val fullH = full.rows().toDouble()

        // 四角来源：用户/实时层的框 优先，否则现场自动检测
        var autoDetected = false
        var detectedFlag = false
        val quadNorm: List<Point> = if (quad != null && quad.size() == 8) {
          QuadDetect.orderCorners(
            listOf(
              Point(quad.getDouble(0), quad.getDouble(1)),
              Point(quad.getDouble(2), quad.getDouble(3)),
              Point(quad.getDouble(4), quad.getDouble(5)),
              Point(quad.getDouble(6), quad.getDouble(7))
            )
          )
        } else {
          val pair = DocPipeline.toAnalysis(full, ANALYSIS_MAX_SIDE)
          beforeSmall = pair.first
          beforeGray = pair.second
          val found = QuadDetect.detect(beforeSmall, beforeGray, light = false)
          autoDetected = true
          detectedFlag = found.detected
          found.points
        }
        val quadPixels = QuadDetect.toPixels(quadNorm, fullW, fullH)

        // 「处理前」指标：没有自动检测分支时也要量一次，用于界面上的清晰度提升百分比
        if (beforeSmall == null) {
          val pair = DocPipeline.toAnalysis(full, ANALYSIS_MAX_SIDE)
          beforeSmall = pair.first
          beforeGray = pair.second
        }
        val metricsBefore = Metrics.measure(beforeSmall)

        val warpStarted = System.currentTimeMillis()
        warped = DocPipeline.warp(full, quadPixels, opts.outputMaxSide)
        val warpMs = System.currentTimeMillis() - warpStarted

        val enhanceStarted = System.currentTimeMillis()
        enhanced = DocPipeline.enhance(warped!!, opts)
        warped?.release()
        warped = null
        val enhanceMs = System.currentTimeMillis() - enhanceStarted

        val encodeStarted = System.currentTimeMillis()
        if (!DocPipeline.encodeBgr(enhanced!!, outPath, opts.jpegQuality)) {
          promise.reject(ScanErrors.ENCODE, "写不出成品图片：$outPath")
          return@execute
        }
        DocPipeline.writeThumb(enhanced, thumbPath, THUMB_MAX_SIDE)
        val encodeMs = System.currentTimeMillis() - encodeStarted

        val afterPair = DocPipeline.toAnalysis(enhanced, ANALYSIS_MAX_SIDE)
        val metricsAfter = Metrics.measure(afterPair.first)
        afterPair.first.release()
        afterPair.second.release()

        val out = Arguments.createMap()
        out.putString("outPath", outPath.removePrefix("file://"))
        out.putString("thumbPath", thumbPath.removePrefix("file://"))
        out.putDouble("width", enhanced.cols().toDouble())
        out.putDouble("height", enhanced.rows().toDouble())
        out.putString("mode", opts.mode)
        out.putMap("metricsBefore", metricsToMap(metricsBefore))
        out.putMap("metricsAfter", metricsToMap(metricsAfter))
        out.putDouble(
          "sharpnessGain",
          if (metricsBefore.blurScore > 1.0) metricsAfter.blurScore / metricsBefore.blurScore else 1.0
        )
        out.putArray("usedQuad", pointsToArray(quadNorm))
        out.putBoolean("autoCropped", autoDetected && detectedFlag)
        out.putMap("stages", stagesMap(decodeMs, warpMs, enhanceMs, encodeMs, started))
        promise.resolve(out)
      } catch (e: PipelineError) {
        promise.reject(e.code, e.message)
      } catch (t: Throwable) {
        promise.reject(ScanErrors.NATIVE, "处理失败：${t.message ?: t.javaClass.simpleName}")
      } finally {
        enhanced?.release()
        warped?.release()
        beforeSmall?.release()
        beforeGray?.release()
        full?.release()
      }
    }
  }

  /**
   * OpenCV 链路最小探针：imread → 缩放 → imwrite。
   * 真实工作已由 analyze/process 承担，但这条留着 —— 「智能高清没效果」时，
   * 先用它判断是图像层坏了还是算法判断坏了，别一上来就猜参数。
   */
  @ReactMethod
  fun probe(path: String, outPath: String, maxSide: Double, promise: Promise) {
    executor.execute {
      var src: Mat? = null
      var out: Mat? = null
      var gray: Mat? = null
      try {
        requireOpenCv()
        val started = System.currentTimeMillis()
        src = DocPipeline.decode(path)
        val sourceW = src!!.cols().toDouble()
        val sourceH = src!!.rows().toDouble()
        if (maxSide > 0) {
          val pair = DocPipeline.toAnalysis(src, maxSide.toInt())
          out = pair.first
          gray = pair.second
        } else {
          out = src!!.clone()
        }
        val written = DocPipeline.encodeBgr(out, outPath, 90)
        if (!written) {
          promise.reject(ScanErrors.ENCODE, "写不出探针图片：$outPath")
          return@execute
        }
        val map = Arguments.createMap()
        map.putString("outPath", outPath.removePrefix("file://"))
        map.putDouble("width", out.cols().toDouble())
        map.putDouble("height", out.rows().toDouble())
        map.putDouble("sourceWidth", sourceW)
        map.putDouble("sourceHeight", sourceH)
        map.putDouble("elapsedMs", (System.currentTimeMillis() - started).toDouble())
        promise.resolve(map)
      } catch (e: PipelineError) {
        promise.reject(e.code, e.message)
      } catch (t: Throwable) {
        promise.reject(ScanErrors.NATIVE, "探针失败：${t.message ?: t.javaClass.simpleName}")
      } finally {
        gray?.release()
        out?.release()
        src?.release()
      }
    }
  }

  // ---------- 内部 ----------

  private fun requireOpenCv() {
    if (!ensureOpenCv()) {
      throw PipelineError(ScanErrors.OPENCV, "OpenCV 原生库没能加载，无法处理图片")
    }
  }

  private fun metricsToMap(m: Metrics.Values): WritableMap {
    val map = Arguments.createMap()
    map.putDouble("brightness", m.brightness)
    map.putDouble("contrast", m.contrast)
    map.putDouble("saturation", m.saturation)
    map.putDouble("median", m.median)
    map.putDouble("blurScore", m.blurScore)
    map.putDouble("shadowScore", m.shadowScore)
    map.putDouble("moireScore", m.moireScore)
    map.putDouble("whiteCoverage", m.whiteCoverage)
    map.putDouble("elapsedMs", m.elapsedMs.toDouble())
    return map
  }

  private fun pointsToArray(points: List<Point>): WritableArray {
    val arr = Arguments.createArray()
    points.forEach {
      arr.pushMap(Arguments.createMap().apply {
        putDouble("x", it.x)
        putDouble("y", it.y)
      })
    }
    return arr
  }

  /** 各阶段耗时如实回报：慢机型一张截图就能自报，比我远程猜快 */
  private fun stagesMap(decodeMs: Long, warpMs: Long, enhanceMs: Long, encodeMs: Long, started: Long): WritableMap {
    val map = Arguments.createMap()
    map.putDouble("decodeMs", decodeMs.toDouble())
    map.putDouble("warpMs", warpMs.toDouble())
    map.putDouble("enhanceMs", enhanceMs.toDouble())
    map.putDouble("encodeMs", encodeMs.toDouble())
    map.putDouble("totalMs", (System.currentTimeMillis() - started).toDouble())
    return map
  }
}

private const val ANALYSIS_MAX_SIDE = 1200
private const val THUMB_MAX_SIDE = 480
