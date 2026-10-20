import React, { useCallback } from 'react';
import {
  KeyboardAvoidingView,
  Modal as RNModal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS, FONT_SIZE, SPACING } from '../constants';
import Toast from './Toast';

interface Props {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /**
   * 含输入框的表单弹窗统一走全屏（沿用 TapLedger 的结论：底部 sheet 在键盘避让下不可控）。
   * 注意：这一层用的是**非透明**的全屏 Dialog 窗口，可以接受；
   * 被明令禁止的是「透明 RNModal 当提示层」—— 它不加 FLAG_NOT_TOUCHABLE，会把整页点不动。
   * 也绝不用 Modal 盖相机（相机是原生 SurfaceView/TextureView，触摸与安全区行为都会变）。
   */
  saveLabel?: string;
  onSave?: () => void;
  saveDisabled?: boolean;
}

export default function Modal({
  visible,
  title,
  onClose,
  children,
  saveLabel = '保存',
  onSave,
  saveDisabled,
}: Props) {
  const close = useCallback(() => {
    onClose();
  }, [onClose]);

  return (
    <RNModal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Pressable
            onPress={close}
            hitSlop={8}
            style={styles.headerBtn}
            accessibilityRole="button"
            accessibilityLabel="取消"
          >
            <Text style={styles.cancel}>取消</Text>
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {onSave ? (
            <Pressable
              onPress={onSave}
              hitSlop={8}
              disabled={saveDisabled}
              style={styles.headerBtn}
              accessibilityRole="button"
              accessibilityState={{ disabled: Boolean(saveDisabled) }}
              accessibilityLabel={saveLabel}
            >
              <Text style={[styles.save, saveDisabled && styles.saveDisabled]}>{saveLabel}</Text>
            </Pressable>
          ) : (
            <View style={styles.headerBtn} />
          )}
        </View>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.body}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        </KeyboardAvoidingView>
        {/* 表单在自己的 Dialog 窗口里，提示层必须挂在同一窗口内才盖得住（App 根那层在它下面） */}
        <Toast anchor="center" />
      </SafeAreaView>
    </RNModal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  headerBtn: { minWidth: 56, alignItems: 'center', paddingVertical: SPACING.xs },
  cancel: { fontSize: FONT_SIZE.md, color: COLORS.textSecondary, fontWeight: '600' },
  title: {
    fontSize: FONT_SIZE.lg,
    fontWeight: '800',
    color: COLORS.text,
    flexShrink: 1,
    textAlign: 'center',
  },
  save: { fontSize: FONT_SIZE.md, color: COLORS.accent, fontWeight: '700' },
  saveDisabled: { opacity: 0.4 },
  body: { flex: 1 },
  scroll: { flex: 1 },
  content: { padding: SPACING.lg, paddingBottom: SPACING.xxl },
});
