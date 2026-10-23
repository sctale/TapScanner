import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { COLORS, FONT_SIZE, RADIUS, SPACING, TOUCH } from '../constants';
import Modal from './Modal';

export interface MenuAction {
  key: string;
  label: string;
  /** 说明这一项到底会做什么（破坏性项一定要写清楚后果） */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

interface Props {
  visible: boolean;
  title: string;
  actions: MenuAction[];
  onClose: () => void;
}

/**
 * 动作菜单：把「长按=删除」这类隐藏手势换成看得见的一列表。
 *
 * 走查里最重的一条（audit-3）是文档列表长按直接物理删除整份文档 ——
 * 无确认、无菜单、连 accessibilityLabel 都没提。修法是长按先弹这一层，
 * 破坏性项再走 Confirm。用既有的 Modal（非透明全屏 Dialog 窗口）承载：
 * Tap 系列禁止的是「透明 RNModal 当提示层」，它会把整页点不动，这里不受影响。
 */
export default function Menu({ visible, title, actions, onClose }: Props) {
  return (
    <Modal visible={visible} title={title} onClose={onClose}>
      <View style={styles.list}>
        {actions.map((action) => (
          <Pressable
            key={action.key}
            style={({ pressed }) => [
              styles.item,
              pressed && styles.itemPressed,
              action.disabled && styles.itemDisabled,
            ]}
            disabled={action.disabled}
            accessibilityRole="button"
            accessibilityLabel={action.hint ? `${action.label}，${action.hint}` : action.label}
            accessibilityState={{ disabled: Boolean(action.disabled) }}
            onPress={() => {
              // 先关再执行：否则子流程（确认弹窗/系统面板）会盖在这个还开着的窗口下面
              onClose();
              action.onPress();
            }}
          >
            <Text style={[styles.label, action.danger && styles.labelDanger]}>{action.label}</Text>
            {action.hint ? <Text style={styles.hint}>{action.hint}</Text> : null}
          </Pressable>
        ))}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  list: { gap: SPACING.sm },
  item: {
    ...{
      backgroundColor: COLORS.surface,
      borderRadius: RADIUS.md,
      borderWidth: 1,
      borderColor: COLORS.border,
    },
    minHeight: TOUCH.min,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    justifyContent: 'center',
    gap: 2,
  },
  itemPressed: { backgroundColor: COLORS.bgAlt },
  itemDisabled: { opacity: 0.45 },
  label: { fontSize: FONT_SIZE.md, fontWeight: '600', color: COLORS.text },
  labelDanger: { color: COLORS.danger },
  hint: { fontSize: FONT_SIZE.xs, color: COLORS.textTertiary, lineHeight: 17 },
});
