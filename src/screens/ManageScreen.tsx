import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { File } from 'expo-file-system';
import { COLORS, CARD, FONT_SIZE, RADIUS, SCAN_MODES, SPACING } from '../constants';
import { listDocuments } from '../database/scannerDB';
import { directoryBytes, formatBytes, listDocumentDirs, deleteDocumentFiles } from '../utils/scanFiles';
import { loadSettings, updateSettings, type AppSettings } from '../utils/appSettings';
import { isEngineReady, probeImage, scannerErrorMessage } from '../native/ScannerNative';
import { exportBackupJson, importBackupJson } from '../utils/backup';
import { useBackHandler } from '../hooks/useBackHandler';
import { showToast } from '../components/Toast';
import type { ReadyInfo } from '../types';

type Page = 'main' | 'storage' | 'about';

/**
 * 管理页：入口列表 + 二级页（iOS 设置页标准结构，沿用 TapLedger 约定）。
 * 副标题只说一句话，隐私说明放这里而不是弹窗。
 */
export default function ManageScreen() {
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState<Page>('main');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [engine, setEngine] = useState<ReadyInfo | null>(null);

  useBackHandler(page !== 'main', () => setPage('main'));

  useEffect(() => {
    (async () => {
      setSettings(await loadSettings());
      setEngine(await isEngineReady());
    })();
  }, []);

  if (page === 'storage') {
    return <StoragePage onBack={() => setPage('main')} />;
  }
  if (page === 'about') {
    return <AboutPage engine={engine} onBack={() => setPage('main')} />;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={{ height: insets.top + SPACING.lg }} />
      <Text style={styles.title}>管理</Text>
      <Text style={styles.subtitle}>极简扫描 · 智能高清 · 所有文件都在这台手机上</Text>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>默认档位</Text>
        <View style={styles.chips}>
          {SCAN_MODES.map((mode) => {
            const active = settings?.defaultMode === mode.key;
            return (
              <Pressable
                key={mode.key}
                style={[styles.chip, active && styles.chipActive]}
                onPress={async () => {
                  const next = await updateSettings({ defaultMode: mode.key });
                  setSettings(next);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{mode.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>这只是默认值 —— 每拍完一页都能当场换档，事后也能在文档里换</Text>
      </View>

      <View style={styles.section}>
        <ToggleRow
          label="自动切边"
          hint="关掉后整页保留，只矫正角度"
          value={settings?.autoCrop ?? true}
          onChange={async (v) => setSettings(await updateSettings({ autoCrop: v }))}
        />
        <SegmentRow
          label="输出分辨率"
          options={[
            { value: 2000, label: '2000' },
            { value: 3000, label: '3000' },
            { value: 4000, label: '4000' },
          ]}
          value={settings?.outputMaxSide ?? 3000}
          onChange={async (v) => setSettings(await updateSettings({ outputMaxSide: Number(v) }))}
          hint="长边像素数。3000 够打印 A4，4000 会更慢更大"
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>数据</Text>
        <EntryRow label="存储占用与清理" onPress={() => setPage('storage')} />
        <BackupRows />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>关于</Text>
        <EntryRow label="关于与自检" onPress={() => setPage('about')} />
      </View>
      <View style={{ height: SPACING.xxxl }} />
    </ScrollView>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

function EntryRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.entry} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={styles.entryLabel}>{label}</Text>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      {/* 自绘胶囊开关：系统 Switch 在 Android 上风格不统一（Tap 系列约定） */}
      <Pressable
        style={[styles.switchTrack, value && styles.switchTrackOn]}
        onPress={() => onChange(!value)}
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityState={{ checked: value }}
      >
        <View style={[styles.switchKnob, value && styles.switchKnobOn]} />
      </Pressable>
    </Row>
  );
}

function SegmentRow({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  options: { value: number | string; label: string }[];
  value: number | string;
  onChange: (v: number | string) => void;
}) {
  return (
    <View style={styles.segmentWrap}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.segment}>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <Pressable
              key={String(option.value)}
              style={[styles.segmentItem, active && styles.segmentItemActive]}
              onPress={() => onChange(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

function BackupRows() {
  const [busy, setBusy] = useState(false);

  const doExport = useCallback(async () => {
    setBusy(true);
    try {
      const result = await exportBackupJson();
      showToast(result.message, result.ok ? 'success' : 'info');
    } catch (error) {
      showToast((error as Error)?.message ?? '导出失败', 'error');
    } finally {
      setBusy(false);
    }
  }, []);

  const doImport = useCallback(async () => {
    setBusy(true);
    try {
      const result = await importBackupJson();
      if (result.ok) showToast(`已导入 ${result.documents} 份文档`, 'success');
      else showToast(result.message ?? '未导入', 'info');
    } catch (error) {
      showToast((error as Error)?.message ?? '导入失败', 'error');
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <Row>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>备份</Text>
        <Text style={styles.hint}>导出记录与图片清单；图片本身在手机上，换机需要重新扫描</Text>
      </View>
      <View style={styles.inlineActions}>
        <Pressable style={styles.miniBtn} disabled={busy} onPress={() => void doExport()}>
          <Text style={styles.miniBtnText}>导出</Text>
        </Pressable>
        <Pressable style={styles.miniBtn} disabled={busy} onPress={() => void doImport()}>
          <Text style={styles.miniBtnText}>导入</Text>
        </Pressable>
      </View>
    </Row>
  );
}

function StoragePage({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<{ total: number; docs: number; orphans: string[] }>({
    total: 0,
    docs: 0,
    orphans: [],
  });
  const [loading, setLoading] = useState(true);

  const scan = useCallback(async () => {
    setLoading(true);
    try {
      const documents = await listDocuments();
      let total = 0;
      for (const doc of documents) total += directoryBytes(doc.uuid);
      const known = new Set(documents.map((d) => d.uuid));
      const orphans = listDocumentDirs().filter((name) => !known.has(name));
      setRows({ total, docs: documents.length, orphans });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  const cleanOrphans = useCallback(async () => {
    for (const uuid of rows.orphans) deleteDocumentFiles(uuid);
    await scan();
    showToast(
      rows.orphans.length > 0 ? `清掉了 ${rows.orphans.length} 个残留目录` : '没有需要清的',
      'success',
    );
  }, [rows.orphans, scan]);

  return (
    <View style={styles.container}>
      <View style={{ height: insets.top + SPACING.sm }} />
      <View style={styles.nav}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel="返回">
          <Text style={styles.back}>‹ 返回</Text>
        </Pressable>
        <Text style={styles.navTitle}>存储</Text>
        <View style={{ minWidth: 60 }} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.bigNumber}>{formatBytes(rows.total)}</Text>
          <Text style={styles.hint}>
            {rows.docs} 份文档的扫描件占用；导出的 PDF 与备份在同级的 export 目录里
          </Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.rowLabel}>清理未引用文件</Text>
          <Text style={styles.hint}>
            {rows.orphans.length === 0
              ? '没有残留 —— 中途放弃的扫描组有时会留下空目录'
              : `发现 ${rows.orphans.length} 个数据库里没记录的目录，可以安全删除`}
          </Text>
          <Pressable
            style={[styles.miniBtnWide, rows.orphans.length === 0 && styles.disabled]}
            disabled={rows.orphans.length === 0}
            onPress={() => void cleanOrphans()}
          >
            <Text style={styles.miniBtnText}>清理</Text>
          </Pressable>
        </View>
        {loading ? <ActivityIndicator color={COLORS.accent} /> : null}
      </ScrollView>
    </View>
  );
}

function AboutPage({ engine, onBack }: { engine: ReadyInfo | null; onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const [selfTest, setSelfTest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const version = useMemo(
    () => Constants.expoConfig?.version ?? Constants.manifest2?.runtimeVersion ?? '开发版',
    [],
  );

  /**
   * 自检：拿最近一份文档的第一页 raw 走一遍探针（解码 → 缩放 → 编码）。
   * 目的是让真机上的「图像层通不通」变成屏幕上能直接看到的一行字，
   * 而不是靠我猜 —— 完整 6 样张跑批（tools/scan-sample）留在 v0.2。
   */
  const runSelfTest = useCallback(async () => {
    setBusy(true);
    setSelfTest(null);
    try {
      const documents = await listDocuments();
      if (documents.length === 0) {
        setSelfTest('还没有文档，先扫一页再自检');
        return;
      }
      // 复用 scanFiles 的目录规则找出第一张 raw
      const { documentDir, rawFilePattern } = await import('../utils/scanFiles');
      const dir = documentDir(documents[0].uuid);
      const candidates = dir.exists ? dir.list().filter((f) => rawFilePattern.test(f.name)) : [];
      if (candidates.length === 0) {
        setSelfTest('找不到 raw 图，无法自检');
        return;
      }
      const src = new File(dir, candidates[0].name);
      const out = new File(dir, 'selftest_probe.jpg');
      const result = await probeImage(src.uri, out.uri, 1200);
      setSelfTest(
        `探针通过：${Math.round(result.sourceWidth)}×${Math.round(result.sourceHeight)} → ` +
          `${Math.round(result.width)}×${Math.round(result.height)}，耗时 ${Math.round(result.elapsedMs)}ms`,
      );
    } catch (error) {
      setSelfTest(scannerErrorMessage(undefined, (error as Error)?.message));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <View style={styles.container}>
      <View style={{ height: insets.top + SPACING.sm }} />
      <View style={styles.nav}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel="返回">
          <Text style={styles.back}>‹ 返回</Text>
        </Pressable>
        <Text style={styles.navTitle}>关于</Text>
        <View style={{ minWidth: 60 }} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.appName}>扫描一下</Text>
          <Text style={styles.hint}>TapScanner v{String(version)}</Text>
          <Text style={styles.hint}>
            拍照 → 自动切边 → 摊平光照 → 增强锐化 → 多页成文档 → 导出无损 JPEG 直传的 PDF
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.rowLabel}>隐私</Text>
          <Text style={styles.hint}>
            没有账号、没有上传、没有统计。图片和记录都存在这台手机的应用目录里，卸载即清空。
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.rowLabel}>智能高清做到哪一步</Text>
          <Text style={styles.hint}>
            做：自动切边、梯形矫正、光照/阴影摊平、对比度增强、纸面提白、锐化、降噪、五种档位。{'\n'}
            不做（这些要深度学习模型，本 App 不带模型）：曲面矫正、透字去除、手指区域补图。{'\n'}
            「去阴影」是除法归一化近似；摩尔纹只判断、不消除（判断到就避开降噪）。
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.rowLabel}>图像引擎</Text>
          <Text style={styles.hint}>
            {engine === null
              ? '检查中…'
              : engine.ready
                ? `OpenCV ${engine.version} · ABI ${engine.abi}`
                : '未加载（扫描会失败，请重装 APK）'}
          </Text>
          <Pressable
            style={[styles.miniBtnWide, busy && styles.disabled]}
            disabled={busy}
            onPress={() => void runSelfTest()}
          >
            {busy ? (
              <ActivityIndicator color={COLORS.white} />
            ) : (
              <Text style={styles.miniBtnText}>跑一次自检</Text>
            )}
          </Pressable>
          {selfTest ? <Text style={styles.selfTest}>{selfTest}</Text> : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.md, paddingBottom: SPACING.xxxl, gap: SPACING.md },
  title: { fontSize: FONT_SIZE.xxxl, fontWeight: '800', color: COLORS.text, paddingHorizontal: SPACING.md },
  subtitle: {
    fontSize: FONT_SIZE.sm,
    color: COLORS.textTertiary,
    paddingHorizontal: SPACING.md,
    marginTop: 4,
    marginBottom: SPACING.lg,
  },
  section: { paddingHorizontal: SPACING.md, gap: SPACING.sm },
  sectionLabel: {
    fontSize: FONT_SIZE.xs,
    color: COLORS.textTertiary,
    fontWeight: '600',
    marginTop: SPACING.sm,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  chip: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 8,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    backgroundColor: COLORS.surface,
  },
  chipActive: { borderColor: COLORS.accent, backgroundColor: `${COLORS.accent}18` },
  chipText: { fontSize: FONT_SIZE.sm, color: COLORS.textSecondary, fontWeight: '600' },
  chipTextActive: { color: COLORS.accentDark },
  hint: { fontSize: FONT_SIZE.xs, color: COLORS.textTertiary, lineHeight: 18 },
  row: {
    ...CARD,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: SPACING.md,
    gap: SPACING.md,
  },
  rowBody: { flex: 1, gap: 2 },
  rowLabel: { fontSize: FONT_SIZE.md, fontWeight: '600', color: COLORS.text },
  entry: {
    ...CARD,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: SPACING.md,
  },
  entryLabel: { fontSize: FONT_SIZE.md, color: COLORS.text, fontWeight: '600' },
  chevron: { fontSize: FONT_SIZE.lg, color: COLORS.textTertiary },
  switchTrack: {
    width: 46,
    height: 28,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.bgAlt,
    padding: 3,
    justifyContent: 'flex-start',
  },
  switchTrackOn: { backgroundColor: COLORS.accent },
  switchKnob: {
    width: 22,
    height: 22,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.white,
  },
  switchKnobOn: { transform: [{ translateX: 18 }] },
  segmentWrap: { ...CARD, padding: SPACING.md, gap: SPACING.sm },
  segment: {
    flexDirection: 'row',
    gap: SPACING.xs,
    backgroundColor: COLORS.bgAlt,
    padding: 3,
    borderRadius: RADIUS.pill,
  },
  segmentItem: { flex: 1, paddingVertical: 7, borderRadius: RADIUS.pill, alignItems: 'center' },
  segmentItemActive: { backgroundColor: COLORS.accent },
  segmentText: { fontSize: FONT_SIZE.sm, color: COLORS.textSecondary, fontWeight: '600' },
  segmentTextActive: { color: COLORS.white },
  inlineActions: { flexDirection: 'row', gap: SPACING.sm },
  miniBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 7,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.accent,
  },
  miniBtnWide: {
    alignSelf: 'flex-start',
    paddingHorizontal: SPACING.lg,
    paddingVertical: 9,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.accent,
    marginTop: SPACING.sm,
    minWidth: 110,
    alignItems: 'center',
  },
  miniBtnText: { color: COLORS.white, fontSize: FONT_SIZE.sm, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  back: { color: COLORS.textSecondary, fontSize: FONT_SIZE.md, fontWeight: '600', minWidth: 60 },
  navTitle: {
    fontSize: FONT_SIZE.lg,
    fontWeight: '800',
    color: COLORS.text,
    flexShrink: 1,
    textAlign: 'center',
  },
  card: { ...CARD, padding: SPACING.md, gap: 6 },
  bigNumber: { fontSize: FONT_SIZE.xxxl, fontWeight: '800', color: COLORS.text },
  appName: { fontSize: FONT_SIZE.xl, fontWeight: '800', color: COLORS.text },
  selfTest: { fontSize: FONT_SIZE.xs, color: COLORS.accentDark, marginTop: SPACING.xs },
});
