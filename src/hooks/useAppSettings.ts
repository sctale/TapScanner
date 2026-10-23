import { useEffect, useState } from 'react';
import { DeviceEventEmitter } from 'react-native';
import { SCANNER_EVENTS } from '../constants';
import { DEFAULT_SETTINGS, loadSettings, settingsSync, type AppSettings } from '../utils/appSettings';

/**
 * 实时跟随的设置。
 *
 * 三个 Tab 是常驻挂载的（Tap 系列用 display 切换而不是卸载重挂），所以
 * 「挂载时 loadSettings 一次」等于：用户在管理页改了默认档位/自动切边/输出分辨率，
 * 扫描页这一整轮根本不知道 —— 走查 audit-15 的正是这条。
 * 这里同时读缓存（同步可用，避免首帧闪烁）并订阅变更事件。
 */
export function useAppSettings(): AppSettings {
  const [settings, setSettings] = useState<AppSettings>(() => settingsSync() ?? DEFAULT_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((next) => {
      if (!cancelled) setSettings(next);
    });
    const sub = DeviceEventEmitter.addListener(SCANNER_EVENTS.SETTINGS_CHANGED, () => {
      setSettings({ ...settingsSync() });
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  return settings;
}
