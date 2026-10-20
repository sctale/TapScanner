import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { Camera, useCameraPermission, usePhotoOutput, type CameraRef } from 'react-native-vision-camera';
import { COLORS, CARD, FONT_SIZE, RADIUS, SPACING, findMode, genUuid } from '../constants';
import { isEngineReady, scannerErrorCode, scannerErrorMessage } from '../native/ScannerNative';
import {
  renderCapture,
  savePagesAsDocument,
  importSource,
  analyzeRaw,
  type RawCapture,
  type RenderedPage,
} from '../utils/scanPipeline';
import { clearFailure, recordFailure, type FailureRecord } from '../utils/diagnostics';
import { cropLabel } from '../utils/modeSelection';
import { fileUri } from '../utils/scanFiles';
import { loadSettings } from '../utils/appSettings';
import { useBackHandler } from '../hooks/useBackHandler';
import CornerAdjust from '../components/CornerAdjust';
import FilterChips from '../components/FilterChips';
import { showToast } from '../components/Toast';
import type { QuadPoint, ScanMode } from '../types';

type Stage = 'camera' | 'review' | 'crop';

interface Settings {
  autoCrop: boolean;
  outputMaxSide: number;
  defaultMode: ScanMode;
}

const DEFAULT_SETTINGS: Settings = { autoCrop: true, outputMaxSide: 3000, defaultMode: 'hd' };

/** 出错环节的用户语言（内部 step 码不变，只是别让用户看英文键名） */
const STEP_LABEL: Record<string, string> = {
  capture: '拍照',
  'capture-fallback': '拍照（备用路径）',
  relocate: '保存图片',
  analyze: '识别纸边',
  process: '智能高清处理',
  save: '保存到文档',
};

/** 文档默认标题：时间戳最实用，用户之后可以改名 */
function defaultTitle(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `扫描 ${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/**
 * 扫描页（首页）。
 *
 * 结构上的三条 Tap 红线：
 *   - 启动即相机，零跳转；
 *   - review / crop 是**并列页**，靠 display 互斥切换，不用 Modal 盖相机
 *     （相机是原生视图层，Modal 盖上去触摸和安全区行为都会变，这是 TapLedger 用一轮重写换来的结论）；
 *   - 反馈一律走全局非模态 Toast。
 *
 * 交互顺序对齐扫描全能王：按快门 → 立刻看到切好边、增强完的一页 →
 * 不满意就换档 / 调四角 / 重拍 → 满意了继续拍或完成。
 */
export default function ScanScreen({ active = true }: { active?: boolean }) {
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraRef>(null);
  const { hasPermission, requestPermission } = useCameraPermission();
  const photoOutput = usePhotoOutput({ quality: 0.95, qualityPrioritization: 'quality' });

  // 第一次拍摄前就决定目录名；保存时数据库记录复用同一个 uuid
  const docUuid = useRef<string>(genUuid());
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [captures, setCaptures] = useState<RawCapture[]>([]);
  const [rendered, setRendered] = useState<Record<string, RenderedPage>>({});
  const [quads, setQuads] = useState<Record<string, QuadPoint[]>>({});
  const [modes, setModes] = useState<Record<string, ScanMode>>({});
  const [index, setIndex] = useState(0);
  const [stage, setStage] = useState<Stage>('camera');
  const [busy, setBusy] = useState(false);
  const [torch, setTorch] = useState(false);
  const [engineMissing, setEngineMissing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // 失败现场常驻显示：Toast 2 秒就没了，而失败点全在相机/原生层，
  // 手机连不上 adb 时，屏幕上这一整块英文是唯一能把根因带回来的东西。
  const [failure, setFailure] = useState<FailureRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const info = await isEngineReady();
      if (!cancelled && !info.ready) setEngineMissing(true);
      const loaded = await loadSettings();
      if (!cancelled) setSettings(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 二级页吃掉返回：crop → review → camera
  useBackHandler(stage !== 'camera', () => setStage(stage === 'crop' ? 'review' : 'camera'));

  const safeIndex = Math.min(index, Math.max(0, captures.length - 1));
  const current = captures.length > 0 ? captures[safeIndex] : undefined;
  const currentRender = current ? rendered[current.uuid] : undefined;
  const currentQuad = current ? (quads[current.uuid] ?? current.analyze.quad) : null;
  const currentMode: ScanMode = current
    ? (modes[current.uuid] ?? settings.defaultMode)
    : settings.defaultMode;

  /** 拍摄 / 换档 / 改四角都走这里。失败时如实 Toast，不留一张「看起来成功了」的废图 */
  const runRender = useCallback(
    async (capture: RawCapture, mode: ScanMode, quad: QuadPoint[] | null) => {
      setBusy(true);
      setNote(null);
      try {
        const page = await renderCapture(capture, docUuid.current, mode, quad, {
          autoCrop: settings.autoCrop,
          outputMaxSide: settings.outputMaxSide,
        });
        setRendered((prev) => ({ ...prev, [capture.uuid]: page }));
        setQuads((prev) => ({ ...prev, [capture.uuid]: page.quad }));
        setModes((prev) => ({ ...prev, [capture.uuid]: mode }));
        setNote(cropLabel(capture.analyze.detected, capture.analyze.confidence));
        return page;
      } catch (error) {
        setFailure(recordFailure('process', error, { mode, path: capture.rawPath.slice(-40) }));
        showToast(scannerErrorMessage(scannerErrorCode(error), (error as Error)?.message), 'error', 4200);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [settings.autoCrop, settings.outputMaxSide],
  );

  const handleCapturedFile = useCallback(
    async (sourcePath: string) => {
      if (busy) return;
      setBusy(true);
      setFailure(null);
      try {
        // 搬运与感知分两步：出错时能分清是「文件没进应用目录」还是「原生读不出这张图」
        const imported = await importSource(sourcePath, docUuid.current);
        const capture = await analyzeRaw(imported.pageUuid, imported.rawPath);
        const mode = settings.defaultMode;
        setCaptures((prev) => {
          const next = [...prev, capture];
          setIndex(next.length - 1);
          return next;
        });
        setModes((prev) => ({ ...prev, [capture.uuid]: mode }));
        setQuads((prev) => ({ ...prev, [capture.uuid]: capture.analyze.quad }));
        setStage('review');
        void runRender(capture, mode, capture.analyze.quad);
      } catch (error) {
        const moving =
          (error as Error)?.message?.includes('原始图片') || (error as Error)?.message?.includes('搬运后');
        setFailure(
          recordFailure(moving ? 'relocate' : 'analyze', error, {
            source: sourcePath.slice(-48),
          }),
        );
        showToast(scannerErrorMessage(scannerErrorCode(error), (error as Error)?.message), 'error', 4200);
      } finally {
        setBusy(false);
      }
    },
    [busy, runRender, settings.defaultMode],
  );

  /** v5 的补光不走 Camera 的 prop，而是命令式设在 controller 上 */
  const toggleTorch = useCallback(() => {
    setTorch((prev) => {
      const next = !prev;
      const controller = cameraRef.current?.controller;
      if (controller) {
        controller.setTorchMode(next ? 'on' : 'off').catch(() => {
          // 设备没有闪光灯 / 会话还没起来：保持按钮状态，不做假报错
        });
      }
      return next;
    });
  }, []);

  /**
   * 快门：先走「直接写文件」，失败再退到「内存 Photo → 存临时文件」。
   *
   * 两条路都是 VisionCamera v5 的公开 API；留第二条不是为了绕，而是为了让报错自己说话：
   *   - 两条都挂 → 卡片里同时给出两个 message，根因基本就在其中一条
   *   - 只有第一条挂 → 是 capturePhotoToFile 这条路径的问题（Android 侧写文件），能定位到库的实现
   */
  const shutter = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const settings0 = { enableShutterSound: false, flashMode: torch ? ('on' as const) : ('off' as const) };
    let filePath: string | null = null;
    let firstError: unknown = null;
    try {
      const photo = await photoOutput.capturePhotoToFile(settings0, {});
      filePath = photo.filePath;
    } catch (error) {
      firstError = error;
      try {
        const photo = await photoOutput.capturePhoto(settings0, {});
        filePath = await photo.saveToTemporaryFileAsync();
        // v5 的内存 Photo 持有原生缓冲池，用完必须显式释放，不能等 JS 运行时回收
        photo.dispose();
      } catch (fallbackError) {
        setFailure(
          recordFailure('capture-fallback', fallbackError, {
            primary: firstError
              ? `${(firstError as Error)?.name ?? ''}: ${(firstError as Error)?.message ?? ''}`.slice(0, 120)
              : 'none',
          }),
        );
        showToast('拍照失败，屏幕上有完整原因', 'error', 5000);
        return;
      }
    }
    setBusy(false);
    if (filePath) void handleCapturedFile(filePath);
  }, [busy, handleCapturedFile, photoOutput, torch]);

  const pickFromAlbum = useCallback(async () => {
    if (busy) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      showToast('没有相册权限', 'info');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      quality: 1,
      selectionLimit: 9,
    });
    if (result.canceled || result.assets.length === 0) return;
    for (const asset of result.assets) {
      // 逐个走同一条管线：相册图和相机图没有区别对待
      await handleCapturedFile(asset.uri);
    }
  }, [busy, handleCapturedFile]);

  const changeMode = useCallback(
    (mode: ScanMode) => {
      if (!current) return;
      setModes((prev) => ({ ...prev, [current.uuid]: mode }));
      void runRender(current, mode, quads[current.uuid] ?? current.analyze.quad);
    },
    [current, quads, runRender],
  );

  const confirmQuad = useCallback(
    (quad: QuadPoint[]) => {
      if (!current) return;
      setQuads((prev) => ({ ...prev, [current.uuid]: quad }));
      setStage('review');
      void runRender(current, currentMode, quad);
    },
    [current, currentMode, runRender],
  );

  const retake = useCallback(() => {
    if (!current) return;
    const remaining = captures.filter((c) => c.uuid !== current.uuid);
    setCaptures(remaining);
    setRendered((prev) => {
      const next = { ...prev };
      delete next[current.uuid];
      return next;
    });
    setIndex(remaining.length === 0 ? 0 : Math.min(safeIndex, remaining.length - 1));
    setStage(remaining.length > 0 ? 'review' : 'camera');
  }, [captures, current, safeIndex]);

  const finish = useCallback(async () => {
    const pages = captures.map((c) => rendered[c.uuid]).filter((p): p is RenderedPage => Boolean(p));
    if (pages.length !== captures.length) {
      showToast('还有页面没处理完，稍等一下', 'info');
      return;
    }
    setBusy(true);
    try {
      const saved = await savePagesAsDocument(docUuid.current, defaultTitle(), pages);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      showToast(`已保存 ${saved.pageCount} 页`, 'success');
      docUuid.current = genUuid();
      setCaptures([]);
      setRendered({});
      setQuads({});
      setModes({});
      setIndex(0);
      setStage('camera');
    } catch (error) {
      setFailure(recordFailure('save', error, { pages: pages.length }));
      showToast((error as Error)?.message ?? '保存失败', 'error', 4200);
    } finally {
      setBusy(false);
    }
  }, [captures, rendered]);

  const discard = useCallback(() => {
    setCaptures([]);
    setRendered({});
    setQuads({});
    setModes({});
    setIndex(0);
    docUuid.current = genUuid();
    setStage('camera');
  }, []);

  const suggestion = current?.suggestion ?? null;

  if (engineMissing) {
    return (
      <View style={styles.centerLight}>
        <Text style={styles.title}>图像引擎不可用</Text>
        <Text style={styles.body}>
          这个包的 OpenCV 原生库没有加载成功，扫描和增强都会失败。请重装最新版 APK；仍然这样的话，把「管理 ·
          关于」里的版本号发到 Issue。
        </Text>
      </View>
    );
  }

  if (!hasPermission) {
    return (
      <View style={styles.centerLight}>
        <Text style={styles.title}>需要相机权限</Text>
        <Text style={styles.body}>
          扫描件全部留在你手机里，不上传、不需要账号。相机只在你按下快门时用一次。
        </Text>
        <Pressable style={styles.primaryButton} onPress={() => void requestPermission()}>
          <Text style={styles.primaryButtonText}>打开相机</Text>
        </Pressable>
        <Pressable style={styles.textButton} onPress={() => void pickFromAlbum()}>
          <Text style={styles.textButtonText}>先从相册导入</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* 相机：review/crop 时只隐藏不卸载，避免每次回来重开会话 */}
      <View style={[styles.page, stage !== 'camera' && styles.pageHidden]}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device="back"
          isActive={active && stage === 'camera'}
          outputs={[photoOutput]}
          implementationMode="compatible"
          resizeMode="cover"
        />
        <View style={[styles.cameraTop, { paddingTop: insets.top + SPACING.sm }]}>
          <Text style={styles.cameraHint}>把纸放平，稍微俯视也能切正</Text>
        </View>
        <View style={[styles.cameraBottom, { paddingBottom: insets.bottom + SPACING.lg }]}>
          {note ? <Text style={styles.cameraNote}>{note}</Text> : null}
          <View style={styles.cameraControls}>
            <Pressable
              style={[styles.roundButton, torch && styles.roundButtonActive]}
              onPress={toggleTorch}
              accessibilityRole="button"
              accessibilityLabel={torch ? '关闭补光' : '打开补光'}
              accessibilityState={{ selected: torch }}
            >
              <Text style={styles.roundButtonText}>{torch ? '关灯' : '补光'}</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.shutter,
                pressed && styles.shutterPressed,
                busy && styles.shutterBusy,
              ]}
              onPress={() => void shutter()}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="拍照扫描"
            >
              {busy ? <ActivityIndicator color={COLORS.accent} /> : <View style={styles.shutterInner} />}
            </Pressable>
            <Pressable
              style={styles.roundButton}
              onPress={() => void pickFromAlbum()}
              accessibilityRole="button"
              accessibilityLabel="从相册导入"
            >
              <Text style={styles.roundButtonText}>相册</Text>
            </Pressable>
          </View>
          {captures.length > 0 ? (
            <Pressable style={styles.queueButton} onPress={() => setStage('review')}>
              <Text style={styles.queueButtonText}>继续看已拍的 {captures.length} 页</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* review：成品 + 模式 + 四角入口 + 页码条 */}
      <View style={[styles.page, stage !== 'review' && styles.pageHidden]}>
        <View style={{ height: insets.top + SPACING.xs }} />
        <View style={styles.reviewNav}>
          <Pressable onPress={discard} hitSlop={10} accessibilityRole="button" accessibilityLabel="放弃这组">
            <Text style={styles.navMuted}>放弃</Text>
          </Pressable>
          <Text style={styles.navTitle} numberOfLines={1}>
            {captures.length > 0 ? `${safeIndex + 1} / ${captures.length} 页` : '没有页面'}
          </Text>
          <Pressable
            style={styles.doneMini}
            disabled={busy || captures.length === 0}
            onPress={() => void finish()}
            accessibilityRole="button"
          >
            <Text style={[styles.doneMiniText, (busy || captures.length === 0) && styles.muted]}>完成</Text>
          </Pressable>
        </View>

        <View style={styles.previewBox}>
          {currentRender ? (
            <Image
              source={{ uri: fileUri(currentRender.result.outPath) }}
              style={styles.previewImage}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
            />
          ) : current ? (
            <Image
              source={{ uri: fileUri(current.rawPath) }}
              style={styles.previewImage}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
            />
          ) : null}
          {busy ? (
            <View style={styles.busyOverlay} pointerEvents="none">
              <View style={styles.busyCard}>
                <ActivityIndicator color={COLORS.accent} />
                <Text style={styles.busyText}>智能高清处理中…</Text>
              </View>
            </View>
          ) : null}
        </View>

        <View style={styles.reviewBody}>
          <Text style={styles.modeHint}>
            {findMode(currentMode).hint}
            {suggestion && current ? ` · 建议：${suggestion.reason}` : ''}
          </Text>
          <FilterChips
            value={currentMode}
            onChange={changeMode}
            disabled={busy || !current}
            suggested={suggestion?.mode ?? null}
          />
          <View style={styles.adjustRow}>
            <Pressable
              style={styles.outlineButton}
              disabled={!current || busy}
              onPress={() => setStage('crop')}
              accessibilityRole="button"
            >
              <Text style={styles.outlineButtonText}>调整四角</Text>
            </Pressable>
            <Pressable
              style={[styles.outlineButton, settings.autoCrop && styles.outlineActive]}
              onPress={() => setSettings((s) => ({ ...s, autoCrop: !s.autoCrop }))}
              accessibilityRole="button"
              accessibilityState={{ selected: settings.autoCrop }}
            >
              <Text style={styles.outlineButtonText}>自动切边 {settings.autoCrop ? '开' : '关'}</Text>
            </Pressable>
            <Pressable style={styles.outlineButton} onPress={retake} accessibilityRole="button">
              <Text style={styles.outlineButtonText}>重拍</Text>
            </Pressable>
          </View>
          {note ? <Text style={styles.note}>{note}</Text> : null}
          {currentRender ? (
            <Text style={styles.metrics}>
              {currentRender.result.width}×{currentRender.result.height} ·{' '}
              {Math.round(currentRender.result.stages.totalMs)}ms ·{' '}
              {currentRender.result.autoCropped ? '自动切边' : '未自动切边'}
            </Text>
          ) : null}

          <PageStrip
            pages={captures}
            rendered={rendered}
            index={safeIndex}
            onSelect={setIndex}
            onAdd={() => setStage('camera')}
          />

          <View style={styles.actions}>
            <Pressable style={styles.secondaryButton} onPress={() => setStage('camera')} disabled={busy}>
              <Text style={styles.secondaryButtonText}>继续拍</Text>
            </Pressable>
            <Pressable
              style={[styles.primaryButton, (busy || captures.length === 0) && styles.disabled]}
              disabled={busy || captures.length === 0}
              onPress={() => void finish()}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>保存文档</Text>
            </Pressable>
          </View>
        </View>
      </View>

      {/* crop：并列页（不卸载 review，回去时状态还在） */}
      <View style={[styles.page, stage !== 'crop' && styles.pageHidden]}>
        {current && currentQuad ? (
          <CornerAdjust
            path={current.rawPath}
            imageWidth={current.width}
            imageHeight={current.height}
            initialQuad={currentQuad}
            onConfirm={confirmQuad}
            onCancel={() => setStage('review')}
            onReset={() => setQuads((prev) => ({ ...prev, [current.uuid]: current.analyze.quad }))}
          />
        ) : null}
      </View>

      {/* 失败现场：常驻、可选文字、不用 Modal（透明 Modal 会让整页点不动，TapLedger 踩过） */}
      {failure ? (
        <View style={styles.failureCard}>
          <View style={styles.failureHead}>
            <Text style={styles.failureTitle}>出错环节：{STEP_LABEL[failure.step] ?? failure.step}</Text>
            <Pressable
              onPress={() => {
                clearFailure();
                setFailure(null);
              }}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="关闭错误详情"
            >
              <Text style={styles.failureClose}>关闭</Text>
            </Pressable>
          </View>
          <Text selectable style={styles.failureCode}>
            {failure.code}
          </Text>
          <Text selectable style={styles.failureMessage}>
            {failure.message}
          </Text>
          {failure.context ? (
            <Text selectable style={styles.failureCtx}>
              {Object.entries(failure.context)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join('  ')}
            </Text>
          ) : null}
          <Text style={styles.failureTip}>截这张图发给我就能定位。这段也会留在「管理 → 关于与自检」里。</Text>
        </View>
      ) : null}
    </View>
  );
}

function PageStrip({
  pages,
  rendered,
  index,
  onSelect,
  onAdd,
}: {
  pages: RawCapture[];
  rendered: Record<string, RenderedPage>;
  index: number;
  onSelect: (i: number) => void;
  onAdd: () => void;
}) {
  const listRef = useRef<FlatList<RawCapture>>(null);
  useEffect(() => {
    try {
      listRef.current?.scrollToIndex({ index: Math.max(0, index - 1), animated: true });
    } catch {
      // 列表还没量好尺寸时 scrollToIndex 会抛，不影响选择
    }
  }, [index]);

  return (
    <FlatList
      ref={listRef}
      horizontal
      data={pages}
      keyExtractor={(item) => item.uuid}
      showsHorizontalScrollIndicator={false}
      style={styles.strip}
      renderItem={({ item, index: i }) => {
        const page = rendered[item.uuid];
        const selected = i === index;
        return (
          <Pressable
            style={[styles.stripItem, selected && styles.stripItemSelected]}
            onPress={() => onSelect(i)}
            accessibilityRole="button"
            accessibilityLabel={`第 ${i + 1} 页`}
            accessibilityState={{ selected }}
          >
            {page ? (
              <Image
                source={{ uri: fileUri(page.result.thumbPath || page.result.outPath) }}
                style={styles.stripImage}
                resizeMode="cover"
                accessibilityIgnoresInvertColors
              />
            ) : (
              <View style={styles.stripLoading}>
                <ActivityIndicator color={COLORS.accent} />
              </View>
            )}
            <Text style={styles.stripIndex}>{i + 1}</Text>
          </Pressable>
        );
      }}
      ListFooterComponent={
        <Pressable
          style={styles.stripAdd}
          onPress={onAdd}
          accessibilityRole="button"
          accessibilityLabel="再加一页"
        >
          <Text style={styles.stripAddText}>＋</Text>
        </Pressable>
      }
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  page: { flex: 1 },
  pageHidden: { display: 'none' },
  centerLight: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
    backgroundColor: COLORS.background,
    gap: SPACING.md,
  },
  title: { fontSize: FONT_SIZE.xl, fontWeight: '800', color: COLORS.text },
  body: { fontSize: FONT_SIZE.sm, color: COLORS.textSecondary, textAlign: 'center', lineHeight: 20 },
  primaryButton: {
    backgroundColor: COLORS.accent,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.xl,
    paddingVertical: 12,
  },
  primaryButtonText: { color: COLORS.white, fontSize: FONT_SIZE.md, fontWeight: '700' },
  textButton: { paddingVertical: SPACING.sm },
  textButtonText: { color: COLORS.accentDark, fontSize: FONT_SIZE.sm, fontWeight: '600' },
  disabled: { opacity: 0.45 },
  muted: { opacity: 0.45 },

  cameraTop: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm },
  cameraHint: { color: COLORS.onCameraTextDim, fontSize: FONT_SIZE.xs },
  cameraBottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    gap: SPACING.md,
  },
  cameraNote: { color: COLORS.onCameraText, fontSize: FONT_SIZE.xs },
  cameraControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  roundButton: {
    width: 60,
    height: 60,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.onCameraBorder,
    backgroundColor: COLORS.onCameraSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundButtonText: { color: COLORS.onCameraText, fontSize: FONT_SIZE.xs, fontWeight: '600' },
  roundButtonActive: {
    borderColor: COLORS.accent,
    backgroundColor: 'rgba(121,134,203,0.32)',
  },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: RADIUS.pill,
    borderWidth: 3,
    borderColor: COLORS.white,
    backgroundColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterPressed: { opacity: 0.75 },
  shutterBusy: { opacity: 0.6 },
  shutterInner: { width: 60, height: 60, borderRadius: RADIUS.pill, backgroundColor: COLORS.white },
  queueButton: { paddingVertical: SPACING.xs },
  queueButtonText: { color: COLORS.onCameraTextDim, fontSize: FONT_SIZE.xs },

  reviewNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  navMuted: {
    color: COLORS.textSecondary,
    fontSize: FONT_SIZE.md,
    fontWeight: '600',
    minWidth: 56,
  },
  navTitle: {
    fontSize: FONT_SIZE.md,
    fontWeight: '700',
    color: COLORS.text,
    flexShrink: 1,
    textAlign: 'center',
  },
  doneMini: { minWidth: 56, alignItems: 'flex-end', paddingVertical: 2 },
  doneMiniText: { color: COLORS.accentDark, fontSize: FONT_SIZE.md, fontWeight: '700' },

  previewBox: {
    height: 288,
    marginHorizontal: SPACING.md,
    borderRadius: RADIUS.lg,
    overflow: 'hidden',
    backgroundColor: COLORS.bgAlt,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  previewImage: { width: '100%', height: '100%' },
  busyOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  busyCard: {
    ...CARD,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    gap: SPACING.sm,
    alignItems: 'center',
  },
  busyText: { color: COLORS.textSecondary, fontSize: FONT_SIZE.xs },

  reviewBody: { flex: 1, padding: SPACING.md, gap: SPACING.sm },
  modeHint: { color: COLORS.textTertiary, fontSize: FONT_SIZE.xs, lineHeight: 17 },
  adjustRow: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.xs },
  outlineButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
  },
  outlineActive: { borderColor: COLORS.accent, backgroundColor: `${COLORS.accent}18` },
  outlineButtonText: { color: COLORS.textSecondary, fontSize: FONT_SIZE.sm, fontWeight: '600' },
  note: { color: COLORS.accentDark, fontSize: FONT_SIZE.xs },
  metrics: { color: COLORS.textTertiary, fontSize: FONT_SIZE.xs },

  strip: { flexGrow: 0, marginTop: SPACING.sm },
  stripItem: {
    width: 62,
    height: 82,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    marginRight: SPACING.sm,
    overflow: 'hidden',
  },
  stripItemSelected: { borderColor: COLORS.accent, borderWidth: 2 },
  stripImage: { width: '100%', height: 66 },
  stripLoading: { width: '100%', height: 66, alignItems: 'center', justifyContent: 'center' },
  stripIndex: { fontSize: FONT_SIZE.xs, color: COLORS.textTertiary, textAlign: 'center', paddingTop: 2 },
  stripAdd: {
    width: 62,
    height: 82,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: COLORS.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stripAddText: { fontSize: FONT_SIZE.xl, color: COLORS.textTertiary },

  actions: { flexDirection: 'row', gap: SPACING.md, marginTop: SPACING.sm },
  secondaryButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
  },
  secondaryButtonText: { color: COLORS.text, fontSize: FONT_SIZE.md, fontWeight: '600' },

  failureCard: {
    position: 'absolute',
    left: SPACING.md,
    right: SPACING.md,
    bottom: SPACING.lg,
    padding: SPACING.md,
    borderRadius: RADIUS.lg,
    backgroundColor: COLORS.surface,
    borderWidth: 2,
    borderColor: COLORS.danger,
    gap: 4,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  failureHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  failureTitle: { fontSize: FONT_SIZE.sm, fontWeight: '800', color: COLORS.danger, flexShrink: 1 },
  failureClose: { fontSize: FONT_SIZE.sm, color: COLORS.textSecondary, paddingHorizontal: SPACING.xs },
  failureCode: { fontSize: FONT_SIZE.xs, color: COLORS.textTertiary, fontWeight: '700' },
  failureMessage: { fontSize: FONT_SIZE.xs, color: COLORS.text, lineHeight: 17 },
  failureCtx: { fontSize: FONT_SIZE.xs, color: COLORS.textSecondary, lineHeight: 16 },
  failureTip: { fontSize: FONT_SIZE.xs, color: COLORS.textTertiary, marginTop: 2 },
});
