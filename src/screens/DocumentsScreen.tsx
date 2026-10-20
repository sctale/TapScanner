import React, { useCallback, useEffect, useState } from 'react';
import { DeviceEventEmitter, FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, CARD, FONT_SIZE, RADIUS, SCANNER_EVENTS, SPACING, findMode } from '../constants';
import { deleteDocument, listDocuments } from '../database/scannerDB';
import { deleteDocumentFiles, fileUri } from '../utils/scanFiles';
import { showToast } from '../components/Toast';
import DocDetailScreen from './DocDetailScreen';
import type { DocumentRecord } from '../types';

/**
 * 文档页：入口列表 + 二级页（沿用 TapLedger 管理页的结构约定：并列页 + ‹ 返回）。
 */
export default function DocumentsScreen({ active = true }: { active?: boolean }) {
  const insets = useSafeAreaInsets();
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(async () => {
    try {
      const list = await listDocuments();
      setDocuments(list);
    } catch {
      showToast('读取文档列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void reload();
  }, [active, reload, tick]);

  // 扫描页存了新文档 → 立刻刷新（跨页一致性靠事件，不靠各页自己记得去查）
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(SCANNER_EVENTS.SAVED, () => setTick((t) => t + 1));
    return () => sub.remove();
  }, []);

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

  const removeDirect = async (doc: DocumentRecord) => {
    // 长按删除：先删文件再删记录，顺序反了会留下没人引用的孤儿目录
    const uuid = await deleteDocument(doc.id);
    deleteDocumentFiles(uuid ?? doc.uuid);
    void reload();
    showToast('已删除', 'success');
  };

  return (
    <View style={styles.container}>
      <View style={{ height: insets.top + SPACING.md }} />
      <View style={styles.header}>
        <Text style={styles.title}>文档</Text>
        <Text style={styles.count}>{documents.length > 0 ? `${documents.length} 份` : ''}</Text>
      </View>

      {documents.length === 0 && !loading ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>还没有扫描的文档 ✨</Text>
          <Text style={styles.emptySub}>去「扫描」页按快门，拍完点保存就在这里了</Text>
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
              onLongPress={() => void removeDirect(item)}
              accessibilityRole="button"
              accessibilityLabel={`${item.title}，${item.pageCount} 页`}
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
        />
      )}
      <View style={{ height: SPACING.md }} />
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
  const def = findMode(mode);
  return <Text style={styles.badge}>{def.label}</Text>;
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
  grid: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.xxl },
  gridRow: { gap: SPACING.sm },
  card: {
    ...CARD,
    flex: 1,
    marginBottom: SPACING.sm,
    padding: SPACING.sm,
    gap: 4,
  },
  cardStarred: { borderColor: COLORS.accent },
  thumbBox: {
    height: 108,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.bgAlt,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumb: { width: '100%', height: '100%' },
  thumbPlaceholder: { position: 'absolute' },
  thumbPlaceholderText: { color: COLORS.textTertiary, fontSize: FONT_SIZE.xs },
  star: { position: 'absolute', top: 4, right: 6, color: COLORS.accent, fontSize: FONT_SIZE.sm },
  cardTitle: { fontSize: FONT_SIZE.sm, fontWeight: '700', color: COLORS.text },
  cardMeta: { fontSize: FONT_SIZE.xs, color: COLORS.textTertiary },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.xl },
  emptyText: { fontSize: FONT_SIZE.lg, fontWeight: '700', color: COLORS.textSecondary },
  emptySub: { fontSize: FONT_SIZE.xs, color: COLORS.textTertiary, textAlign: 'center' },
  badge: {
    fontSize: FONT_SIZE.xs,
    color: COLORS.accentDark,
    backgroundColor: `${COLORS.accent}18`,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: RADIUS.pill,
    overflow: 'hidden',
  },
});
