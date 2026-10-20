import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path, Rect, Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, FONT_SIZE, RADIUS, SPACING } from '../constants';

export type TabKey = 'scan' | 'documents' | 'manage';

interface Props {
  current: TabKey;
  onChange: (key: TabKey) => void;
}

const TABS: { key: TabKey; label: string; Icon: React.FC<{ active: boolean }> }[] = [
  { key: 'scan', label: '扫描', Icon: ScanIcon },
  { key: 'documents', label: '文档', Icon: DocsIcon },
  { key: 'manage', label: '管理', Icon: ManageIcon },
];

/** 图标一律手绘 SVG（Tap 系列不用 emoji 当图标：各 ROM 字形不统一，且显得廉价） */
function ScanIcon({ active }: { active: boolean }) {
  const color = active ? COLORS.accentDark : COLORS.textTertiary;
  return (
    <Svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      {/* 四角取景框 + 中间一张纸 */}
      <Path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <Path d="M16 3h3.5A1.5 1.5 0 0 1 21 4.5V8" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <Path d="M21 16v3.5a1.5 1.5 0 0 1-1.5 1.5H16" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <Path d="M8 21H4.5A1.5 1.5 0 0 1 3 19.5V16" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <Rect x="7.5" y="9" width="9" height="6" rx="1.2" fill={color} opacity={active ? 0.9 : 0.55} />
    </Svg>
  );
}

function DocsIcon({ active }: { active: boolean }) {
  const color = active ? COLORS.accentDark : COLORS.textTertiary;
  return (
    <Svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <Rect x="5" y="3.5" width="12" height="15" rx="1.8" stroke={color} strokeWidth="1.8" />
      <Path d="M8.5 8h5.5M8.5 11.5h5.5M8.5 15h3" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      <Path
        d="M19 7.5h1.5A1.5 1.5 0 0 1 22 9v9.5a2 2 0 0 1-2 2H9a1.5 1.5 0 0 1-1.5-1.5V20"
        stroke={color}
        strokeWidth="1.6"
        opacity={active ? 0.75 : 0.45}
      />
    </Svg>
  );
}

function ManageIcon({ active }: { active: boolean }) {
  const color = active ? COLORS.accentDark : COLORS.textTertiary;
  return (
    <Svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <Path d="M4 7.5h16M4 16.5h16" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <Circle cx="9" cy="7.5" r="2.6" fill={COLORS.surface} stroke={color} strokeWidth="1.8" />
      <Circle cx="15" cy="16.5" r="2.6" fill={COLORS.surface} stroke={color} strokeWidth="1.8" />
    </Svg>
  );
}

/**
 * 底部导航（暖色悬浮胶囊，沿用 TapLedger 的样式：卡片 + 阴影只给浮层）。
 * 扫描是主入口，因此排在最左且默认停留 —— 首页零跳转的红线从这一层就开始守。
 */
export default function TabBar({ current, onChange }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingBottom: SPACING.sm + Math.max(insets.bottom, SPACING.xs) }]}>
      <View style={styles.bar}>
        {TABS.map(({ key, label, Icon }) => {
          const active = key === current;
          return (
            <Pressable
              key={key}
              style={styles.item}
              onPress={() => onChange(key)}
              android_ripple={{ color: 'rgba(0,0,0,0.05)', borderless: true }}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: active }}
            >
              <Icon active={active} />
              <Text style={[styles.label, active && styles.labelActive]}>{label}</Text>
              {active ? <View style={styles.dot} /> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.xs,
    backgroundColor: COLORS.background,
  },
  bar: {
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: SPACING.xs,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: SPACING.xs,
    gap: 2,
  },
  label: {
    fontSize: FONT_SIZE.xs - 0.5,
    color: COLORS.textTertiary,
    fontWeight: '500',
  },
  labelActive: {
    color: COLORS.accentDark,
    fontWeight: '700',
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.accent,
    marginTop: 1,
  },
});
