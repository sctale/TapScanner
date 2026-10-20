# TapScanner · 扫描一下

极简文档扫描 App，对标扫描全能王，主打**智能高清**。所有扫描件只存在你手机里，不上传、不需要账号。

当前版本：0.1.1 · Android（Expo SDK 56 + 自研 OpenCV 原生模块）

## 下载与安装

在手机上打开 [Releases](https://github.com/sctale/TapScanner/releases) 里最新的 `TapScanner-v<版本>.apk`，安装时允许「来自未知来源的应用」。卸载即清空全部数据，没有云端残留。

## 智能高清到底做了什么

按下快门之后，这一页会依次经过：

1. **边界检测**：Canny 阈值按图中位数自适应 → 闭运算接起断口 → 轮廓 → 四边形拟合 → 凸性/面积/四角角度/最短边校验 → 亚像素精化。找不到纸边时退到最小外接矩形，再退到 3% 内缩框，**永远给你一个可调的四角**。
2. **梯形矫正**：透视变换拉正，输出按对边长保留真实长宽比，默认长边 3000px。
3. **光照摊平（去阴影）**：大核高斯估计背景后做除法归一，把纸面拉成均匀白，同时保留墨迹的局部对比。手影、侧光、渐变底色在这一层被吃掉。
4. **对比度增强**：CLAHE 只作用在 Lab 的亮度通道，所以彩色内容不会跑色。
5. **降噪与锐化**：bilateral 边缘保持降噪 + unsharp mask；纸面提白走直方图 p2→0 / p97→250，而不是加亮度。

五个档位：**智能高清 / 增强 / 灰度 / 黑白 / 原图**。黑白用自适应阈值（不是全局 Otsu），因为侧光下全局阈值必然一半糊黑、一半全白。

App 会读一遍这张图的亮度、对比度、饱和度、清晰度、阴影强度、屏纹强度，然后**默认选好档位并把理由写在界面上**——但自动值只是建议：当场能换档、能调四角、能重拍，事后还能在文档里换档（raw 原图一直保留，所以这些都是无损的）。

## 明确没做（不想让你从截图里才发现）

扫描全能王的曲面矫正、透字去除、手指区域补图依赖深度学习模型。本 App **不带模型**，因此：

- 曲面（摊不平的书本、卷起来的纸）不会自动展平；
- 背面透过来的字不会擦掉；
- 按在纸上的手指不会被修补。

「去阴影」是除法归一化近似，不是 GAN。「摩尔纹」只判断、不消除：判断到屏纹时会自动避开降噪档（bilateral 会把纹路放大）。

## 其它功能

多页成文档、页序调整、文档改名与收藏、从相册导入（走同一条增强管线）、导出 PDF（JPEG 原始字节直传，不重编码）、导出单页 JPG、系统分享面板、备份 JSON 导出/导入、存储占用与未引用文件清理、管理页内的图像引擎自检。

刻意没有的：OCR、云同步、水印、手写批注、证件模式、实时取景边框（v0.2）。

## 从源码构建

```powershell
npm install --legacy-peer-deps
powershell -ExecutionPolicy Bypass -File scripts\release-app.ps1 -LocalOnly
```

产物落在项目根目录 `TapScanner-v<版本>.apk`。发布脚本会在**产物上**做断言：`aapt` 校验版本号与桌面显示名、`apksigner` 拒绝 debug 签名、解压 APK 确认 `lib/arm64-v8a/libopencv_java4.so` 存在且没有多余 ABI、`zipalign -P 16` 校验 16KB 页对齐。任何一条不过就中止。

需要 keystore.properties 与 keystore/（不入库，丢失就无法给老用户推送升级，务必单独备份）。

## 包为什么比别的 Tap App 大

智能高清用的是 OpenCV 官方 Maven AAR。实测产物里 `libopencv_java4.so` 在 arm64 是 22.9MB、x86_64 是 56.5MB，所以发布包只带 arm64（约 70MB）。要给模拟器装，加 `-EmulatorAbi`。

## 技术栈

Expo SDK 56 / React Native 0.85.3 / React 19.2.3 / TypeScript 6 / VisionCamera 5（Nitro）/ OpenCV 4.13（Kotlin 原生模块，经 Config Plugin 注入）/ expo-sqlite。没有导航库，Tab 与二级页靠 state 切换。

## 许可

Apache-2.0。OpenCV 由 OpenCV.org 以 Apache-2.0 分发。
