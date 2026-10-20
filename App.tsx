import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { COLORS } from './src/constants';
import { initDatabase } from './src/database/scannerDB';
import { loadSettings } from './src/utils/appSettings';
import TabBar, { type TabKey } from './src/components/TabBar';
import Toast from './src/components/Toast';
import ScanScreen from './src/screens/ScanScreen';
import DocumentsScreen from './src/screens/DocumentsScreen';
import ManageScreen from './src/screens/ManageScreen';

/**
 * 根：保持所有 Tab 挂载、只切显隐（沿用 TapLedger —— 切页不重查库、相机不重开会话）。
 *
 * 返回键层级：各屏的二级页（review/crop/详情/管理二级页）自己注册监听并吃掉返回；
 * 没吃掉时这里才把 Tab 收回「扫描」；已经在扫描页且没有二级页时不拦，让系统退出 App。
 */
export default function App() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<TabKey>('scan');
  const tabRef = useRef(tab);
  tabRef.current = tab;

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
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      // 只有「不在扫描页」时才拦下来回到扫描；在扫描页说明没人要这次返回，交给系统
      if (tabRef.current !== 'scan') {
        setTab('scan');
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, []);

  const onTabChange = useCallback((next: TabKey) => setTab(next), []);

  if (!ready) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={COLORS.accent} />
      </View>
    );
  }

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
            <DocumentsScreen active={tab === 'documents'} />
          </View>
          <View style={[styles.page, tab !== 'manage' && styles.pageHidden]}>
            <ManageScreen />
          </View>
        </View>
        <TabBar current={tab} onChange={onTabChange} />
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
