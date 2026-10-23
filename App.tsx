import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { COLORS, SETTING_KEYS } from './src/constants';
import { getSetting, initDatabase } from './src/database/scannerDB';
import { loadSettings } from './src/utils/appSettings';
import TabBar, { type TabKey } from './src/components/TabBar';
import Toast from './src/components/Toast';
import Onboarding from './src/components/Onboarding';
import ScanScreen from './src/screens/ScanScreen';
import DocumentsScreen from './src/screens/DocumentsScreen';
import ManageScreen from './src/screens/ManageScreen';

/**
 * 根：保持所有 Tab 挂载、只切显隐（沿用 TapLedger —— 切页不重查库、相机不重开会话）。
 *
 * 返回键层级（v0.2 理顺，走查 audit-19）：
 * RN 的 BackHandler 是**按注册逆序**回调的，而子组件的 effect 比父组件早跑，
 * 所以这里注册的监听其实是最先被调用的。以前它「只要不在扫描页就吃掉返回」，
 * 于是管理/详情停在二级页时，按返回会先跳回扫描 Tab，把二级页留在背后 ——
 * 现在 App 在「当前 Tab 有二级页」时明确不接（return false），让给那一层自己处理；
 * 二级页还顺带把 TabBar 藏起来，层级感和返回行为对齐。
 */
export default function App() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<TabKey>('scan');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [subOpen, setSubOpen] = useState({ documents: false, manage: false });
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const subOpenRef = useRef(subOpen);
  subOpenRef.current = subOpen;

  useEffect(() => {
    (async () => {
      try {
        await initDatabase();
      } catch {
        // 初始化失败也放行：各页自己兜底为空态，至少不会白屏
      }
      try {
        await loadSettings();
      } catch {
        // 用默认值
      }
      try {
        const onboarded = await getSetting(SETTING_KEYS.ONBOARDED_AT);
        setShowOnboarding(onboarded === null);
      } catch {
        setShowOnboarding(false);
      }
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const deep = tabRef.current === 'documents' ? subOpenRef.current.documents : subOpenRef.current.manage;
      // 当前 Tab 里有二级页：把这次返回让给那一层（它自己注册了监听），不能直接跳回扫描
      if (deep) return false;
      // 不在扫描页就先回扫描；已经在扫描页说明没人要这次返回，交给系统退出
      if (tabRef.current !== 'scan') {
        setTab('scan');
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, []);

  const onTabChange = useCallback((next: TabKey) => setTab(next), []);
  const goScan = useCallback(() => setTab('scan'), []);
  const onDetailOpen = useCallback((open: boolean) => setSubOpen((s) => ({ ...s, documents: open })), []);
  const onManageSubOpen = useCallback((open: boolean) => setSubOpen((s) => ({ ...s, manage: open })), []);

  if (!ready) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={COLORS.accent} />
      </View>
    );
  }

  if (showOnboarding) {
    return (
      <SafeAreaProvider>
        <View style={styles.container}>
          <StatusBar style="dark" />
          <Onboarding onDone={() => setShowOnboarding(false)} />
          <Toast />
        </View>
      </SafeAreaProvider>
    );
  }

  const hideTabBar = (tab === 'documents' && subOpen.documents) || (tab === 'manage' && subOpen.manage);

  return (
    <SafeAreaProvider>
      <View style={styles.container}>
        {/* 相机/四角调整是深色底，状态栏文字反过来；其余页面是暖白底 */}
        <StatusBar style={tab === 'scan' ? 'light' : 'dark'} />
        <View style={styles.screen}>
          <View style={[styles.page, tab !== 'scan' && styles.pageHidden]}>
            <ScanScreen active={tab === 'scan'} />
          </View>
          <View style={[styles.page, tab !== 'documents' && styles.pageHidden]}>
            <DocumentsScreen active={tab === 'documents'} onGoScan={goScan} onDetailOpen={onDetailOpen} />
          </View>
          <View style={[styles.page, tab !== 'manage' && styles.pageHidden]}>
            <ManageScreen active={tab === 'manage'} onSubOpenChange={onManageSubOpen} />
          </View>
        </View>
        {hideTabBar ? null : <TabBar current={tab} onChange={onTabChange} />}
        {/* 全局唯一提示层：非模态浮层，显示期间页面照常可点 */}
        <Toast />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.background,
  },
  container: { flex: 1, backgroundColor: COLORS.background },
  screen: { flex: 1 },
  page: { flex: 1 },
  pageHidden: { display: 'none' },
});
