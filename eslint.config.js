// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier/flat');

module.exports = defineConfig([
  {
    ignores: [
      'node_modules/**',
      '.expo/**',
      'android/**',
      'ios/**',
      'dist/**',
      'qa-out/**',
      'coverage/**',
    ],
  },
  expoConfig,
  prettierConfig,
  {
    rules: {
      // 项目沿用 JSX runtime，允许按需/统一引入 React
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',
      // 扫描流程里对返回 Promise 的落库/原生调用多为 fire-and-forget
      'no-floating-promises': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      // 本 app 在 effect 里加载 SQLite 数据 / 订阅 DeviceEventEmitter（原生进度事件），
      // 载入函数为 async、setState 发生在回调中——这是刻意且正确的模式
      'react-hooks/set-state-in-effect': 'off',
      // 用 useRef(...).current 拿稳定 Animated.Value、把手势回调存 ref 的经典 RN 写法
      'react-hooks/refs': 'off',
      // 相机/处理状态依赖里刻意只依赖 [active] 等，exhaustive-deps 降为提醒
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Expo config plugin 与发布脚本同样是 Node 侧 CommonJS（__dirname / require / module）
    files: ['plugins/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        require: 'readonly',
        module: 'writable',
      },
    },
  },
]);
