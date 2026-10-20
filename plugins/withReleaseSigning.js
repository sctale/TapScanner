const fs = require('fs');
const path = require('path');
const { withAppBuildGradle } = require('expo/config-plugins');

// ===== 私有 release 签名注入（从 TapLedger 沿用到 TapScanner）=====
// 背景：prebuild 生成的 build.gradle 默认让 release 用 debug keystore 签名，
// 而 debug key 是公开已知的——他人可用同包名恶意 APK 覆盖安装用户设备。
// 本插件在 prebuild 时把 release 签名改为读取根目录 keystore.properties（不入库）。
//
// 三处文本注入都断言「确实改动了内容」（MUST）。此前只要 Expo 模板挪动一下缩进，
// .replace() 就匹配不到、静默不注入，release 包照常构建成功但仍是 debug 签名。
// keystore.properties 缺失时：开发默认沿用 debug 并大声告警；
// 设了 TAPSCANNER_REQUIRE_RELEASE_SIGNING=1（发布脚本会设）则直接报错终止构建。

const MUST = (contents, before, pattern, replacement, what) => {
  const next = contents.replace(pattern, replacement);
  if (next === before) {
    throw new Error(
      `withReleaseSigning: ${what} 注入失败——build.gradle 模板与本插件预期不一致，` +
        `请同步更新插件里的匹配规则（绝不能带着 debug 签名发 release）。`
    );
  }
  return next;
};

const PROPS_LOADER = `
// TapScanner: release 签名配置（由 plugins/withReleaseSigning.js 注入，勿手改）
def tapscannerKeystorePropsFile = rootProject.file('../keystore.properties')
def tapscannerKeystoreProps = new Properties()
if (tapscannerKeystorePropsFile.exists()) {
    tapscannerKeystorePropsFile.withInputStream { tapscannerKeystoreProps.load(it) }
}
`;

const RELEASE_SIGNING_CONFIG = `
        if (tapscannerKeystorePropsFile.exists()) {
            release {
                storeFile file(tapscannerKeystoreProps.getProperty('storeFile'))
                storePassword tapscannerKeystoreProps.getProperty('storePassword')
                keyAlias tapscannerKeystoreProps.getProperty('keyAlias')
                keyPassword tapscannerKeystoreProps.getProperty('keyPassword')
            }
        }`;

// 读取并校验 keystore.properties 的四个必填键（路径相对项目根目录）
function readSigningProps(projectRoot) {
  const propsFile = path.join(projectRoot, 'keystore.properties');
  if (!fs.existsSync(propsFile)) return null;
  const text = fs.readFileSync(propsFile, 'utf8');
  const props = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z]+)\s*=\s*(.*)$/);
    if (m) props[m[1]] = m[2].trim();
  }
  const missing = ['storeFile', 'storePassword', 'keyAlias', 'keyPassword'].filter(
    (k) => !props[k]
  );
  if (missing.length > 0) {
    throw new Error(`withReleaseSigning: keystore.properties 缺少 ${missing.join(', ')}`);
  }
  // storeFile 是相对 android/app 的路径，解析后确认密钥库文件真的存在
  const storePath = path.resolve(projectRoot, 'android', 'app', props.storeFile);
  if (!fs.existsSync(storePath)) {
    throw new Error(
      `withReleaseSigning: keystore.properties 指向的密钥库不存在：${storePath}` +
        `（丢失 keystore 将无法给老用户推送升级，请先从备份恢复）`
    );
  }
  return props;
}

module.exports = function withReleaseSigning(config) {
  const projectRoot = path.resolve(__dirname, '..');
  const requireSigning = process.env.TAPSCANNER_REQUIRE_RELEASE_SIGNING === '1';
  const props = readSigningProps(projectRoot);

  if (!props) {
    const message =
      'withReleaseSigning: 未找到 keystore.properties —— release 将回落到 debug 签名。' +
      ' 开发可以这样，但这个包绝对不能发布（同包名可被覆盖安装）。' +
      ' 发布请设 TAPSCANNER_REQUIRE_RELEASE_SIGNING=1（scripts/release-app.ps1 会自动设置）。';
    if (requireSigning) throw new Error(message);
    console.warn(
      `\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n!! ${message}\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`
    );
  }

  return withAppBuildGradle(config, (cfg) => {
    let contents = cfg.modResults.contents;

    // 幂等：已注入过则跳过（prebuild --clean 重跑时防重复）
    if (!contents.includes('tapscannerKeystorePropsFile')) {
      // 1) android { 之前插入 properties 加载器
      contents = MUST(
        contents,
        contents,
        /\r?\nandroid \{/,
        `${PROPS_LOADER}\nandroid {`,
        'keystore.properties 加载器'
      );

      // 2) signingConfigs 块内追加 release 配置（debug 块之后、闭合括号之前）
      const before2 = contents;
      contents = MUST(
        contents,
        before2,
        /(signingConfigs \{)([\s\S]*?)(\r?\n    \})/,
        `$1$2${RELEASE_SIGNING_CONFIG}$3`,
        'signingConfigs.release 块'
      );

      // 3) release buildType 的签名从 debug 切到私有 key（缺配置时回落 debug）
      contents = MUST(
        contents,
        contents,
        /signingConfig signingConfigs\.debug(\s*\r?\n\s*def enableShrinkResources)/,
        'signingConfig tapscannerKeystorePropsFile.exists() ? signingConfigs.release : signingConfigs.debug$1',
        'release buildType 签名切换'
      );
    }

    cfg.modResults.contents = contents;
    return cfg;
  });
};
