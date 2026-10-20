# TapScanner 项目规范

## 项目简介

「扫描一下」（仓库名 TapScanner）是 Tap 系列的文档扫描 App：拍照 → 智能高清 → 多页成文档 → 导出 PDF/JPG。
对标扫描全能王，但只带经典 CV、不带深度学习模型，能力边界在 README 里写得很清楚，不要对外承诺模型级效果。

| 类别 | 技术 |
|------|------|
| 框架 | React Native + Expo SDK 56（`expo ~56.0.12`，实际解析 56.0.23） |
| 版本 | React Native 0.85.3 / React 19.2.3 / TypeScript ~6.0.3 |
| 相机 | react-native-vision-camera 5.2.3（+ react-native-nitro-modules 0.37.1 / nitro-image 0.15.2） |
| 图像层 | **Kotlin 原生模块 + OpenCV 4.13**（`org.opencv:opencv:4.13.0`，Maven Central 官方 AAR，无需 NDK 编译） |
| 存储 | expo-sqlite（记录）+ expo-file-system 新 API（图片文件） |
| 原生层 | 真源在 `native/android/*.kt`，由 `plugins/withScannerModule.js` 在 prebuild 时注入 `android/` |
| 最低/目标 | minSdk 24 / target 36；发布包只带 **arm64-v8a** |

Expo 版本相关写法先查对应版本文档：https://docs.expo.dev/versions/v56.0.0/

---

## 架构

```
JS (App.tsx, 无导航库：全部 Tab 保持挂载 + display 互斥切换)
  ├─ src/screens/{ScanScreen,DocumentsScreen→DocDetailScreen,ManageScreen}
  ├─ src/utils/scanPipeline.ts   拍摄→搬文件→感知→出成品→落库（编排的唯一入口）
  ├─ src/utils/{quad,modeSelection,pdfBytes,pdfWriter,scanFiles,appSettings,exportActions,backup}.ts
  ├─ src/database/scannerDB.ts   documents / pages / settings
  └─ src/native/ScannerNative.ts 类型化桥契约（与 Kotlin 一一对应）
        ↓ legacy ReactPackage（bridgeless interop）
Kotlin native/android/
  ScannerModule.kt   isReady / analyze / process / probe
  QuadDetect.kt      边界检测（Canny 自适应 + 轮廓 + 四边形校验 + cornerSubPix）+ 回退链
  DocPipeline.kt     warp + 光照摊平 + CLAHE + 降噪 + 锐化 + 提白 + 五种模式
  Metrics.kt         图像感知指标（Histogram 工具在这里）
  ExifOrientation.kt EXIF 朝向 + DPI
  PdfWriter 不在原生 —— PDF 由纯 JS 的 pdfBytes.ts 组装（可在 vitest 里逐字节断言）
```

**分层规矩**：原生只负责「量得准 + 画得对」，**判定表在 JS**（`modeSelection.ts`），因为阈值调整是产品决策，必须被单测钉住；
反过来，几何/像素重活不下放到 JS，全分辨率图不在 JS 里过。

---

## 关键技术决定（改动前先看懂为什么）

1. **智能高清 = 经典 CV 复现扫描全能王的可见行为**：自动切边 → 透视矫正 → 大核高斯估背景后除法归一（摊平光照/去阴影）→ CLAHE(clip 1.8, 8×8，只作用 Lab 的 L) → bilateral(5,35,35) → unsharp(σ1.2, 0.6) → 直方图 p2→0/p97→250 提白。
   **不做**：曲面矫正、透字去除、手指补图（要模型）。摩尔纹只判断不消除，判断到就避开降噪（bilateral 会放大屏纹）。
2. **黑白用 adaptiveThreshold 不用 Otsu**：这个模式的使用场景就是侧光/半边阴影，全局阈值必然一半糊黑一半全白。
3. **边界检测一定要返回四角**：检测失败退最小外接矩形，再退 3% 内缩框。用户永远能拖，不许出现「没检测到所以不能切边」的死路。
4. **四角顺序固定 TL→TR→BR→BL**（JS 与 Kotlin 各有一份 `orderCorners`，行为必须一致）：顺序错 = 透视变换把纸翻面，而「看起来还是一张纸」，是最难发现的一类 bug。
5. **PDF 直传 JPEG 字节（DCTDecode）**：不用 expo-print（WebView→位图，重编码 + 多页一次绘制会 OOM），也不用 `PdfDocument`（要解码成 Bitmap 画进 Canvas）。
6. **ABI 只 arm64-v8a**：`libopencv_java4.so` 实测 arm64 22.9MB / x86_64 56.5MB，两个都带 = 152MB 包；只 arm64 = 65.7MB。
   ABI 只能经 `reactNativeArchitectures` 改（RN 的 NdkConfigurator 已经把该属性灌进 `ndk.abiFilters`），**不要手写 abiFilters**。
7. **Mat 所有权**：`DocPipeline` 的增强子函数一律「消费输入 Mat」，所有中间 Mat 在 `finally` 里 release；图像任务进**单线程 Executor**（并发 1 就是 OOM 防线，4000×3000 一张 float Mat ≈ 46MB）。
8. **EXIF 朝向自己读自己转**：Android 相机普遍把像素按传感器方向写盘、用 EXIF 标记旋转，而 `imread` 是否替你旋转在不同版本上不可靠。不处理就会出 90° 歪的扫描件。
9. **进度事件被刻意去掉**：bridgeless 下 `DeviceEventEmitter` 在本系列项目里没有先例；单页处理只有 1.4~2s，用忙碌态 + 事后回报各阶段 `stages` 更稳。

---

## 本机（Windows）构建

```powershell
npx expo prebuild --platform android --no-install --clean    # 一律 --clean，避免 android/ 与 app.json 漂移
cd android; .\gradlew.bat assembleRelease --console=plain     # 首次约 7 分钟；改 Kotlin 后约 1~2 分钟
```

只验 Kotlin 是否编译（最快反馈，改算法时先用它）：

```powershell
cd android; .\gradlew.bat :app:compileReleaseKotlin --console=plain
```

模拟器包（AVD 是 x86_64）：

```powershell
$env:TAPSCANNER_EMULATOR_ABI='1'; npx expo prebuild --platform android --no-install --clean
```

## 发布

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release-app.ps1 -LocalOnly     # 只出包 + 本地提交
powershell -ExecutionPolicy Bypass -File scripts\release-app.ps1                # 配了远端才推 + 建 Release
```

脚本在**产物上**断言，不在配置上打日志：`aapt` 校验 versionName/versionCode/桌面显示名，`apksigner` 拒绝 `CN=Android Debug`，
解压 APK 确认 `lib/arm64-v8a/libopencv_java4.so` 存在且没有多余 ABI、没混进扫码库，`zipalign -c -P 16 -v 4` 校验 16KB 页对齐，
并检查 `native/android` 至少 7 个文件入库。产物名固定 `TapScanner-v<版本>.apk` 落项目根目录（不加时间戳/ABI 后缀）。

签名：`keystore.properties` + `keystore/tapscanner-release.keystore` **不入库**，已另存 `D:\V-Coding\backups\tapscanner-keystore\`。
丢失就无法给老用户推送升级（同包名不同签名会被系统拒绝安装）。

## 验证（改算法后必跑）

```powershell
npx vitest run        # 47 项：四角几何/letterbox/退化拦截、模式判定表每条分支、PDF 字节结构
npx tsc --noEmit
npx eslint .
npm run format:check
```

真机侧（我看不见屏幕，靠这两条拿证据）：

- 管理 → 关于与自检：显示 OpenCV 版本/ABI，并对最近一份文档的第一张 raw 跑一次 `probe`（解码→缩放→编码），回报尺寸与耗时。
- `process` 返回 `stages`（decode/warp/enhance/encode 各段毫秒）与 `metricsBefore/After`，写进 `pages.metrics`；
  慢机型一张截图就能自报。界面上的「清晰度 +N%」只在 `sharpnessGain > 1.05` 时出现。

必须真机才能定的事（别当成已验证）：各机型实际出图分辨率与对焦速度、光照复杂下的切边成功率、单页真实耗时、
黑白档在 Samsung 屏幕上读起来是「干净」还是「麻点」。

---

## 界面规范（Tap 系列一致性）

| 规则 | 原因 |
|------|------|
| 颜色/间距/圆角/字号只从 `src/constants/index.ts` 取 | 令牌是 TapMood→TapLedger→TapMate 一路抄过来的同一套（暖米白 #F8F6F3 / 靛蓝 #7986CB） |
| 卡片 = `surface` + `RADIUS.lg` + 1px `border`，**无阴影** | 阴影只给浮层（TabBar/Toast）；卡片套卡片会被判为「模板感」 |
| 图标一律 `react-native-svg` 手绘，**不用 emoji 当图标** | emoji 是廉价感的第一来源，且各 ROM 字形不统一；空状态保留 ✨ |
| 不用导航库：Tab 全挂载 + `display:'none'` 切换；二级页是**并列页** + `‹ 返回` | 与 TapLedger/TapMate 完全一致的行为与触摸体验 |
| **state 手管路由就必须自己接 `BackHandler`** | RN 默认「没有监听返回 true 就 exitApp」，Android 16 边缘手势一划直接退出 App。用 `src/hooks/useBackHandler.ts` |
| 不用透明 RNModal 当提示层 | `ReactModalHostView` 不加 `FLAG_NOT_TOUCHABLE`，Toast 显示期间整页点不动（TapLedger 用一轮重写换来的结论） |
| 绝不用 Modal 盖相机 | 相机是原生视图层，盖上去触摸与安全区行为会变；review/crop 都用 display 互斥 |
| 会改原生/存储状态的操作要有忙碌态并禁用按钮 | 重复点击会叠发多次原生调用 |
| 自动决策要能改 | 本 App 不出参数滑杆（v0.1 的取舍），但保留 5 档切换 + 手动四角 + 重拍 + 文档内换档作为出口；`pages.mode/quad` 可回写 |

中文文案：短句、软、不命令式。空状态 `还没有扫描的文档 ✨`；按钮 `保存文档 / 继续拍 / 调整四角 / 重拍 / 完成`。

---

## 目录约定

入库：`App.tsx index.ts app.json package.json tsconfig.json eslint.config.js .prettierrc .gitignore`
`AGENTS.md README.md CHANGELOG.md LICENSE plugins/ native/android/ src/ scripts/ tools/ assets/`

不入库（`.gitignore`）：`/android/`（**必须根锚定**）、`/ios/`、`node_modules/`、`.expo/`、`.gradle-cache/`、`*.apk`、
`keystore/`、`keystore.properties`、`qa-out/`

> ⚠️ `.gitignore` 写 `android/`（未锚定）会连 `native/android/` 一起忽略：prebuild --clean 后智能高清静默消失，
> 而 `git status` 干净得像没事发生。兄弟项目踩过，release-app.ps1 现在会拦住。

## 发布脚本踩过的两个坑（v0.1.1）

1. **aapt 的中文输出不能让 PowerShell 直接解码**：aapt 把资源字符串按 UTF-8 原样打到 stdout，PS 5.1 默认按控制台代码页(GBK)解码，中文被切坏 → 「桌面显示名不是扫描一下」的**假失败**，每次发布都被拦。现在改成：aapt 输出重定向到临时文件，再按 UTF-8 读回来比对。
2. **仓库需要本地 git 身份**：脚本用的是普通 `git commit`，而本仓库没设身份就报 `unable to auto-detect email address`。按兄弟项目做法在仓库本地设 `user.name=sctale` / `user.email=18475722+sctale@users.noreply.github.com`（**不动全局配置**）。

## 已知缺口 / 下一步

1. **实时取景边框（v0.2）**：VisionCamera v5 帧处理器要 Nitro spec + nitrogen codegen，是独立一轮风险；现在的替代是「拍完自动检测 + 手动四角」。
2. 文档详情页的「重拍某一页」（当前只能删了重扫整份）。
3. OCR（`com.google.mlkit:text-recognition-chinese:16.0.1` 已在 Google Maven 上确认可用，未接入）。
4. 图标仍是 TapLedger 占位图，需要生成 TapScanner 自己的（`scripts/generate-icons.ps1`）。
5. QA 台跑批（6 张固定样张 × 5 档 → `qa-out/` 指标表）尚未落地，`tools/scan-sample/` 目录是空的。

## GitHub

- 仓库：https://github.com/sctale/TapScanner （**当前尚未建远端，只本地 git**）
- Git 身份：`sctale / 18475722+sctale@users.noreply.github.com`
