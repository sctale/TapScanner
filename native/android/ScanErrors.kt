package com.tapscanner.app

/**
 * 原生错误码的唯一真源。
 *
 * 以前散在各个文件里的字符串常量既看不见全貌，也容易和
 * src/native/ScannerNative.ts 的 SCANNER_ERRORS 漂移开（漂移的后果是界面上
 * 只剩「处理失败」四个字，真实原因永远拿不到）。
 */
object ScanErrors {
  const val OPENCV = "ERR_OPENCV"
  const val DECODE = "ERR_DECODE"
  const val ENCODE = "ERR_ENCODE"
  const val CANCELLED = "ERR_CANCELLED"
  const val NATIVE = "ERR_NATIVE"
  const val NOT_READY = "ERR_NOT_READY"
  const val BAD_INPUT = "ERR_BAD_INPUT"
  const val NO_ACTIVITY = "ERR_NO_ACTIVITY"
}

/** 管线内部异常：带上错误码，由 ScannerModule 如实 reject 出去 */
class PipelineError(val code: String, message: String) : RuntimeException(message)
