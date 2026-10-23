import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, FONT_SIZE, RADIUS, SPACING } from '../constants';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastState {
  visible: boolean;
  message: string;
  type: ToastType;
  seq: number; // 每次 showToast 自增，保证同文案也能重置定时器（v0.11）
  /** 行动点（撤销 / 重试 / 打开）。有行动点时这一层必须能吃手势 */
  action?: { label: string; onPress: () => void };
}

// ===== 全局 Toast 状态（模块级单例）=====
// v0.11.8 的两处改动，都是为了「记一笔后那 2 秒点不动别的图标」这个反馈：
// 1) 不再用透明 RNModal 承载。RNModal 在 Android 上是全屏 Dialog 窗口
//    （ReactModalHostView 只加 FLAG_NOT_FOCUSABLE，从不加 FLAG_NOT_TOUCHABLE），
//    窗口内的 pointerEvents="none" 只影响 RN 自己的手势派发，系统仍把这层窗口之下的
//    所有触摸都交给它 —— 于是 Toast 显示期间整页都点不动。
// 2) 状态从「每个页面各自 useState」收归到这里，App 根与表单弹窗各挂一层渲染器即可。
//    此前 10 个页面各挂一份：4 个 tab 常驻挂载，隐藏 tab 的报错会弹到你正在看的页面上，
//    而全屏表单里的 toast 因为挂在列表分支上根本显示不出来。
let state: ToastState = { visible: false, message: '', type: 'success', seq: 0 };
const listeners = new Set<() => void>();
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  listeners.forEach((l) => l());
}

/**
 * @param duration 省略时按类型给：error 4500（长错误 2 秒读不完，走查 audit-18）、其余 2000。
 */
export function showToast(
  message: string,
  type: ToastType = 'success',
  duration?: number,
  action?: { label: string; onPress: () => void },
): void {
  const ms = duration ?? (type === 'error' ? 4500 : 2000);
  state = { visible: true, message, type, seq: state.seq + 1, action };
  emit();
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(
    () => {
      hideTimer = null;
      hideToast();
    },
    action ? Math.max(ms, 5000) : ms,
  );
}

export function hideToast(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  state = { ...state, visible: false };
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

interface Props {
  /** 提示层停留位置：默认贴着顶部安全区；全屏表单弹窗内改用中部，避免被导航栏压住 */
  anchor?: 'top' | 'center';
}

// 渲染层（无状态、无定时器）：App 根挂一份，每个打开的表单弹窗内再挂一份。
export default function Toast({ anchor = 'top' }: Props = {}) {
  const current = useSyncExternalStore(subscribe, () => state);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(12)).current;
  const insets = useSafeAreaInsets();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (current.visible) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8 }),
      ]).start();
      return;
    }
    if (!mounted) return;
    Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.visible, current.seq]);

  if (!mounted) return null;

  const bgColor =
    current.type === 'error' ? COLORS.danger : current.type === 'info' ? COLORS.accent : COLORS.success;

  // 没有行动点时这一层永远不吃手势，页面在它下面照常可点；
  // 有行动点（撤销/重试）时必须让气泡自己可点，其余区域仍然穿透。
  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.container,
        anchor === 'center' ? styles.containerCenter : { top: insets.top + SPACING.sm },
      ]}
      accessibilityLiveRegion="polite"
    >
      <Animated.View
        style={[styles.bubble, { backgroundColor: bgColor, opacity, transform: [{ translateY }] }]}
      >
        <Text style={styles.text}>{current.message}</Text>
        {current.action ? (
          <Pressable
            style={styles.action}
            accessibilityRole="button"
            accessibilityLabel={current.action.label}
            onPress={() => {
              const run = current.action?.onPress;
              hideToast();
              run?.();
            }}
          >
            <Text style={styles.actionText}>{current.action.label}</Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 100,
  },
  containerCenter: {
    top: '38%',
  },
  bubble: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: RADIUS.pill,
    maxWidth: '85%',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  text: {
    color: COLORS.white,
    fontSize: FONT_SIZE.sm,
    fontWeight: '600',
    textAlign: 'center',
  },
  action: {
    marginLeft: SPACING.md,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  actionText: { color: COLORS.white, fontSize: FONT_SIZE.sm, fontWeight: '700' },
});
