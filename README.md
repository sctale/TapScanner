# 扫描一下 TapScanner

一款主打"**智能高清**"的极简文档扫描应用，延续 [TapLedger（一点账本）](https://github.com/sctale/TapLedger) / [TapMood（一点心情）](https://github.com/sctale/TapMood) 的暖色治愈设计风格。

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

## 设计理念

> **拍一下就是一张干净的扫描件**：不用找角度、不用躲灯光、不用先擦阴影。

- 暖米白背景 + 柔和靛蓝强调色，大留白、圆角卡片、阴影只给浮层
- 隐私优先：**无账号、无网络请求、无统计**，图片与记录全部存在手机应用目录里，卸载即清空
- 自动决策只是建议：档位随时能换、四角随时能改、拍坏能重拍、事后能在文档里重新出一版

## 功能特性

- **智能高清**：自动切边 + 梯形矫正 + 光照/阴影摊平 + 对比度增强 + 纸面提白 + 降噪锐化，一键完成
- **场景化决策**：先量这张图的亮度、对比度、饱和度、清晰度、阴影强度、屏纹强度，再决定默认档位，并把**理由写在界面上**（不是黑箱）
- **五个档位**：智能高清 / 增强 / 灰度 / 黑白 / 原图；黑白用自适应阈值，侧光下不会一半糊黑一半全白
- **手动四角**：并列页拖四个角；自动检测失败时也有回退框，绝不出现"没法切边"的死路
- **多页成文档**：页序上下移动、改名、收藏、删除；文档列表按更新时间/收藏排序
- **相册导入**：相册里的旧照片走同一条增强管线
- **导出 PDF**：JPEG 原始字节以 DCTDecode **直传**进 PDF，零重编码，画质不掉档
- **导出单页 JPG / 系统分享**：走系统面板，可存文件、发微信、发邮件
- **备份**：JSON 导出/导入，导入时逐份校验图片是否还在本机，缺图片的整份跳过（不产出"打不开的记录"）
- **存储管理**：占用统计 + 未引用目录清理（中途放弃的扫描组会留下空目录）
- **自检**：管理页显示 OpenCV 版本/ABI，并对真实图片跑一次解码-缩放-编码探针；失败时屏幕上留下完整错误现场（环节 + 错误码 + 原生 message + stack），连不上 adb 也能靠一张截图定位

## 智能高清到底做了什么

按下快门之后，这一页依次经过：

1. **边界检测**：Canny 阈值按图中位数自适应 → 闭运算接起断口 → 外轮廓 → 多边形拟合 → 四边形校验（凸性 / 面积占比 / 四角角度 / 最短边）→ 亚像素精化。找不到纸边时退到最小外接矩形，再退到 3% 内缩框。
2. **梯形矫正**：透视变换拉正，目标尺寸取对边较长者、保留真实长宽比，默认长边 3000px。
3. **光照摊平（去阴影）**：大核高斯估计背景后做除法归一，把纸面拉成均匀白，同时保留墨迹的局部对比。手影、侧光、渐变底色在这一层被吃掉。
4. **对比度增强**：CLAHE 只作用在 Lab 的亮度通道，所以彩色内容不会跑色。
5. **降噪与锐化**：bilateral 边缘保持降噪 + unsharp mask；纸面提白走直方图 p2→0 / p97→250，而不是加亮度。

### 明确没做（不想让你从截图里才发现）

扫描全能王的曲面矫正、透字去除、手指区域补图依赖深度学习模型。**本 App 不带模型**，因此：

- 曲面（摊不平的书本、卷起来的纸）不会自动展平
- 背面透过来的字不会擦掉
- 按在纸上的手指不会被修补

"去阴影"是除法归一化（Retinex 摊平）近似，不是 GAN；摩尔纹**只判断、不消除**——判断到屏纹时会自动避开降噪档，因为 bilateral 会把纹路放大。

## 技术栈

- React Native + Expo SDK 56 + TypeScript（strict），**无导航库**（Tab 全挂载 + `display` 互斥切换，二级页是并列页）
- 相机：[react-native-vision-camera](https://github.com/mrousavy/react-native-vision-camera) 5.2.3（+ `react-native-nitro-modules` / `react-native-nitro-image`）
- 图像层：**Kotlin 原生模块 + [OpenCV](https://opencv.org/) 4.13**（`org.opencv:opencv`，Maven Central 官方 AAR，无需 NDK 编译），经 Expo Config Plugin 注入
- 存储：`expo-sqlite`（记录）+ `expo-file-system`（图片文件）+ `expo-sharing`（导出）
- PDF：自写最小 PDF 组装器（`src/utils/pdfBytes.ts`，纯函数，可在 Node 里逐字节断言）

原生源码在 `native/android/`，由 `plugins/withScannerModule.js` 在 prebuild 时注入 `android/`（`android/` 不入库）。

## 包为什么比别的 Tap App 大

智能高清用的 OpenCV 官方 AAR 里，`libopencv_java4.so` 实测 arm64-v8a 是 22.9MB、x86_64 是 56.5MB，APK 内按未压缩对齐存放。所以**发布包只带 arm64-v8a**（约 63MB）；两个 ABI 都带会是 152MB。需要给 x86_64 模拟器装包时用 `release-app.ps1 -EmulatorAbi`。

## 安装

到 [Releases](https://github.com/sctale/TapScanner/releases) 下载最新的 `TapScanner-v<版本>.apk` 安装（需要允许"来自未知来源的应用"）。卸载即清空全部数据。

## 构建与发布

**发布流程：全部本地构建**，不使用 GitHub Actions。

```powershell
npm install --legacy-peer-deps
powershell -ExecutionPolicy Bypass -File scripts\release-app.ps1 -LocalOnly   # 只出包 + 本地提交
powershell -ExecutionPolicy Bypass -File scripts\release-app.ps1              # 配了远端则一并推送并建 Release
```

脚本的门禁全部打在**产物**上，不在配置上打日志：

1. CHANGELOG 必须有目标版本条目；`native/android/` 至少 7 个文件已入库（`.gitignore` 未锚定 `android/` 会静默吞掉原生源码）
2. `vitest` + `tsc` + `eslint` + `prettier --check`
3. `prebuild --clean` 后断言签名注入片段、OpenCV 依赖、ABI 限制都真的写进了 gradle 文件
4. `gradlew assembleRelease` → `aapt` 校验 versionName / versionCode / **桌面显示名**
5. 解压 APK 断言 `lib/arm64-v8a/libopencv_java4.so` 存在、没有多余 ABI、没混进扫码库
6. `apksigner` 拒绝 `CN=Android Debug` 签名；`zipalign -c -P 16` 校验 16KB 页对齐
7. 复制为根目录 `TapScanner-vX.Y.Z.apk` → git 提交推送 → `gh release create`（说明取自 CHANGELOG）

> **签名前置**：release 包用私有 keystore 签名。需要 `keystore/tapscanner-release.keystore` 与根目录 `keystore.properties`（均不入库，`.gitignore` 已排除），`plugins/withReleaseSigning.js` 会在 prebuild 时注入签名配置。丢失 keystore 将无法给老用户推送升级，务必异地备份。

手动构建（调试用）：

```powershell
npx expo prebuild --platform android --no-install --clean
cd android; .\gradlew.bat assembleRelease
# 输出：android\app\build\outputs\apk\release\app-release.apk
```

## 项目结构

```
App.tsx                     根：Tab 全挂载 + display 互斥；返回键层级
index.ts
src/
├── screens/
│   ├── ScanScreen.tsx           扫描（首页即相机；camera / review / crop 三态并列页）
│   ├── DocumentsScreen.tsx      文档列表（卡片栅格 + 长按删除）
│   ├── DocDetailScreen.tsx      文档详情（页序、换档、导出、改名、删除）
│   └── ManageScreen.tsx         管理（默认档位 / 自动切边 / 分辨率 / 存储 / 备份 / 关于与自检）
├── components/
│   ├── TabBar.tsx               底部导航（手绘 SVG 图标，不用 emoji）
│   ├── Toast.tsx                轻提示（全局单例，非模态浮层）
│   ├── Modal.tsx                全屏表单（内含 Toast 层）
│   ├── CornerAdjust.tsx         四角调整（PanResponder + SVG 多边形）
│   └── FilterChips.tsx          档位选择条
├── database/scannerDB.ts        SQLite：documents / pages / settings + 幂等补列
├── native/ScannerNative.ts      与 Kotlin 一一对应的类型化桥契约
├── hooks/useBackHandler.ts      没有导航库就必须自己接返回键
├── constants/index.ts           设计令牌（配色/间距/圆角/字号/档位/事件/设置 key）
├── types/index.ts
└── utils/
    ├── scanPipeline.ts          拍摄 → 搬文件 → 感知 → 出成品 → 落库（编排唯一入口）
    ├── quad.ts                  四角几何：排序 / 面积 / 退化判定 / letterbox 换算
    ├── modeSelection.ts         场景化决策表（阈值调整是产品决策，有单测钉住）
    ├── pdfBytes.ts              纯字节 PDF 组装（DCTDecode 直传）
    ├── pdfWriter.ts             PDF 的文件层
    ├── filePaths.ts             路径两种形态：给原生的裸路径 / 给 expo 的 URI
    ├── scanFiles.ts             落盘规则（目录结构、搬运、删除、占用统计）
    ├── appSettings.ts           偏好（存 SQLite settings 表）
    ├── exportActions.ts         导出与分享
    ├── backup.ts                JSON 备份导出/导入
    └── diagnostics.ts           错误现场留存（屏幕常驻卡片 + 落盘）
native/android/              Kotlin 真源（prebuild 时由 Config Plugin 注入）
├── ScannerModule.kt              isReady / analyze / process / probe
├── QuadDetect.kt                 边界检测 + 回退链
├── DocPipeline.kt                矫正 + 摊平光照 + CLAHE + 降噪 + 锐化 + 提白 + 五档
├── Metrics.kt                    图像感知指标 + 直方图工具
├── ExifOrientation.kt            EXIF 朝向与 DPI
└── ScanErrors.kt                 错误码唯一真源
plugins/
├── withScannerModule.js          注入原生源码 / OpenCV 依赖 / ABI / 清单 / Package
├── withVersionSync.js            versionCode = major*10000 + minor*100 + patch
└── withReleaseSigning.js         私有 release 签名（缺 keystore 时告警，发布模式直接失败）
scripts/
├── release-app.ps1               一键发布（门禁 → 构建 → 产物断言 → 提交 → Release）
├── publish-github.ps1            建远端仓库 + 推送 + 发布 Release（可单独跑）
└── sync-version.js               版本号单一来源同步
src/utils/__tests__/         vitest 单测（四角几何、决策表、PDF 字节结构、路径形态）
```

## 测试

```powershell
npx vitest run      # 57 项
```

覆盖的都是"错了会在真机上难查"的那类：四角排序与归一化往返、letterbox 换算偏移、退化框拦截、模式判定表的每条分支与优先级、PDF 每个 xref 偏移必须真的落在 `N 0 obj` 上、DCTDecode 的 `/Length` 必须等于 JPEG 实际字节数、以及路径两种形态的互转（v0.1.0 真机首拍必崩就是它）。

## 设计令牌（与 Tap 系列同源）

| Token | 值 | 说明 |
|---|---|---|
| 背景 | `#F8F6F3` | 暖米白 |
| 卡片 | `#FFFFFF` / `#FFF9F5` | 白 / 暖色卡片底 |
| 主文字 | `#2D2D2D` / `#6E6E6E` / `#857F78` | 深灰 / 次级 / 三级 |
| 强调色 | `#7986CB` / `#5C6BC0` | 柔和靛蓝 |
| 取景层 | `#1C1A18` + 半透明白 | 相机页专用（深色底，状态栏文字反过来） |
| 边框 | `#F0EDE8` / `#E8E4DE` | 卡片 1px 边框，**不加阴影** |
| 圆角 | 8 / 12 / 16 / 20 / 24 / 胶囊 | 统一令牌 |
| 间距 | 4 / 8 / 16 / 24 / 32 / 48 | 大留白风格 |

## 版本

当前版本：0.2.0

## 开源许可

本项目采用 **Apache License 2.0** 开源，全文见 [LICENSE](./LICENSE)，附属声明见 [NOTICE](./NOTICE)。

```
Copyright 2026 sctale

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

简单说：你可以自由使用、修改、分发本代码（含商业用途），但需保留 LICENSE 与版权声明，修改过的文件需注明改动；Apache-2.0 同时包含专利授权条款。

> 本仓库自身代码不含第三方 GPL/AGPL 组件。发布的 APK 会链接 **OpenCV**（BSD-3-Clause / Apache-2.0 双许可，见 [opencv.org](https://opencv.org/)）与 **react-native-vision-camera**（MIT）等依赖，各依赖遵循其原始许可证；npm 依赖的许可见各自 `license` 字段。
