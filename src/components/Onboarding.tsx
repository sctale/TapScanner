import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, FONT_SIZE, RADIUS, SETTING_KEYS, SPACING, TOUCH } from '../constants';
import { saveSetting } from '../utils/appSettings';

const PAGES = [
  {
    title: '把纸放平，俯视拍',
    body: '不用摆得很正。稍微斜一点、有点阴影都能切准 —— 拍完会自动找纸的四条边。',
  },
  {
    title: '「智能高清」替你做了四件事',
    body: '自动切边 → 把梯形拉正 → 摊平光照去掉阴影 → 提白锐化。全程只动一次快门。',
  },
  {
    title: '自动值只是建议，随时能改',
    body: '拍完那页可以换档位、拖四个角、重拍；文档存下来之后还能换档重出，原图一直在。',
  },
];

/**
 * 首启三页教学（走查 audit-36）。
 *
 * 只在第一次启动出现，且每一页都能跳 —— 工具类 App 没人愿意读完教程。
 * 之前全 App 唯一的操作提示是取景层那行小字，而真正讲清楚「自动做了什么、
 * 不能做什么」的那段话藏在管理 → 关于里，三级深度等于没有。
 */
export default function Onboarding({ onDone }: { onDone: () => void }) {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(0);
  const page = PAGES[step];

  const finish = () => {
    void saveSetting(SETTING_KEYS.ONBOARDED_AT, String(Date.now()));
    onDone();
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + SPACING.xxl }]}>
      <Text style={styles.dots}>
        {'●'.repeat(step + 1)}
        {'○'.repeat(PAGES.length - step - 1)}
      </Text>
      <Text style={styles.title}>{page.title}</Text>
      <Text style={styles.body}>{page.body}</Text>

      <View style={styles.actions}>
        {step < PAGES.length - 1 ? (
          <Pressable style={styles.primary} onPress={() => setStep((s) => s + 1)} accessibilityRole="button">
            <Text style={styles.primaryText}>下一步</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.primary} onPress={finish} accessibilityRole="button">
            <Text style={styles.primaryText}>开始扫描</Text>
          </Pressable>
        )}
        <Pressable style={styles.skip} onPress={finish} accessibilityRole="button">
          <Text style={styles.skipText}>跳过</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.background,
    padding: SPACING.xl,
    gap: SPACING.md,
    justifyContent: 'center',
  },
  dots: { fontSize: FONT_SIZE.sm, color: COLORS.accentDark, letterSpacing: 4 },
  title: { fontSize: FONT_SIZE.xxl, fontWeight: '800', color: COLORS.text, lineHeight: 34 },
  body: { fontSize: FONT_SIZE.md, color: COLORS.textSecondary, lineHeight: 24 },
  actions: { marginTop: SPACING.xl, gap: SPACING.sm },
  primary: {
    minHeight: TOUCH.min,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.accentDark,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.md,
  },
  primaryText: { color: COLORS.white, fontSize: FONT_SIZE.md, fontWeight: '700' },
  skip: { minHeight: TOUCH.min, alignItems: 'center', justifyContent: 'center' },
  skipText: { color: COLORS.textSecondary, fontSize: FONT_SIZE.sm, fontWeight: '600' },
});
