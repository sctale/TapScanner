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
import { COLORS, CARD, FONT_SIZE, RADIUS, SCANNER_EVENTS, SPACING, TOUCH } from '../constants';
import {
  deletePage,
  getDocument,
  listPages,
  movePageToEdge,
  movePageToNewDocument,
  renameDocument,
  setDocumentStarred,
  softDeleteDocument,
  swapPagePositions,
  updatePageRender,
} from '../database/scannerDB';
import { fileUri } from '../utils/scanFiles';
import { exportDocumentPdf, safeFileName, shareFile, sharePageJpg } from '../utils/exportActions';
import { rerenderPage } from '../utils/scanPipeline';
import { loadSettings } from '../utils/appSettings';
import { resolveRenderOptions } from '../utils/renderOptions';
import { normalizeRotation, scannerErrorCode, scannerErrorMessage } from '../native/ScannerNative';
import Toast, { showToast } from '../components/Toast';
import { useBackHandler } from '../hooks/useBackHandler';
import Modal from '../components/Modal';
import Menu, { type MenuAction } from '../components/Menu';
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
 * v0.2 补上走查里缺的控制力：删单页、重跑单页、把一页拆成新文档、导出后可再分享。
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
  const [menuPage, setMenuPage] = useState<PageRecord | null>(null);

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

  /** 对某一页换档：原图不动，重新出一版成品 */
  const changeModeFor = useCallback(
    async (page: PageRecord, mode: ScanMode) => {
      if (!document) return;
      setBusy(true);
      try {
        const settings = await loadSettings();
        // 渲染参数走同一个解析器：以前这条路径带 jpegQuality、扫描页那条不带，
        // 同一页两边能出两种质量（走查 audit-16）
        const { result, quad } = await rerenderPage({
          docUuid: document.uuid,
          pageUuid: page.uuid,
          rawPath: page.rawPath,
          mode,
          quad: page.quad,
          options: resolveRenderOptions(settings),
          rotation: page.rotation,
        });
        await updatePageRender(page.id, {
          mode,
          outPath: result.outPath,
          thumbPath: result.thumbPath,
          quad,
          rotation: page.rotation,
          metrics: result.metricsAfter,
          stages: result.stages,
          width: result.width,
          height: result.height,
        });
        await reload();
        showToast(`第 ${page.position + 1} 页已换成${mode === 'hd' ? '智能高清' : '新档位'}`, 'success');
      } catch (error) {
        showToast(scannerErrorMessage(scannerErrorCode(error), (error as Error)?.message), 'error');
      } finally {
        setBusy(false);
      }
    },
    [document, reload],
  );

  const changeMode = useCallback(
    async (mode: ScanMode) => {
      if (!selected) return;
      await changeModeFor(selected, mode);
    },
    [changeModeFor, selected],
  );

  /**
   * 整份换成同一档（走查 audit-24：多页文档换档原来要逐页点，每点一次等一整条管线）。
   *
   * 串行是对的 —— 原生那条 Executor 本来就是单线程，并发只会让顺序不可预期。
   * 与单页版的区别是：只在全部跑完后 reload + 报一次，不是一页一次 Toast。
   */
  const applyToAll = useCallback(
    async (mode: ScanMode) => {
      if (!document) return;
      setBusy(true);
      const settings = await loadSettings();
      let failed = 0;
      for (const page of pages) {
        try {
          // 串行是有意的：原生是单线程队列，并发只会让顺序不可预期
          const { result, quad } = await rerenderPage({
            docUuid: document.uuid,
            pageUuid: page.uuid,
            rawPath: page.rawPath,
            mode,
            quad: page.quad,
            options: resolveRenderOptions(settings),
            rotation: page.rotation,
          });
          await updatePageRender(page.id, {
            mode,
            outPath: result.outPath,
            thumbPath: result.thumbPath,
            quad,
            rotation: page.rotation,
            metrics: result.metricsAfter,
            stages: result.stages,
            width: result.width,
            height: result.height,
          });
        } catch {
          failed += 1;
        }
      }
      await reload();
      setBusy(false);
      showToast(
        failed > 0 ? `整份换档完成，${failed} 页失败` : `已把 ${pages.length} 页换成这一档`,
        failed > 0 ? 'error' : 'success',
      );
    },
    [document, pages, reload],
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

  /** 移到顶/底：10 页文档挪一位原来要按 9 次（走查 audit-28） */
  const moveToEdge = useCallback(
    async (page: PageRecord, edge: 'top' | 'bottom') => {
      if (!document) return;
      await movePageToEdge(document.id, page.id, edge);
      await reload();
    },
    [document, reload],
  );

  /**
   * 删掉一页。
   *
   * 磁盘上的 raw 一并删：这一页的成品和原图都没有别处引用了，留着就是孤儿。
   * （文档级删除走回收站，页级删除本来就是用户明确要精简，不再套一层回收站。）
   */
  const removePage = useCallback(
    async (page: PageRecord) => {
      if (!document) return;
      await deletePage(page.id, document.id);
      await reload();
      showToast('这一页已删除', 'success');
    },
    [document, reload],
  );

  const splitToNewDocument = useCallback(
    async (page: PageRecord) => {
      if (!document) return;
      try {
        const { document: created, moved } = await movePageToNewDocument(page.id, `${document.title} 拆出`);
        if (!moved) {
          showToast('只剩这一页，没什么可拆的', 'info');
          return;
        }
        await reload();
        DeviceEventEmitter.emit(SCANNER_EVENTS.DOCS_CHANGED, { documentId: created.id });
        showToast(`已拆成「${created.title}」`, 'success');
      } catch (error) {
        showToast((error as Error)?.message ?? '拆分失败', 'error');
      }
    },
    [document, reload],
  );

  /** 重跑单页用当前设置：走查里「重拍那一页再导出」是没有入口的死路（audit-7） */
  const rerunCurrent = useCallback(
    async (page: PageRecord) => {
      if (!document) return;
      setBusy(true);
      try {
        const settings = await loadSettings();
        const { result, quad } = await rerenderPage({
          docUuid: document.uuid,
          pageUuid: page.uuid,
          rawPath: page.rawPath,
          mode: page.mode,
          quad: page.quad,
          options: resolveRenderOptions(settings),
          rotation: page.rotation,
        });
        await updatePageRender(page.id, {
          mode: page.mode,
          outPath: result.outPath,
          thumbPath: result.thumbPath,
          quad,
          rotation: page.rotation,
          metrics: result.metricsAfter,
          stages: result.stages,
          width: result.width,
          height: result.height,
        });
        await reload();
        showToast('这一页已按当前设置重跑', 'success');
      } catch (error) {
        showToast(scannerErrorMessage(scannerErrorCode(error), (error as Error)?.message), 'error');
      } finally {
        setBusy(false);
      }
    },
    [document, reload],
  );

  /**
   * 旋正一页（存档后也能改）：转的是成品，原图与四角都不动，所以随时能转回去。
   * delta 用 ±90；转完立刻重出图，界面上的那一页就是转好的样子。
   */
  const rotatePage = useCallback(
    async (page: PageRecord, delta: number) => {
      if (!document) return;
      setBusy(true);
      try {
        const settings = await loadSettings();
        const rotation = normalizeRotation(page.rotation + delta);
        const { result, quad } = await rerenderPage({
          docUuid: document.uuid,
          pageUuid: page.uuid,
          rawPath: page.rawPath,
          mode: page.mode,
          quad: page.quad,
          options: resolveRenderOptions(settings),
          rotation,
        });
        await updatePageRender(page.id, {
          mode: page.mode,
          outPath: result.outPath,
          thumbPath: result.thumbPath,
          quad,
          rotation,
          metrics: result.metricsAfter,
          stages: result.stages,
          width: result.width,
          height: result.height,
        });
        await reload();
      } catch (error) {
        showToast(scannerErrorMessage(scannerErrorCode(error), (error as Error)?.message), 'error');
      } finally {
        setBusy(false);
      }
    },
    [document, reload],
  );

  const pageMenu = useMemo<MenuAction[]>(() => {
    if (!menuPage) return [];
    const page = menuPage;
    return [
      {
        key: 'rerun',
        label: '按当前设置重跑这一页',
        hint: '原图不动，重新出一版成品',
        onPress: () => void rerunCurrent(page),
      },
      {
        key: 'rotate-left',
        label: '左转 90°',
        hint: page.rotation ? `当前已转 ${page.rotation}°` : undefined,
        onPress: () => void rotatePage(page, -90),
      },
      {
        key: 'rotate-right',
        label: '右转 90°',
        hint: page.rotation ? `当前已转 ${page.rotation}°` : undefined,
        onPress: () => void rotatePage(page, 90),
      },
      {
        key: 'top',
        label: '移到最前',
        disabled: page.position === 0,
        onPress: () => void moveToEdge(page, 'top'),
      },
      {
        key: 'bottom',
        label: '移到最后',
        disabled: page.position >= pages.length - 1,
        onPress: () => void moveToEdge(page, 'bottom'),
      },
      {
        key: 'split',
        label: '拆成一份新文档',
        hint: pages.length <= 1 ? '只剩这一页，没法拆' : undefined,
        disabled: pages.length <= 1,
        onPress: () => void splitToNewDocument(page),
      },
      {
        key: 'delete',
        label: '删除这一页',
        hint: `${page.position + 1} 页的原图和成品一起删掉，删了找不回`,
        danger: true,
        onPress: () => void removePage(page),
      },
    ];
  }, [menuPage, moveToEdge, pages.length, removePage, rerunCurrent, rotatePage, splitToNewDocument]);

  const doExportPdf = useCallback(async () => {
    if (!document) return;
    setBusy(true);
    try {
      const settings = await loadSettings();
      const result = await exportDocumentPdf(document.id, { pageSizeMode: settings.pdfPageSize });
      await shareFile(result.path, 'application/pdf', safeFileName(document.title));
      // 面板里点了取消也算「生成成功」：文件确实在 App 目录里，详情页随时能再分享
      showToast(`已生成 ${result.pages} 页 PDF（${result.fileName}）`, 'success');
      await reload();
    } catch (error) {
      showToast((error as Error)?.message ?? '导出 PDF 失败', 'error');
    } finally {
      setBusy(false);
    }
  }, [document, reload]);

  const resharePdf = useCallback(async () => {
    if (!document?.pdfPath) return;
    try {
      await shareFile(document.pdfPath, 'application/pdf', safeFileName(document.title));
    } catch (error) {
      showToast((error as Error)?.message ?? '分享失败', 'error');
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

  /**
   * 删整份文档 = 进回收站，30 天内能捞回来。
   *
   * v0.1 这里直接删记录 + 删图片目录，「长按一下就全没了」（audit-2/3）。
   * 现在只打标记，文件原地不动，恢复也就是一句话。
   */
  const doDelete = useCallback(async () => {
    if (!document) return;
    const id = document.id;
    const title = document.title;
    await softDeleteDocument(id);
    setConfirmDelete(false);
    onDeleted();
    DeviceEventEmitter.emit(SCANNER_EVENTS.DOCS_CHANGED, { documentId: id });
    showToast(`「${title}」已移入回收站`, 'info', 5200, {
      label: '撤销',
      onPress: () => {
        void (async () => {
          const { restoreDocument } = await import('../database/scannerDB');
          await restoreDocument(id);
          DeviceEventEmitter.emit(SCANNER_EVENTS.DOCS_CHANGED, { documentId: id });
          showToast('已恢复', 'success');
        })();
      },
    });
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
              onLongPress={() => setMenuPage(item)}
              accessibilityRole="button"
              accessibilityLabel={`第 ${item.position + 1} 页，${MODE_LABEL[item.mode]}。长按有更多操作`}
              accessibilityState={{ selected: isSelected }}
            >
              <View style={styles.rowThumb}>
                {item.thumbPath ? (
                  <Image
                    source={{
                      // 同一页重渲染写的是同一个文件名，URI 不变 → Fresco 给旧图。
                      // updatedAt 每次 updatePageRender 都会变，正好当版本号用。
                      uri: `${fileUri(item.thumbPath)}?v=${item.updatedAt}-${item.rotation}`,
                    }}
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
                {/* 走查 audit-12：原来这里印的是「亮度 78 · 锐度 143」，用户不需要读指标 */}
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {item.width}×{item.height}
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
                  <Pressable
                    style={styles.miniBtn}
                    onPress={() => setMenuPage(item)}
                    accessibilityLabel="这一页的更多操作"
                  >
                    <Text style={styles.miniBtnText}>更多</Text>
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
        {document.pdfPath ? (
          <Pressable style={styles.pdfRow} onPress={() => void resharePdf()} accessibilityRole="button">
            <Text style={styles.pdfRowText} numberOfLines={1}>
              已导出 PDF · 再分享一次
            </Text>
            <Text style={styles.pdfRowChevron}>›</Text>
          </Pressable>
        ) : null}
        <Text style={styles.footerLabel}>{selected ? '换一档（原图不动，重新出一版）' : '选一页'}</Text>
        <FilterChips
          value={selected?.mode ?? 'hd'}
          onChange={(mode) => void changeMode(mode)}
          disabled={busy || !selected}
        />
        {pages.length > 1 && selected ? (
          <Pressable
            style={styles.textButton}
            onPress={() => void applyToAll(selected.mode)}
            accessibilityRole="button"
          >
            <Text style={styles.textButtonText}>整份都换成这一档（{pages.length} 页）</Text>
          </Pressable>
        ) : null}
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
          {`${document.title}（${document.pageCount} 页）会移进回收站，30 天内在「管理 → 回收站」里还能捞回来；超过 30 天自动清掉。`}
        </Text>
        <Pressable style={[styles.primaryBtn, { marginTop: SPACING.lg }]} onPress={() => void doDelete()}>
          <Text style={styles.primaryBtnText}>移入回收站</Text>
        </Pressable>
      </Modal>

      <Menu
        visible={menuPage !== null}
        title={menuPage ? `第 ${menuPage.position + 1} 页` : ''}
        actions={pageMenu}
        onClose={() => setMenuPage(null)}
      />

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
    paddingVertical: SPACING.xs,
    // 走查 audit-38：原来 4 的上下内边距量出来只有约 26dp，手指按不准
    minHeight: TOUCH.min,
    alignItems: 'center',
    justifyContent: 'center',
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
  pdfRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: TOUCH.min,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    backgroundColor: COLORS.surfaceAlt,
  },
  pdfRowText: { flex: 1, fontSize: FONT_SIZE.sm, color: COLORS.accentDark, fontWeight: '600' },
  pdfRowChevron: { fontSize: FONT_SIZE.md, color: COLORS.textTertiary },
  textButton: { minHeight: TOUCH.min, justifyContent: 'center' },
  textButtonText: { fontSize: FONT_SIZE.sm, color: COLORS.accentDark, fontWeight: '600' },
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
