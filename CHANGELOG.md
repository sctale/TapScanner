# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 SemVer。
版本单一数据源是 `app.json` 的 `expo.version`，`versionCode = major*10000 + minor*100 + patch`。

## [0.1.0] - 2026-10-20

首个版本：Tap 系列的新成员，把「拍照 → 智能高清 → 多页成文档 → 导出」这条主干做通。

### 新增

- **智能高清**：自动切边（Canny 自适应阈值 + 轮廓 + 四边形校验 + 亚像素精化）、梯形矫正、光照/阴影摊平（大核高斯估背景后除法归一）、CLAHE 只动亮度通道、bilateral 降噪、unsharp 锐化、纸面提白。
- **场景化决策**：原生量出亮度/对比度/饱和度/清晰度/阴影/屏纹六项指标，判定表在纯 JS 的 `src/utils/modeSelection.ts`，默认档位与理由都显示在界面上，且当场可换、事后可换（raw 图一直保留）。
- **五个档位**：智能高清 / 增强 / 灰度 / 黑白（自适应阈值，不用全局 Otsu）/ 原图。
- **手动四角调整**：并列页 + 可拖四角，自动检测失败时也有回退框，绝不出现「没法切边」的死路。
- **多页文档**：页序上下移、改名、收藏、删除；文档列表按更新时间/收藏排序。
- **相册导入**：相册照片走同一条增强管线。
- **PDF 导出**：手写最小 PDF，JPEG 原始字节以 DCTDecode 直传，**零重编码**；页面尺寸 `pt = px*72/dpi`。
- **备份**：JSON 导出/导入，导入时逐份校验图片是否还在本机，缺图片的整份跳过。
- **存储管理**：占用统计 + 未引用目录清理；管理页「关于」里有图像引擎自检（OpenCV 版本/ABI + 一次真实解码-缩放-编码探针）。

### 说明与限制

- 曲面矫正、透字去除、手指区域补图**未实现**（需要深度学习模型，本 App 不带模型）；「去阴影」是除法归一化近似。
- 摩尔纹只判断、不消除：判断到屏纹时自动避开降噪档。
- 实时取景边框检测未实现（放 v0.2），当前是「拍完自动切边 + 手动四角」。
- 没有 OCR、云同步、水印、手写批注。
- 发布包只带 arm64-v8a：OpenCV 的 `libopencv_java4.so` 实测 arm64 22.9MB、x86_64 56.5MB，两个都带会是 152MB 的包。需要模拟器包用 `release-app.ps1 -EmulatorAbi`。

### 工程

- 原生模块经 Config Plugin 注入（`plugins/withScannerModule.js`），`native/android/*.kt` 是 Kotlin 真源并入库；`android/` 由 prebuild 生成、不入库。
- `.gitignore` 用根锚定 `/android/`，避免把 `native/android/` 一起忽略（兄弟项目的历史踩坑）。
- 发布脚本的断言全部打在产物上：aapt 版本号与桌面显示名、apksigner 拒 debug 签名、APK 内 OpenCV `.so` 与 ABI 清单、zipalign 16KB 页对齐。
- 单测 47 项覆盖四角几何、模式判定表、PDF 字节结构（含每个 xref 偏移必须真的落在 `N 0 obj` 上）。
