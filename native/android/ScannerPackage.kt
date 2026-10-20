package com.tapscanner.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * RN 原生模块注册入口（由 plugins/withScannerModule.js 写进 MainApplication.kt）。
 *
 * 走 legacy ReactPackage + bridgeless interop：anti-car-sickness 在 newArchEnabled=true
 * 下用同一套模式稳定发过多个版本，是本项目里唯一「已在真机验证过」的桥接路径。
 */
class ScannerPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(ScannerModule(reactContext))

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = emptyList()
}
