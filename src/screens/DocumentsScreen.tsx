import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
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
  countTrash,
  listDocuments,
  restoreDocument,
  setDocumentStarred,
  softDeleteDocument,
  type DocumentSort,
} from '../database/scannerDB';
import { fileUri } from '../utils/scanFiles';
import { showToast } from '../components/Toast';
import Menu, { type MenuAction } from '../components/Menu';
import Modal from '../components/Modal';
import DocDetailScreen from './DocDetailScreen';
import type { DocumentRecord } from '../types';

interface Props {
  active: boolean;
  /** 空状态那个「开始扫描」按钮要能切 Tab（走查 audit-23：原来只有一行字，让用户自己回忆） */
  onGoScan: () => void;
  /** 打开详情页 = 这个 Tab 有了二级页：App 要因此隐藏 TabBar 并把返回键让给这一层（audit-19） */
  onDetailOpen: (open: boolean) => void;
}

const SORTS: { key: DocumentSort; label: string }[] = [
  { key: 'updated', label: '最近改动' },
  { key: 'created', label: '创建时间' },
  { key: 'title', label: '名字' },
  { key: 'pages', label: '页数' },
];

/**
 * 文档列表。
 *
 * v0.2 的两处结构性改动（都来自走查）：
 *   - 长按不再直接物理删除整份文档（audit-3，那条 blocker）。长按弹菜单，
 *     删除走「移入回收站 + 5 秒撤销」，与详情页同一套语义；
 *   - 加了标题搜索与排序切换（audit-30）：以前 SQL 里写死 starred + 更新时间，
 *     文档一多就只能靠肉眼翻两列网格。
 */
export default function DocumentsScreen({ active, onGoScan, onDetailOpen }: Props) {
  const insets = useSafeAreaInsets();
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<DocumentSort>('updated');
  const [menuDoc, setMenuDoc] = useState<DocumentRecord | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DocumentRecord | null>(null);
  const [trashCount, setTrashCount] = useState(0);
  const [tick, setTick] = useState(0);

  const reload = useCallback(async () => {
    try {
      const [list, trash] = await Promise.all([listDocuments({ query, sort }), countTrash()]);
      setDocuments(list);
      setTrashCount(trash);
    } catch {
      showToast('读取文档列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [query, sort]);

  useEffect(() => {
    if (active) void reload();
  }, [active, reload, tick]);

  // 扫描页存了新文档 → 立刻刷新（跨页一致性靠事件，不靠各页自己记得去查）
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(SCANNER_EVENTS.SAVED, () => setTick((t) => t + 1));
    const sub2 = DeviceEventEmitter.addListener(SCANNER_EVENTS.DOCS_CHANGED, () => setTick((t) => t + 1));
    return () => {
      sub.remove();
      sub2.remove();
    };
  }, []);

  // 详情页开合要报给根：TabBar 隐藏与返回键归属都看这个（audit-19）
  useEffect(() => {
    onDetailOpen(openId !== null);
  }, [openId, onDetailOpen]);

  const moveDocToTrash = useCallback(async (doc: DocumentRecord) => {
    await softDeleteDocument(doc.id);
    setConfirmDelete(null);
    setTick((t) => t + 1);
    DeviceEventEmitter.emit(SCANNER_EVENTS.DOCS_CHANGED, { documentId: doc.id });
    showToast(`「${doc.title}」已移入回收站`, 'info', 5200, {
      label: '撤销',
      onPress: () => {
        void restoreDocument(doc.id).then(() => {
          setTick((t) => t + 1);
          showToast('已恢复', 'success');
        });
      },
    });
  }, []);

  const menuActions = useMemo<MenuAction[]>(() => {
    if (!menuDoc) return [];
    const doc = menuDoc;
    return [
      { key: 'open', label: '打开', onPress: () => setOpenId(doc.id) },
      {
        key: 'star',
        label: doc.starred ? '取消收藏' : '收藏',
        hint: '收藏的文档排在列表最前',
        onPress: () => {
          void setDocumentStarred(doc.id, !doc.starred).then(() => setTick((t) => t + 1));
        },
      },
      {
        key: 'trash',
        label: '移入回收站',
        hint: '30 天内可在「管理 → 回收站」捞回',
        danger: true,
        onPress: () => setConfirmDelete(doc),
      },
    ];
  }, [menuDoc]);

  if (openId !== null) {
    return (
      <DocDetailScreen
        documentId={openId}
        onBack={() => {
          setOpenId(null);
          void reload();
        }}
        onDeleted={() => {
          setOpenId(null);
          void reload();
        }}
      />
    );
  }

  return (
    <View style={styles.container}>
      <View style={{ height: insets.top + SPACING.md }} />
      <View style={styles.header}>
        <Text style={styles.title}>文档</Text>
        <Text style={styles.count}>{documents.length > 0 ? `${documents.length} 份` : ''}</Text>
      </View>

      <View style={styles.toolbar}>
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="搜文档名"
          placeholderTextColor={COLORS.textTertiary}
          accessibilityLabel="搜索文档名"
          returnKeyType="search"
        />
        <Pressable
          style={styles.sortBtn}
          onPress={() => {
            const next = SORTS[(SORTS.findIndex((s) => s.key === sort) + 1) % SORTS.length];
            setSort(next.key);
          }}
          accessibilityRole="button"
          accessibilityLabel={`排序：${SORTS.find((s) => s.key === sort)?.label}，点按切换`}
        >
          <Text style={styles.sortBtnText}>{SORTS.find((s) => s.key === sort)?.label} ›</Text>
        </Pressable>
      </View>

      {loading && documents.length === 0 ? (
        <View style={styles.grid}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={styles.skeleton} />
          ))}
        </View>
      ) : documents.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {query ? `没有名字含「${query}」的文档` : '还没有扫描的文档 ✨'}
          </Text>
          <Text style={styles.emptySub}>
            {query ? '换个词试试，或去扫描页拍一份。' : '拍一张纸，自动切边 + 摊平光照，存成一份文档。'}
          </Text>
          <Pressable style={styles.emptyBtn} onPress={onGoScan} accessibilityRole="button">
            <Text style={styles.emptyBtnText}>开始扫描</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={documents}
          keyExtractor={(item) => String(item.id)}
          numColumns={2}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.gridRow}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <Pressable
              style={[styles.card, item.starred && styles.cardStarred]}
              onPress={() => setOpenId(item.id)}
              onLongPress={() => setMenuDoc(item)}
              accessibilityRole="button"
              accessibilityLabel={`${item.title}，${item.pageCount} 页${item.starred ? '，已收藏' : ''}。长按有更多操作`}
              accessibilityHint="打开文档"
            >
              <View style={styles.thumbBox}>
                {item.coverPath ? (
                  <Image
                    source={{ uri: fileUri(item.coverPath) }}
                    style={styles.thumb}
                    resizeMode="cover"
                    accessibilityIgnoresInvertColors
                  />
                ) : (
                  <View style={styles.thumbPlaceholder}>
                    <Text style={styles.thumbPlaceholderText}>空</Text>
                  </View>
                )}
                {item.starred ? <Text style={styles.star}>★</Text> : null}
              </View>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.cardMeta} numberOfLines={1}>
                {item.pageCount} 页 · {formatDay(item.updatedAt)}
              </Text>
            </Pressable>
          )}
          ListHeaderComponent={
            trashCount > 0 ? (
              <Text style={styles.trashHint}>回收站里有 {trashCount} 份，30 天内可恢复（在「管理」里）</Text>
            ) : null
          }
        />
      )}
      <View style={{ height: SPACING.md }} />

      <Menu
        visible={menuDoc !== null}
        title={menuDoc?.title ?? ''}
        actions={menuActions}
        onClose={() => setMenuDoc(null)}
      />

      <Modal visible={confirmDelete !== null} title="移入回收站？" onClose={() => setConfirmDelete(null)}>
        <Text style={styles.confirmText}>
          {`${confirmDelete?.title ?? ''}（${confirmDelete?.pageCount ?? 0} 页）会先进回收站，30 天内还能恢复；这个 App 没有云端备份，删干净就真的没了。`}
        </Text>
        <Pressable
          style={styles.confirmBtn}
          onPress={() => confirmDelete && void moveDocToTrash(confirmDelete)}
          accessibilityRole="button"
        >
          <Text style={styles.confirmBtnText}>移入回收站</Text>
        </Pressable>
      </Modal>
    </View>
  );
}

function formatDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

/** 供详情/管理页复用的模式标签 */
export function ModeBadge({ mode }: { mode: string }) {
  return <ModeBadgeInner mode={mode} />;
}

function ModeBadgeInner({ mode }: { mode: string }) {
  // 与 constants 的 SCAN_MODES 同源，避免详情页出现第三种叫法
  const label =
    mode === 'hd'
      ? '智能高清'
      : mode === 'enhance'
        ? '增强'
        : mode === 'gray'
          ? '灰度'
          : mode === 'bw'
            ? '黑白'
            : '原图';
  return <Text style={styles.badge}>{label}</Text>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.sm,
  },
  title: { fontSize: FONT_SIZE.xl, fontWeight: '800', color: COLORS.text },
  count: { fontSize: FONT_SIZE.xs, color: COLORS.textTertiary },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.sm,
  },
  search: {
    flex: 1,
    minHeight: TOUCH.min,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    backgroundColor: COLORS.surface,
    fontSize: FONT_SIZE.sm,
    color: COLORS.text,
  },
  sortBtn: {
    minHeight: TOUCH.min,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sortBtnText: { fontSize: FONT_SIZE.sm, color: COLORS.accentDark, fontWeight: '600' },
  trashHint: {
    fontSize: FONT_SIZE.xs,
    color: COLORS.textTertiary,
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.sm,
  },
  grid: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.xxl, gap: SPACING.sm },
  gridRow: { gap: SPACING.sm },
  skeleton: {
    flex: 1,
    height: 168,
    borderRadius: RADIUS.lg,
    backgroundColor: COLORS.bgAlt,
  },
  card: {
    ...CARD,
    flex: 1,
    padding: SPACING.sm,
    gap: 4,
  },
  cardStarred: { borderColor: COLORS.accent },
  thumbBox: {
    height: 108,
    borderRadius: RADIUS.sm,
    overflow: 'hidden',
    backgroundColor: COLORS.bgAlt,
  },
  thumb: { width: '100%', height: '100%' },
  thumbPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  thumbPlaceholderText: { fontSize: FONT_SIZE.xs, color: COLORS.textTertiary },
  star: { position: 'absolute', top: 4, right: 6, fontSize: FONT_SIZE.sm, color: COLORS.accentDark },
  cardTitle: { fontSize: FONT_SIZE.sm, fontWeight: '600', color: COLORS.text },
  cardMeta: { fontSize: FONT_SIZE.xs, color: COLORS.textTertiary },
  empty: { alignItems: 'center', padding: SPACING.xl, gap: SPACING.sm },
  emptyText: { fontSize: FONT_SIZE.md, fontWeight: '700', color: COLORS.text, textAlign: 'center' },
  emptySub: { fontSize: FONT_SIZE.xs, color: COLORS.textSecondary, textAlign: 'center', lineHeight: 18 },
  emptyBtn: {
    minHeight: TOUCH.min,
    paddingHorizontal: SPACING.xl,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.accentDark,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.sm,
  },
  emptyBtnText: { color: COLORS.white, fontSize: FONT_SIZE.sm, fontWeight: '700' },
  confirmText: { fontSize: FONT_SIZE.sm, color: COLORS.textSecondary, lineHeight: 21 },
  confirmBtn: {
    minHeight: TOUCH.min,
    marginTop: SPACING.lg,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
  },
  confirmBtnText: { color: COLORS.white, fontSize: FONT_SIZE.md, fontWeight: '700' },
  badge: {
    fontSize: FONT_SIZE.xs,
    color: COLORS.accentDark,
    backgroundColor: COLORS.accentSoft,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    overflow: 'hidden',
  },
});
