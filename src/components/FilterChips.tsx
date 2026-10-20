import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { COLORS, FONT_SIZE, RADIUS, SPACING, SCAN_MODES } from '../constants';
import type { ScanMode } from '../types';

interface Props {
  value: ScanMode;
  onChange: (mode: ScanMode) => void;
  /** 相机页是深色底，同一套 chips 要能反过来 */
  onDark?: boolean;
  disabled?: boolean;
  /** 自动推荐的档位，在标签旁点一个小点，告诉用户「这不是你选的，是它建议的」 */
  suggested?: ScanMode | null;
}

/**
 * 滤镜档位选择条。
 *
 * 这是本项目对「自动决策必须可覆盖」这条铁律的全部交代：
 * 没有滑杆，但档位随时能换、四角随时能改、拍坏能重拍 —— 自动值永远是建议。
 */
export default function FilterChips({ value, onChange, onDark = false, disabled, suggested }: Props) {
  return (
    <View style={styles.row} accessibilityRole="radiogroup">
      {SCAN_MODES.map((mode) => {
        const active = mode.key === value;
        return (
          <Pressable
            key={mode.key}
            accessibilityRole="radio"
            accessibilityState={{ selected: active, disabled: Boolean(disabled) }}
            accessibilityLabel={`${mode.label}，${mode.hint}`}
            disabled={disabled}
            style={[
              styles.chip,
              onDark ? styles.chipDark : styles.chipLight,
              active && (onDark ? styles.chipActiveDark : styles.chipActiveLight),
              disabled && styles.chipDisabled,
            ]}
            onPress={() => onChange(mode.key)}
          >
            <Text
              style={[
                styles.label,
                onDark ? styles.labelDark : styles.labelLight,
                active && styles.labelActive,
              ]}
            >
              {mode.label}
            </Text>
            {suggested === mode.key && !active ? <View style={styles.suggestDot} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

// 选中态文字在深浅底上都是同一个强调色
const ACTIVE_TEXT = COLORS.accentDark;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  chip: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 7,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
  },
  chipLight: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.borderSubtle,
  },
  chipDark: {
    backgroundColor: COLORS.onCameraSurface,
    borderColor: COLORS.onCameraBorder,
  },
  chipActiveLight: {
    backgroundColor: `${COLORS.accent}18`,
    borderColor: COLORS.accent,
  },
  chipActiveDark: {
    backgroundColor: 'rgba(121,134,203,0.28)',
    borderColor: COLORS.accent,
  },
  chipDisabled: { opacity: 0.45 },
  label: { fontSize: FONT_SIZE.sm, fontWeight: '600' },
  labelLight: { color: COLORS.textSecondary },
  labelDark: { color: COLORS.onCameraTextDim },
  labelActive: { color: ACTIVE_TEXT },
  suggestDot: {
    position: 'absolute',
    top: 4,
    right: 6,
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: COLORS.frameGuide,
  },
});
