/**
 * Expo Config Plugin：TapScanner 原生扫描模块注入
 *
 * 做四件事，全部幂等（可反复 prebuild --clean）：
 *   1. 把 native/android/*.kt 真源复制进生成的 android 工程，并重写 package 行
 *   2. 往 app/build.gradle 注入 OpenCV 官方 Maven AAR 依赖
 *   3. 限制 ABI（OpenCV 的 .so 按 ABI 体积差异极大：arm64 9.1MB、x86_64 23.3MB、
 *      x86 16.5MB、armeabi-v7a 7.5MB；只留真机 arm64 + 模拟器 x86_64）
 *   4. 声明相机权限与 ScannerPackage 注册
 *
 * 借鉴 anti-car-sickness/plugins/withOverlayModule.js 的注入/清理实现，
 * 以及 TapLedger/plugins/withReleaseSigning.js 的 MUST() 断言风格：
 * **任何一处注入失败都必须当场炸掉 prebuild**，而不是产出一个「构建成功但功能没了」的包。
 */
const fs = require('fs');
const path = require('path');
const {
  withDangerousMod,
  withAndroidManifest,
  withMainApplication,
  withGradleProperties,
  withAppBuildGradle,
} = require('@expo/config-plugins');

const OPENCV_COORD = 'org.opencv:opencv:4.13.0';
const OPENCV_DEPENDENCY = `    implementation("${OPENCV_COORD}") // TapScanner: 智能高清（OpenCV 官方 Maven Central AAR，无需 NDK 编译）`;

/** 记录「本插件注入过哪些 .kt」的清单文件名，放在原生包目录下 */
const INJECTED_MANIFEST = '.scanner-injected.json';

/** 清单机制引入之前本插件注入过的历史文件名（防止删掉的类残留导致 Kotlin 编译失败） */
const LEGACY_INJECTED_FILES = [];

/**
 * 发布 ABI：只留真机的 arm64-v8a。
 *
 * 实测数字（打开产物断言出来的，不是估算）：OpenCV 4.13 的 libopencv_java4.so
 * arm64-v8a 解压 22.9MB、x86_64 56.5MB，APK 里按未压缩对齐存放，
 * 两个都带上是 152MB。所以发布包只 arm64（约 70MB）。
 *
 * 要给 x86_64 模拟器装包时，prebuild 前设一个环境变量即可（构建命令不用改）：
 *   $env:TAPSCANNER_EMULATOR_ABI='1'; npx expo prebuild --platform android --no-install --clean
 */
const RELEASE_ABIS = 'arm64-v8a';
const EMULATOR_ABIS = 'arm64-v8a,x86_64';

function resolvePackage(config) {
  const pkg = config.android?.package || 'com.tapscanner.app';
  return { name: pkg, segments: pkg.split('.') };
}

/** 断言「内容确实被改了」——模板一变导致 replace 匹配不到时，必须炸而不是静默跳过 */
const MUST = (contents, before, pattern, replacement, what) => {
  const next = contents.replace(pattern, replacement);
  if (next === before) {
    throw new Error(
      `[withScannerModule] ${what} 注入失败——生成的 build.gradle 模板与本插件预期不一致，` +
        `请同步更新插件里的匹配规则（绝不能带着缺 OpenCV 依赖的包发布，那等于装上就崩）。`
    );
  }
  return next;
};

/**
 * 1) native/android/*.kt → android/app/src/main/java/<package 路径>/，重写 package 行；
 * 2) 清理上一次注入、本次源码集里已不存在的同名文件；
 * 3) Expo 模板自带的 MainActivity / MainApplication 不在清单里，永不误删。
 */
function withScannerKotlinSources(config) {
  const { name: packageName, segments } = resolvePackage(config);

  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const sourceDir = path.join(projectRoot, 'native', 'android');
      const destDir = path.join(
        projectRoot,
        'android',
        'app',
        'src',
        'main',
        'java',
        ...segments
      );

      if (!fs.existsSync(sourceDir)) {
        throw new Error(`[withScannerModule] 未找到原生源码目录: ${sourceDir}`);
      }
      const files = (await fs.promises.readdir(sourceDir)).filter((f) => f.endsWith('.kt'));
      if (files.length === 0) {
        throw new Error(
          `[withScannerModule] ${sourceDir} 里没有任何 .kt —— 原生模块真源丢失了（` +
            `检查 .gitignore 是否把 native/android 也忽略了，必须是根锚定的 /android/）。`
        );
      }

      await fs.promises.mkdir(destDir, { recursive: true });

      // 清理陈旧注入文件
      const manifestPath = path.join(destDir, INJECTED_MANIFEST);
      let previous = [];
      try {
        previous = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      } catch {
        previous = [];
      }
      const current = new Set(files);
      const staleCandidates = new Set([
        ...(Array.isArray(previous) ? previous : []),
        ...LEGACY_INJECTED_FILES,
      ]);
      for (const stale of staleCandidates) {
        if (!stale.endsWith('.kt') || current.has(stale)) continue;
        const target = path.join(destDir, stale);
        if (!fs.existsSync(target)) continue; // 不存在就别谎报「已清理」
        try {
          await fs.promises.rm(target, { force: true });
          console.log(`[withScannerModule] 已清理陈旧原生文件: ${stale}`);
        } catch (e) {
          console.warn(`[withScannerModule] 清理陈旧文件 ${stale} 失败: ${e.message}`);
        }
      }

      await Promise.all(
        files.map(async (file) => {
          const raw = await fs.promises.readFile(path.join(sourceDir, file), 'utf8');
          const rewritten = raw.replace(/^package\s+[A-Za-z0-9_.]+/m, `package ${packageName}`);
          await fs.promises.writeFile(path.join(destDir, file), rewritten);
        })
      );

      await fs.promises.writeFile(manifestPath, JSON.stringify(files, null, 2) + '\n');
      console.log(`[withScannerModule] 注入 ${files.length} 个原生源文件 → ${packageName}`);
      return cfg;
    },
  ]);
}

/** app/build.gradle 注入 OpenCV 依赖（幂等 + MUST 断言） */
function withScannerGradleDependency(config) {
  return withAppBuildGradle(config, (cfg) => {
    let contents = cfg.modResults?.contents;
    if (!contents) {
      throw new Error('[withScannerModule] 无法读取 app/build.gradle 内容');
    }
    if (!contents.includes(OPENCV_COORD)) {
      contents = MUST(
        contents,
        contents,
        /(dependencies \{)(\r?\n)/,
        `$1$2${OPENCV_DEPENDENCY}$2`,
        `OpenCV 依赖（${OPENCV_COORD}）`
      );
      console.log(`[withScannerModule] 已注入依赖 ${OPENCV_COORD}`);
    }
    cfg.modResults.contents = contents;
    return cfg;
  });
}

/**
 * gradle.properties：ABI 限制 + 本机（Windows）构建规避项。
 *
 * ABI 不能手写 android.ndk.abiFilters —— RN 的 NdkConfigurator 已经在往
 * defaultConfig.ndk.abiFilters 里灌 reactNativeArchitectures，唯一正确入口就是这个属性。
 * kotlin.daemon.enabled=false 与项目内 projectcachedir 是本机实测必需（提权环境 + 121MB AAR
 * 不该落 C 盘），放进插件后 prebuild --clean 也不会丢。
 */
function withScannerGradleProperties(config) {
  return withGradleProperties(config, (cfg) => {
    const items = cfg.modResults;
    const setProperty = (key, value) => {
      const existing = items.find((item) => item.type === 'property' && item.key === key);
      if (existing) {
        existing.value = String(value);
      } else {
        items.push({ type: 'property', key, value: String(value) });
      }
    };

    const abis = process.env.TAPSCANNER_EMULATOR_ABI === '1' ? EMULATOR_ABIS : RELEASE_ABIS;
    setProperty('reactNativeArchitectures', abis);
    console.log(`[withScannerModule] reactNativeArchitectures=${abis}`);
    setProperty('kotlin.daemon.enabled', 'false');
    setProperty(
      'org.gradle.projectcachedir',
      path.join(cfg.modRequest.projectRoot, '.gradle-cache').split(path.sep).join('/')
    );

    return cfg;
  });
}

/** AndroidManifest：相机权限 + largeHeap（4000×3000 编解码兜底） */
function withScannerManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    manifest['uses-feature'] = manifest['uses-feature'] || [];

    const hasPermission = (name) =>
      manifest['uses-permission'].some((p) => p?.$?.['android:name'] === name);

    if (!hasPermission('android.permission.CAMERA')) {
      manifest['uses-permission'].push({
        $: { 'android:name': 'android.permission.CAMERA' },
      });
    }

    const hasFeature = (name) =>
      manifest['uses-feature'].some((f) => f?.$?.['android:name'] === name);
    if (!hasFeature('android.hardware.camera')) {
      manifest['uses-feature'].push({
        $: {
          'android:name': 'android.hardware.camera',
          'android:required': 'false',
        },
      });
    }

    const application = manifest.application?.[0];
    if (application) {
      // 全分辨率 JPEG 解码 + 多张中间 Mat 的兜底；真正的防线是原生侧单线程 + 及时 release
      application.$['android:largeHeap'] = 'true';
    }
    return cfg;
  });
}

/** MainApplication.kt 注册 ScannerPackage */
function withScannerPackage(config) {
  const { name: packageName } = resolvePackage(config);

  return withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;
    let changed = false;

    if (!contents.includes('ScannerPackage()')) {
      const ownPackageMatch = contents.match(/^package\s+([A-Za-z0-9_.]+)/m);
      const ownPackage = ownPackageMatch ? ownPackageMatch[1] : null;
      if (ownPackage !== packageName && !contents.includes(`import ${packageName}.ScannerPackage`)) {
        contents = contents.replace(
          /(^package [^\n]+\n)/m,
          `$1\nimport ${packageName}.ScannerPackage\n`
        );
      }

      const applyPattern = /(PackageList\(this\)\.packages\.apply\s*\{)/;
      if (applyPattern.test(contents)) {
        contents = contents.replace(applyPattern, `$1\n          add(ScannerPackage())`);
      } else {
        const listPattern = /(PackageList\(this\)\.packages)(?!\s*\.apply)/;
        if (listPattern.test(contents)) {
          contents = contents.replace(
            listPattern,
            'PackageList(this).packages.toMutableList().apply { add(ScannerPackage()) }'
          );
        } else {
          throw new Error(
            '[withScannerModule] 未能在 MainApplication.kt 中找到 getPackages()/PackageList，' +
              '原生模块不会被注册——请检查 Expo 模板版本，不要带着没注册的模块发布。'
          );
        }
      }
      changed = true;
      console.log('[withScannerModule] 已注册 ScannerPackage');
    }

    if (changed) {
      cfg.modResults.contents = contents;
    }
    return cfg;
  });
}

module.exports = function withScannerModule(config) {
  config = withScannerKotlinSources(config);
  config = withScannerGradleDependency(config);
  config = withScannerGradleProperties(config);
  config = withScannerManifest(config);
  config = withScannerPackage(config);
  return config;
};
