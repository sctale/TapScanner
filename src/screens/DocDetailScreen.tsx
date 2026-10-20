import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  DeviceEventEmitter,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, CARD, FONT_SIZE, RADIUS, SCANNER_EVENTS, SPACING } from '../constants';
import {
  deleteDocument,
  getDocument,
  listPages,
  renameDocument,
  setDocumentStarred,
  swapPagePositions,
  updatePageRender,
} from '../database/scannerDB';
import { deleteDocumentFiles, fileUri } from '../utils/scanFiles';
import { exportDocumentPdf, safeFileName, shareFile, sharePageJpg } from '../utils/exportActions';
import { rerenderPage } from '../utils/scanPipeline';
import { loadSettings } from '../utils/appSettings';
import { scannerErrorCode, scannerErrorMessage } from '../native/ScannerNative';
import Toast, { showToast } from '../components/Toast';
import { useBackHandler } from '../hooks/useBackHandler';
import Modal from '../components/Modal';
import FilterChips from '../components/FilterChips';
import type { DocumentRecord, PageRecord, ScanMode } from '../types';

interface Props {
  documentId: number;
  onBack: () => void;
  onDeleted: () => void;
}

/**
 * 文档详情（并列二级页，不是 Modal —— 与 App 切 Tab 完全同款）。
 *
 * 这里能做三件在拍摄当场做不了的事：换档（同一张 raw 重新出一版）、
 * 调页序、导出。raw 一直在，所以这些操作都是无损的。
 */
export default function DocDetailScreen({ documentId, onBack, onDeleted }: Props) {
  const insets = useSafeAreaInsets();
  const [document, setDocument] = useState<DocumentRecord | null>(null);
  const [pages, setPages] = useState<PageRecord[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [doc, list] = await Promise.all([getDocument(documentId), listPages(documentId)]);
      setDocument(doc);
      setPages(list);
      setSelectedId((prev) => prev ?? list[0]?.id ?? null);
    } catch {
      showToast('读取文档失败', 'error');
    }
  }, [documentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useBackHandler(true, onBack);

  const selected = useMemo(() => pages.find((p) => p.id === selectedId) ?? null, [pages, selectedId]);

  const changeMode = useCallback(
    async (mode: ScanMode) => {
      if (!document || !selected) return;
      setBusy(true);
      try {
        const settings = await loadSettings();
        const { result, quad } = await rerenderPage({
          docUuid: document.uuid,
          pageUuid: selected.uuid,
          rawPath: selected.rawPath,
          mode,
          quad: selected.quad,
          autoCrop: settings.autoCrop,
          outputMaxSide: settings.outputMaxSide,
          jpegQuality: settings.jpegQuality,
        });
        await updatePageRender(selected.id, {
          mode,
          outPath: result.outPath,
          thumbPath: result.thumbPath,
          quad,
          metrics: result.metricsAfter,
          stages: result.stages,
          width: result.width,
          height: result.height,
        });
        await reload();
        showToast(`第 ${selected.position + 1} 页已换成${mode === 'hd' ? '智能高清' : '新档位'}`, 'success');
      } catch (error) {
        showToast(scannerErrorMessage(scannerErrorCode(error), (error as Error)?.message), 'error');
      } finally {
        setBusy(false);
      }
    },
    [document, reload, selected],
  );

  const move = useCallback(
    async (page: PageRecord, direction: -1 | 1) => {
      const neighbor = pages.find((p) => p.position === page.position + direction);
      if (!neighbor || !document) return;
      await swapPagePositions(document.id, page.id, neighbor.id);
      await reload();
    },
    [document, pages, reload],
  );

  const doExportPdf = useCallback(async () => {
    if (!document) return;
    setBusy(true);
    try {
      const result = await exportDocumentPdf(document.id);
      await shareFile(result.path, 'application/pdf', safeFileName(document.title));
      showToast(`已生成 ${result.pages} 页 PDF`, 'success');
      DeviceEventEmitter.emit(SCANNER_EVENTS.SAVED, { documentId: document.id });
    } catch (error) {
      showToast((error as Error)?.message ?? '导出 PDF 失败', 'error');
    } finally {
      setBusy(false);
    }
  }, [document]);

  const shareOne = useCallback(
    async (page: PageRecord) => {
      if (!document) return;
      try {
        await sharePageJpg(page.outPath, `${document.title} 第${page.position + 1}页`);
      } catch (error) {
        showToast((error as Error)?.message ?? '分享失败', 'error');
      }
    },
    [document],
  );

  const saveTitle = useCallback(async () => {
    if (!document) return;
    const title = draftTitle.trim().slice(0, 40);
    if (title.length === 0) {
      showToast('名字不能是空的', 'info');
      return;
    }
    await renameDocument(document.id, title);
    setRenaming(false);
    await reload();
    showToast('已改名', 'success');
  }, [document, draftTitle, reload]);

  const doDelete = useCallback(async () => {
    if (!document) return;
    const uuid = await deleteDocument(document.id);
    deleteDocumentFiles(uuid ?? document.uuid);
    setConfirmDelete(false);
    onDeleted();
  }, [document, onDeleted]);

  if (!document) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={COLORS.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={{ height: insets.top + SPACING.xs }} />
      <View style={styles.nav}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel="返回">
          <Text style={styles.back}>‹ 返回</Text>
        </Pressable>
        <Text style={styles.navTitle} numberOfLines={1}>
          {document.title}
        </Text>
        <Pressable
          onPress={async () => {
            await setDocumentStarred(document.id, !document.starred);
            await reload();
          }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={document.starred ? '取消收藏' : '收藏'}
        >
          <Text style={[styles.star, document.starred && styles.starOn]}>★</Text>
        </Pressable>
      </View>

      <FlatList
        data={pages}
        keyExtractor={(item) => String(item.id)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => {
          const isSelected = item.id === selectedId;
          return (
            <Pressable
              style={[styles.row, isSelected && styles.rowSelected]}
              onPress={() => setSelectedId(item.id)}
              accessibilityRole="button"
              accessibilityLabel={`第 ${item.position + 1} 页`}
              accessibilityState={{ selected: isSelected }}
            >
              <View style={styles.rowThumb}>
                {item.thumbPath ? (
                  <Image
                    source={{ uri: fileUri(item.thumbPath) }}
                    style={styles.rowImage}
                    resizeMode="cover"
                    accessibilityIgnoresInvertColors
                  />
                ) : (
                  <View style={styles.rowImagePlaceholder} />
                )}
              </View>
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>
                  第 {item.position + 1} 页 · {MODE_LABEL[item.mode]}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {item.width}×{item.height}
                  {item.metrics
                    ? ` · 亮度 ${Math.round(item.metrics.brightness)} · 锐度 ${Math.round(item.metrics.blurScore)}`
                    : ''}
                </Text>
                <View style={styles.rowActions}>
                  <Pressable
                    style={styles.miniBtn}
                    disabled={item.position === 0}
                    onPress={() => void move(item, -1)}
                    accessibilityLabel="上移"
                  >
                    <Text style={[styles.miniBtnText, item.position === 0 && styles.miniBtnMuted]}>上移</Text>
                  </Pressable>
                  <Pressable
                    style={styles.miniBtn}
                    disabled={item.position >= pages.length - 1}
                    onPress={() => void move(item, 1)}
                    accessibilityLabel="下移"
                  >
                    <Text style={styles.miniBtnText}>下移</Text>
                  </Pressable>
                  <Pressable
                    style={styles.miniBtn}
                    onPress={() => void shareOne(item)}
                    accessibilityLabel="分享本页"
                  >
                    <Text style={styles.miniBtnText}>分享</Text>
                  </Pressable>
                </View>
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>这份文档没有页面 ✨</Text>
          </View>
        }
      />

      <View style={styles.footer}>
        <Text style={styles.footerLabel}>{selected ? '换一档（原图不动，重新出一版）' : '选一页'}</Text>
        <FilterChips
          value={selected?.mode ?? 'hd'}
          onChange={(mode) => void changeMode(mode)}
          disabled={busy || !selected}
        />
        <View style={styles.footerRow}>
          <Pressable
            style={styles.secondaryBtn}
            onPress={() => {
              setDraftTitle(document.title);
              setRenaming(true);
            }}
            disabled={busy}
          >
            <Text style={styles.secondaryBtnText}>改名</Text>
          </Pressable>
          <Pressable style={styles.secondaryBtn} onPress={() => setConfirmDelete(true)} disabled={busy}>
            <Text style={[styles.secondaryBtnText, { color: COLORS.danger }]}>删除</Text>
          </Pressable>
          <Pressable
            style={[styles.primaryBtn, (busy || pages.length === 0) && styles.disabled]}
            disabled={busy || pages.length === 0}
            onPress={() => void doExportPdf()}
          >
            {busy ? (
              <ActivityIndicator color={COLORS.white} />
            ) : (
              <Text style={styles.primaryBtnText}>导出 PDF</Text>
            )}
          </Pressable>
        </View>
      </View>

      <Modal
        visible={renaming}
        title="改名"
        onClose={() => setRenaming(false)}
        onSave={() => void saveTitle()}
      >
        <TextInput
          style={styles.input}
          value={draftTitle}
          onChangeText={setDraftTitle}
          placeholder={document.title}
          maxLength={40}
          accessibilityLabel="文档名"
        />
      </Modal>

      <Modal visible={confirmDelete} title="删除这份文档？" onClose={() => setConfirmDelete(false)}>
        <Text style={styles.confirmText}>
          {document.title}（{document.pageCount} 页）连同图片一起删除，删掉之后找不回来。
        </Text>
        <Pressable style={[styles.primaryBtn, { marginTop: SPACING.lg }]} onPress={() => void doDelete()}>
          <Text style={styles.primaryBtnText}>确认删除</Text>
        </Pressable>
      </Modal>

      <Toast />
    </View>
  );
}

const MODE_LABEL: Record<ScanMode, string> = {
  hd: '智能高清',
  enhance: '增强',
  gray: '灰度',
  bw: '黑白',
  raw: '原图',
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.background },
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
  star: { color: COLORS.textTertiary, fontSize: FONT_SIZE.lg, minWidth: 44, textAlign: 'right' },
  starOn: { color: COLORS.accent },
  listContent: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.md, gap: SPACING.sm },
  row: { ...CARD, flexDirection: 'row', padding: SPACING.sm, gap: SPACING.sm },
  rowSelected: { borderColor: COLORS.accent, backgroundColor: COLORS.surfaceAlt },
  rowThumb: {
    width: 56,
    height: 74,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.bgAlt,
    overflow: 'hidden',
  },
  rowImage: { width: '100%', height: '100%' },
  rowImagePlaceholder: { width: '100%', height: '100%' },
  rowBody: { flex: 1, justifyContent: 'center', gap: 3 },
  rowTitle: { fontSize: FONT_SIZE.sm, fontWeight: '700', color: COLORS.text },
  rowMeta: { fontSize: FONT_SIZE.xs, color: COLORS.textTertiary },
  rowActions: { flexDirection: 'row', gap: SPACING.sm, marginTop: 2 },
  miniBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
  },
  miniBtnText: { fontSize: FONT_SIZE.xs, color: COLORS.textSecondary },
  miniBtnMuted: { opacity: 0.35 },
  empty: { paddingVertical: SPACING.xxxl, alignItems: 'center' },
  emptyText: { fontSize: FONT_SIZE.sm, color: COLORS.textTertiary },
  footer: {
    padding: SPACING.md,
    gap: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  footerLabel: { fontSize: FONT_SIZE.xs, color: COLORS.textTertiary },
  footerRow: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.xs },
  secondaryBtn: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 11,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    backgroundColor: COLORS.surface,
  },
  secondaryBtnText: { fontSize: FONT_SIZE.sm, fontWeight: '600', color: COLORS.textSecondary },
  primaryBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
  },
  primaryBtnText: { color: COLORS.white, fontSize: FONT_SIZE.md, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  input: {
    ...CARD,
    paddingHorizontal: SPACING.md,
    paddingVertical: 12,
    fontSize: FONT_SIZE.md,
    color: COLORS.text,
  },
  confirmText: { fontSize: FONT_SIZE.sm, color: COLORS.textSecondary, lineHeight: 21 },
});
