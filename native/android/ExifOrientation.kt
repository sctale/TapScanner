package com.tapscanner.app

import android.media.ExifInterface
import java.io.File

/**
 * JPEG 的 EXIF 朝向 + DPI。
 *
 * 朝向必须显式处理：Android 相机普遍把像素按传感器方向写盘、用 EXIF 标签标记旋转，
 * 相册/浏览器靠这个标签旋转显示。OpenCV 的 imread 是否替你旋转在不同版本上出了名地不确定 ——
 * 所以这里自己读标签、自己转，不依赖任何库的「顺手行为」。
 *
 * DPI 用于 PDF 页面尺寸换算（pt = px * 72 / dpi）。
 * 相机中常见的「72dpi」其实是占位值，直接照搬会把 A4 打成海报，
 * 因此只在合理区间（100..1200）才采信，否则一律按 300。
 *
 * 注意：android.media.ExifInterface **没有** RESOLUTION_UNIT_* 常量
 * （javap android-36/android.jar 实测，只有 TAG_RESOLUTION_UNIT 这个标签名），
 * 所以下面按 EXIF 规范用字面值。
 */
object ExifOrientation {
  private const val RESOLUTION_UNIT_NONE = 0
  private const val RESOLUTION_UNIT_INCH = 1
  private const val RESOLUTION_UNIT_CM = 2

  private const val FALLBACK_DPI = 300
  private const val DPI_MIN = 100
  private const val DPI_MAX = 1200

  data class Info(val rotationDegrees: Int, val dpi: Int)

  fun read(path: String): Info {
    return try {
      val exif = ExifInterface(path.removePrefix("file://"))
      val orientation =
        exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
      val rotation = when (orientation) {
        ExifInterface.ORIENTATION_ROTATE_90 -> 90
        ExifInterface.ORIENTATION_ROTATE_180 -> 180
        ExifInterface.ORIENTATION_ROTATE_270 -> 270
        // 镜像类标签不做去镜像（前摄自拍才会遇到，扫描场景没有）
        else -> 0
      }
      Info(rotation, readDpi(exif))
    } catch (t: Throwable) {
      // 读不出来不代表图坏了：朝向按 0、DPI 按 300 继续走
      Info(0, FALLBACK_DPI)
    }
  }

  private fun readDpi(exif: ExifInterface): Int {
    val unit = exif.getAttributeInt(ExifInterface.TAG_RESOLUTION_UNIT, RESOLUTION_UNIT_NONE)
    if (unit != RESOLUTION_UNIT_INCH) return FALLBACK_DPI
    val raw = exif.getAttributeInt(ExifInterface.TAG_X_RESOLUTION, 0)
    return if (raw in DPI_MIN..DPI_MAX) raw else FALLBACK_DPI
  }

  fun exists(path: String): Boolean = File(path.removePrefix("file://")).exists()
}
