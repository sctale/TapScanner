import { useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

/**
 * 返回键/边缘手势接管。
 *
 * 没有导航库、路由靠 state 手管，就必须自己接这一层：RN 的默认行为是
 * 「没有任何监听返回 true 就 exitApp()」，Android 16 的边缘手势一划就整个 App 退出，
 * 而不是回到上一页 —— 这是 anti-car-sickness 的 AGENTS.md 里明确记下的红线。
 *
 * @param enabled 当前是否有二级页需要吃掉这次返回
 * @param onBack  吃掉返回时要做的事
 */
export function useBackHandler(enabled: boolean, onBack: () => void): void {
  const handlerRef = useRef(onBack);
  handlerRef.current = onBack;

  useEffect(() => {
    if (!enabled) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      handlerRef.current();
      return true;
    });
    return () => subscription.remove();
  }, [enabled]);
}
