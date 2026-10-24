import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { Camera, useCameraPermission, usePhotoOutput, type CameraRef } from 'react-native-vision-camera';
import {
  COLORS,
  CARD,
  FONT_SIZE,
  MAX_FONT_MULTIPLIER,
  RADIUS,
  SPACING,
  TOUCH,
  findMode,
  genUuid,
} from '../constants';
import {
  analyzeImage,
  isEngineReady,
  normalizeRotation,
  scannerErrorCode,
  scannerErrorMessage,
} from '../native/ScannerNative';
import {
  analyzeRaw,
  importSource,
  renderCapture,
  savePagesAsDocument,
  type RawCapture,
  type RenderedPage,
} from '../utils/scanPipeline';
import { effectiveAutoCrop, resolveRenderOptions } from '../utils/renderOptions';
import { clearFailure, recordFailure, type FailureRecord } from '../utils/diagnostics';
import { cropLabel, defaultTitle, pickInitialMode, sharpnessLabel } from '../utils/modeSelection';
import { displayPathFor, fileUri } from '../utils/scanFiles';
import { useAppSettings } from '../hooks/useAppSettings';
import { useBackHandler } from '../hooks/useBackHandler';
import CornerAdjust from '../components/CornerAdjust';
import FilterChips from '../components/FilterChips';
import Modal from '../components/Modal';
import { showToast } from '../components/Toast';
import type { QuadPoint, ScanMode } from '../types';

type Stage = 'camera' | 'review' | 'crop';

/**
 * 队列里的一页。
 *
 * status 是这一页在「拍 → 搬运 → 识别 → 出图」这条流水线上的位置。
 * v0.1 没有这个概念：快门按下去就一直占着 busy，整条链路跑完才回到取景器，
 * 于是拍 5 页要等 5 次「转圈 + 被跳走 + 再点继续拍」—— 走查 audit-41 / audit-1 说的都是它。
 */
interface SessionPage {
  id: string;
  sourcePath: string;
  /** 搬进文档目录之后的位置。分析失败时靠它重试，不用再搬一次（重复搬会造出第二份 raw） */
  imported?: { pageUuid: string; rawPath: string };
  status: 'queued' | 'working' | 'ready' | 'error';
  capture?: RawCapture;
  render?: RenderedPage;
  mode: ScanMode;
  quad: QuadPoint[] | null;
  /** 旋正角度（成品顺时针转角）。四角仍按原图坐标系，转的是裁好的那一页 */
  rotation: number;
  /** 重跑计数：只有 token 仍是最新的那次结果才允许写回，连点档位不会被旧结果盖掉 */
  token: number;
  error?: { step: string; message: string };
}

/** 出错环节的用户语言（内部 step 码不变，只是别让用户看英文键名） */
const STEP_LABEL: Record<string, string> = {
  capture: '拍照',
  'capture-fallback': '拍照（备用路径）',
  relocate: '保存图片',
  analyze: '识别纸边',
  process: '智能高清处理',
  save: '保存到文档',
};

/**

/**
 * 扫描页（首页）。
 *
 * 结构上的三条 Tap 红线（没变）：
 *   - 启动即相机，零跳转；
 *   - review / crop 是**并列页**，靠 display 互斥切换，不用 Modal 盖相机
 *     （相机是原生视图层，Modal 盖上去触摸和安全区行为都会变，这是 TapLedger 用一轮重写换来的结论）；
 *   - 反馈一律走全局非模态 Toast。
 *
 * v0.2 改掉的两条：
 *   - **快门不再等设备**：拍完立刻留在取景器，页在后台排队出图，右下角小图随时能进去看；
 *   - **审核页两态**：默认只给「成品 + 页条 + 继续拍/保存」，调整项（四角 / 这组切边 / 重跑 /
 *     检测详情）收进一个展开区，不再一屏堆 9 组内容（audit-31/17/12）。
 */
export default function ScanScreen({ active = true }: { active?: boolean }) {
  const insets = useSafeAreaInsets();
  const settings = useAppSettings();
  const cameraRef = useRef<CameraRef>(null);
  const { hasPermission, requestPermission } = useCameraPermission();
  const photoOutput = usePhotoOutput({ quality: 0.95, qualityPrioritization: 'quality' });

  // 第一次拍摄前就决定目录名；保存时数据库记录复用同一个 uuid
  const docUuid = useRef<string>(genUuid());
  const [pages, setPages] = useState<SessionPage[]>([]);
  const [index, setIndex] = useState(0);
  const [stage, setStage] = useState<Stage>('camera');
  /** 本组会话的自动切边（null = 跟随全局设置）。会话级不写库 —— 与全局的语义分开（audit-15） */
  const [sessionAutoCrop, setSessionAutoCrop] = useState<boolean | null>(null);
  const [shooting, setShooting] = useState(false);
  const [torch, setTorch] = useState(false);
  const [engineMissing, setEngineMissing] = useState(false);
  const [showAdjust, setShowAdjust] = useState(false);
  const [showTech, setShowTech] = useState(false);
  const [saving, setSaving] = useState(false);
  const [askName, setAskName] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [askDiscard, setAskDiscard] = useState(false);
  // 失败现场常驻（Toast 两秒就没了，而失败点全在相机/原生层）。
  // v0.2 起默认只说「怎么办」，英文 code/message 折叠在「查看技术详情」里（audit-13）。
  const [failure, setFailure] = useState<FailureRecord | null>(null);

  // 队列工人要读最新的设置与队列，但回调本身不能因此重建 —— 用 ref 镜像
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const autoCropRef = useRef<boolean | null>(sessionAutoCrop);
  autoCropRef.current = sessionAutoCrop;
  const pagesRef = useRef<SessionPage[]>(pages);
  pagesRef.current = pages;
  const runningRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const info = await isEngineReady();
      if (!cancelled && !info.ready) setEngineMissing(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 二级页吃掉返回：crop → review → camera
  useBackHandler(stage !== 'camera', () => setStage(stage === 'crop' ? 'review' : 'camera'));

  const safeIndex = Math.min(index, Math.max(0, pages.length - 1));
  const current = pages.length > 0 ? pages[safeIndex] : undefined;
  const currentMode: ScanMode = current?.mode ?? settings.defaultMode;
  const currentQuad = current?.quad ?? current?.capture?.analyze.quad ?? null;
  const pendingCount = pages.filter((p) => p.status === 'queued' || p.status === 'working').length;
  const readyCount = pages.filter((p) => p.status === 'ready').length;
  const failedCount = pages.filter((p) => p.status === 'error').length;

  const patch = useCallback((id: string, next: Partial<SessionPage>) => {
    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, ...next } : p)));
  }, []);

  /**
   * 队列工人：一次只跑一页。
   *
   * 原生侧本来就是一条单线程 Executor（ScannerModule.executor），JS 这边并发也不会更快，
   * 只会让「哪一页先出图」变得不可预期 —— 顺序跑，页条上的转圈才是诚实的。
   */
  const pump = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      for (;;) {
        const next = pagesRef.current.find((p) => p.status === 'queued');
        if (!next) break;
        const token = next.token;
        patch(next.id, { status: 'working' });
        try {
          let capture = next.capture;
          if (!capture) {
            const imported = next.imported ?? (await importSource(next.sourcePath, docUuid.current));
            if (!next.imported) patch(next.id, { imported });
            capture = await analyzeRaw(imported.pageUuid, imported.rawPath);
          }
          const mode = next.capture
            ? next.mode
            : pickInitialMode(
                capture.suggestion.rule,
                capture.suggestion.mode,
                settingsRef.current.defaultMode,
              );
          const options = resolveRenderOptions(settingsRef.current, {
            autoCrop: effectiveAutoCrop(autoCropRef.current, settingsRef.current.autoCrop),
          });
          const render = await renderCapture(
            capture,
            docUuid.current,
            mode,
            next.quad ?? capture.analyze.quad,
            options,
            next.rotation,
          );
          if (pagesRef.current.find((p) => p.id === next.id)?.token !== token) continue; // 已被重跑，旧结果作废
          patch(next.id, {
            status: 'ready',
            capture,
            render,
            mode,
            quad: render.quad,
            rotation: render.rotation,
            error: undefined,
          });
        } catch (error) {
          const step = next.capture ? 'process' : 'relocate';
          patch(next.id, {
            status: 'error',
            error: { step, message: scannerErrorMessage(scannerErrorCode(error), (error as Error)?.message) },
          });
          setFailure(recordFailure(step, error, { page: next.id.slice(0, 8) }));
        }
      }
    } finally {
      runningRef.current = false;
    }
  }, [patch]);

  // 队列里还有活但工人没在跑（例如失败后重试、刚入队）→ 补一脚
  useEffect(() => {
    if (pendingCount > 0 && !runningRef.current) void pump();
  }, [pages, pendingCount, pump]);

  const requeue = useCallback(
    (id: string, next: Partial<SessionPage>) => {
      const before = pagesRef.current.find((p) => p.id === id)?.token ?? 0;
      patch(id, { ...next, status: 'queued', token: before + 1 });
    },
    [patch],
  );

  const changeMode = useCallback(
    (mode: ScanMode) => {
      if (!current) return;
      requeue(current.id, { mode });
    },
    [current, requeue],
  );

  const applyModeToAll = useCallback(() => {
    if (!current) return;
    setPages((prev) => prev.map((p) => ({ ...p, mode: current.mode, status: 'queued', token: p.token + 1 })));
    showToast(`整份换成${findMode(current.mode).label}`, 'info');
  }, [current]);

  const confirmQuad = useCallback(
    (quad: QuadPoint[]) => {
      if (!current) return;
      setStage('review');
      requeue(current.id, { quad, mode: current.mode });
    },
    [current, requeue],
  );

  const retryPage = useCallback((page: SessionPage) => requeue(page.id, { error: undefined }), [requeue]);

  /**
   * 旋正：把「裁好的这一页」转 90°（不是转原图 —— 四角仍按原图坐标系存着，重跑不会串位）。
   *
   * 只做手动：哪一边是页顶在纯几何上没有答案（文字朝上要靠 OCR 才知道），
   * 而「转错了能一键转回来」是扫描全能王给用户留的同一出口。
   */
  const rotateBy = useCallback(
    (delta: number) => {
      if (!current) return;
      requeue(current.id, { rotation: normalizeRotation(current.rotation + delta) });
    },
    [current, requeue],
  );

  /**
   * 重新找纸边：换到更高的分析分辨率（1600）再跑一次检测。
   *
   * 自动检测是在当前这张图上「猜」，失败时只剩手动拖角一条路；换个分辨率重跑常常就成功了。
   * 这是扫描类 App 的标准兜底，也是我拿不到你手机时唯一的自助诊断入口。
   */
  const redetect = useCallback(async () => {
    if (!current?.capture) return;
    try {
      const again = await analyzeImage(current.capture.rawPath, 1600);
      patch(current.id, {
        capture: { ...current.capture, analyze: again },
        quad: again.quad,
        status: 'queued',
        token: current.token + 1,
      });
      showToast(
        again.detected
          ? `找到纸边了（${again.source} · 占画面 ${Math.round(again.areaRatio * 100)}%）`
          : '还是没找到纸边，手动拖四个角最快',
        again.detected ? 'success' : 'info',
      );
    } catch (error) {
      showToast(scannerErrorMessage(scannerErrorCode(error), (error as Error)?.message), 'error');
    }
  }, [current, patch]);

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

  const enqueuePath = useCallback((sourcePath: string) => {
    setPages((prev) => {
      const next = [
        ...prev,
        {
          id: genUuid(),
          sourcePath,
          status: 'queued' as const,
          mode: settingsRef.current.defaultMode,
          quad: null,
          rotation: 0,
          token: 0,
        },
      ];
      setIndex(next.length - 1);
      return next;
    });
  }, []);

  /**
   * 快门：先走「直接写文件」，失败再退到「内存 Photo → 存临时文件」。
   * 两条路都是 VisionCamera v5 的公开 API；留第二条不是为了绕，而是为了让报错自己说话：
   *   - 两条都挂 → 卡片里同时给出两个 message，根因基本就在其中一条
   *   - 只有第一条挂 → 是 capturePhotoToFile 这条路径的问题（Android 侧写文件）
   */
  const shutter = useCallback(async () => {
    if (shooting) return;
    setShooting(true);
    setFailure(null);
    const captureSettings = {
      enableShutterSound: false,
      flashMode: torch ? ('on' as const) : ('off' as const),
    };
    let filePath: string | null = null;
    let firstError: unknown = null;
    try {
      try {
        const photo = await photoOutput.capturePhotoToFile(captureSettings, {});
        filePath = photo.filePath;
      } catch (error) {
        firstError = error;
        try {
          const photo = await photoOutput.capturePhoto(captureSettings, {});
          filePath = await photo.saveToTemporaryFileAsync();
          // v5 的内存 Photo 持有原生缓冲池，用完必须显式释放，不能等 JS 运行时回收
          photo.dispose();
        } catch (fallbackError) {
          setFailure(
            recordFailure('capture-fallback', fallbackError, {
              primary: firstError
                ? `${(firstError as Error)?.name ?? ''}: ${(firstError as Error)?.message ?? ''}`.slice(
                    0,
                    120,
                  )
                : 'none',
            }),
          );
          showToast('拍照失败，屏幕上有完整原因', 'error', 5000);
        }
      }
      if (filePath) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        // 关键改动：立刻留在取景器，这一页交给队列去处理（audit-41）
        enqueuePath(filePath);
      }
    } finally {
      // 走查 audit-1：这条路径以前没有 finally，一次拍照失败就把 busy 永久留在 true，
      // 快门 / 相册 / 继续拍全被锁死，只能杀 App。
      setShooting(false);
    }
  }, [enqueuePath, photoOutput, shooting, torch]);

  const pickFromAlbum = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      showToast('没有相册权限，去系统设置里打开', 'error', 4000);
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      quality: 1,
      selectionLimit: 9,
    });
    if (result.canceled || result.assets.length === 0) return;
    // 相册图和相机图走同一条队列：一次投 9 张是排队，不是一个一个卡住界面
    result.assets.forEach((asset) => enqueuePath(asset.uri));
  }, [enqueuePath]);

  const discardAll = useCallback(() => {
    setPages([]);
    setIndex(0);
    setSessionAutoCrop(null);
    setShowAdjust(false);
    setAskDiscard(false);
    docUuid.current = genUuid();
    setStage('camera');
  }, []);

  /** 误触「放弃」就整组清零是第二条丢数据的路（audit-4）：多于 1 页时先问一句 */
  const requestDiscard = useCallback(() => {
    if (pages.length === 0) return;
    if (pages.length === 1) {
      discardAll();
      return;
    }
    setAskDiscard(true);
  }, [discardAll, pages.length]);

  const openSaveDialog = useCallback(() => {
    if (pagesRef.current.length === 0) return;
    if (pagesRef.current.some((p) => p.status === 'queued' || p.status === 'working')) {
      showToast('还有页面在处理，稍等一下', 'info');
      return;
    }
    setDraftTitle(defaultTitle());
    setAskName(true);
  }, []);

  const finish = useCallback(
    async (title: string) => {
      const renders = pages.map((p) => p.render).filter((r): r is RenderedPage => Boolean(r));
      if (renders.length === 0 || renders.length !== pages.length) {
        showToast('还有页面没处理完，稍等一下', 'info');
        return;
      }
      const name = title.trim().slice(0, 40) || defaultTitle();
      setSaving(true);
      try {
        const saved = await savePagesAsDocument(docUuid.current, name, renders);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        showToast(`已保存「${saved.title}」${saved.pageCount} 页`, 'success');
        setAskName(false);
        discardAll();
      } catch (error) {
        setFailure(recordFailure('save', error, { pages: renders.length }));
        showToast(scannerErrorMessage(scannerErrorCode(error), (error as Error)?.message), 'error', 4500);
      } finally {
        setSaving(false);
      }
    },
    [discardAll, pages],
  );

  /** 取景层那句话：连拍时用户唯一需要的状态 */
  const queueNote = useMemo(() => {
    if (pendingCount > 0) return `正在处理 ${readyCount + failedCount + 1}/${pages.length} 页…`;
    if (failedCount > 0) return `${failedCount} 页没处理成功，点右下角小图进去重试`;
    if (pages.length > 0) return `已拍 ${pages.length} 页，可以继续拍，或点小图看结果`;
    return null;
  }, [failedCount, pages.length, pendingCount, readyCount]);

  const lastReady = [...pages].reverse().find((p) => p.render)?.render;
  const currentLabel = current
    ? current.status === 'error'
      ? (current.error?.message ?? '这一页没处理成功')
      : current.capture
        ? cropLabel(
            current.capture.analyze.detected,
            current.capture.analyze.confidence,
            current.capture.analyze.source,
          )
        : null
    : null;
  // 唯一能向用户证明「智能」带来多少的数字，v0.1 算完从没显示过（audit-12）
  const gain = current?.render ? sharpnessLabel(current.render.result.sharpnessGain) : null;
  const autoCropOn = effectiveAutoCrop(sessionAutoCrop, settings.autoCrop);

  if (engineMissing) {
    return (
      <View style={styles.centerLight}>
        <Text style={styles.title}>图像引擎不可用</Text>
        <Text style={styles.body}>
          这个包的 OpenCV 原生库没有加载成功，扫描和增强都会失败。请重装最新版 APK；仍然这样的话，把 「管理 ·
          关于与自检」里的版本号发到 Issue。
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
        <Pressable
          style={styles.primaryWide}
          onPress={async () => {
            const granted = await requestPermission();
            if (!granted) showToast('系统没给权限，用下面那个按钮去设置里打开', 'error', 4000);
          }}
          accessibilityRole="button"
        >
          <Text style={styles.primaryButtonText}>打开相机</Text>
        </Pressable>
        {/* Android 上勾了「不再询问」之后 requestPermission 只会静默返回 false —— 不给出口就是死路（audit-5） */}
        <Pressable
          style={styles.secondaryWide}
          onPress={() =>
            void Linking.openSettings().catch(() => showToast('打不开系统设置，手动到「应用」里找', 'error'))
          }
          accessibilityRole="button"
        >
          <Text style={styles.secondaryWideText}>去系统设置打开相机权限</Text>
        </Pressable>
        <Pressable style={styles.textButton} onPress={() => void pickFromAlbum()} accessibilityRole="button">
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
          {queueNote ? <Text style={styles.cameraNote}>{queueNote}</Text> : null}
          <View style={styles.cameraControls}>
            <Pressable
              style={[styles.roundButton, torch && styles.roundButtonActive]}
              onPress={toggleTorch}
              accessibilityRole="button"
              accessibilityLabel={torch ? '关闭补光' : '打开补光'}
              accessibilityState={{ selected: torch }}
            >
              <Text style={styles.roundButtonText} maxFontSizeMultiplier={MAX_FONT_MULTIPLIER}>
                {torch ? '关灯' : '补光'}
              </Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.shutter,
                pressed && styles.shutterPressed,
                shooting && styles.shutterBusy,
              ]}
              onPress={() => void shutter()}
              disabled={shooting}
              accessibilityRole="button"
              accessibilityLabel="拍照扫描"
            >
              {shooting ? <ActivityIndicator color={COLORS.white} /> : <View style={styles.shutterInner} />}
            </Pressable>
            <Pressable
              style={styles.roundButton}
              onPress={() => void pickFromAlbum()}
              accessibilityRole="button"
              accessibilityLabel="从相册导入"
            >
              <Text style={styles.roundButtonText} maxFontSizeMultiplier={MAX_FONT_MULTIPLIER}>
                相册
              </Text>
            </Pressable>
          </View>
          {/* audit-33：原来这行小字几乎看不见。改成已拍页缩略图 —— 连拍的节拍锚点 */}
          {pages.length > 0 ? (
            <Pressable
              style={[styles.thumbAnchor, { bottom: insets.bottom + 112 }]}
              onPress={() => setStage('review')}
              accessibilityRole="button"
              accessibilityLabel={`查看已拍的 ${pages.length} 页`}
            >
              {lastReady ? (
                <Image
                  source={{
                    uri: fileUri(displayPathFor(lastReady.result.outPath, lastReady.result.previewPath)),
                  }}
                  style={styles.thumbAnchorImage}
                  resizeMode="cover"
                  accessibilityIgnoresInvertColors
                />
              ) : (
                <View style={styles.thumbAnchorBusy}>
                  <ActivityIndicator color={COLORS.white} />
                </View>
              )}
              <View style={styles.thumbAnchorBadge}>
                <Text style={styles.thumbAnchorBadgeText}>{pages.length}</Text>
              </View>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* review：默认只有「结果 + 页条 + 两个按钮」，调整项在「调整」里 */}
      <View style={[styles.page, stage !== 'review' && styles.pageHidden]}>
        <View style={{ height: insets.top + SPACING.xs }} />
        <View style={styles.reviewNav}>
          <Pressable
            style={styles.navBtn}
            onPress={requestDiscard}
            hitSlop={TOUCH.slop}
            accessibilityRole="button"
          >
            <Text style={styles.navMuted}>放弃</Text>
          </Pressable>
          <Text style={styles.navTitle} numberOfLines={1}>
            {pages.length > 0 ? `${safeIndex + 1} / ${pages.length} 页` : '没有页面'}
          </Text>
          <Pressable
            style={styles.navBtn}
            onPress={() => setShowAdjust((v) => !v)}
            hitSlop={TOUCH.slop}
            accessibilityRole="button"
            accessibilityState={{ expanded: showAdjust }}
          >
            <Text style={[styles.navMuted, showAdjust && styles.navActive]}>
              {showAdjust ? '收起' : '调整'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.previewBox}>
          {current?.render ? (
            <Image
              source={{
                uri: fileUri(
                  displayPathFor(current.render.result.outPath, current.render.result.previewPath),
                ),
              }}
              style={styles.previewImage}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
            />
          ) : current?.capture ? (
            <Image
              source={{ uri: fileUri(current.capture.rawPath) }}
              style={styles.previewImage}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
            />
          ) : null}
          {current && current.status !== 'ready' ? (
            <View style={styles.busyOverlay} pointerEvents="none">
              <View style={styles.busyCard}>
                <ActivityIndicator color={COLORS.accent} />
                <Text style={styles.busyText}>
                  {current.status === 'error' ? '这一页没处理成功' : '智能高清处理中…'}
                </Text>
                {current.status === 'error' ? (
                  <Pressable
                    style={styles.retryBtn}
                    onPress={() => retryPage(current)}
                    accessibilityRole="button"
                    accessibilityLabel="重试这一页"
                  >
                    <Text style={styles.retryBtnText}>重试这一页</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : null}
        </View>

        <ScrollView
          style={styles.reviewBody}
          contentContainerStyle={styles.reviewBodyContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.reviewInner}>
            {currentLabel ? <Text style={styles.note}>{currentLabel}</Text> : null}
            {gain ? <Text style={styles.gain}>{gain}</Text> : null}
            {current?.capture && current.capture.suggestion.rule !== 'default' ? (
              <Text style={styles.modeHint}>按画面建议：{current.capture.suggestion.reason}</Text>
            ) : null}

            {showAdjust ? (
              <View style={styles.adjustPanel}>
                <Text style={styles.adjustLabel}>档位（随时能换，原图一直在）</Text>
                <FilterChips
                  value={currentMode}
                  onChange={changeMode}
                  disabled={!current || current.status === 'working'}
                  suggested={current?.capture?.suggestion.mode ?? null}
                />
                <Text style={styles.modeHint}>{findMode(currentMode).hint}</Text>
                <Pressable style={styles.textButton} onPress={applyModeToAll} disabled={!current}>
                  <Text style={styles.textButtonText}>整份都用这一档（{pages.length} 页）</Text>
                </Pressable>

                <Pressable
                  style={[styles.outlineButton, { marginTop: SPACING.xs }]}
                  disabled={!current || current.status === 'working'}
                  onPress={() => void redetect()}
                  accessibilityRole="button"
                  accessibilityHint="用更高分辨率再检测一次纸张边界"
                >
                  <Text style={styles.outlineButtonText}>重新找纸边（更仔细）</Text>
                </Pressable>

                {/* 旋正：纸拍横了 / 倒了，转一下就行，不必重拍（对标扫描全能王的 ↺ ↻） */}
                <View style={styles.adjustRow}>
                  <Pressable
                    style={[styles.outlineButton, styles.outlineGrow]}
                    disabled={!current || current.status === 'working'}
                    onPress={() => rotateBy(-90)}
                    accessibilityRole="button"
                    accessibilityLabel="向左旋转 90 度"
                    accessibilityHint="把这一页逆时针转过来"
                  >
                    <Text style={styles.outlineButtonText}>↺ 左转</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.outlineButton, styles.outlineGrow]}
                    disabled={!current || current.status === 'working'}
                    onPress={() => rotateBy(90)}
                    accessibilityRole="button"
                    accessibilityLabel="向右旋转 90 度"
                    accessibilityHint="把这一页顺时针转过去"
                  >
                    <Text style={styles.outlineButtonText}>右转 ↻</Text>
                  </Pressable>
                </View>

                <View style={styles.adjustRow}>
                  <Pressable
                    style={[styles.outlineButton, styles.outlineGrow]}
                    disabled={!current}
                    onPress={() => setStage('crop')}
                    accessibilityRole="button"
                  >
                    <Text style={styles.outlineButtonText}>调整四角</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.outlineButton, styles.outlineGrow, autoCropOn && styles.outlineActive]}
                    onPress={() => {
                      const next = !autoCropOn;
                      setSessionAutoCrop(next);
                      // 立刻作用到当前页（audit-6：原来点了没反应，控件看起来是坏的）
                      if (current) requeue(current.id, {});
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: autoCropOn }}
                  >
                    <Text style={styles.outlineButtonText}>这组自动切边 {autoCropOn ? '开' : '关'}</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.outlineButton, styles.outlineDanger]}
                    disabled={!current}
                    onPress={() => current && retryPage(current)}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.outlineButtonText, { color: COLORS.danger }]}>重跑这一页</Text>
                  </Pressable>
                </View>

                <Pressable
                  style={styles.textButton}
                  onPress={() => setShowTech((v) => !v)}
                  accessibilityRole="button"
                >
                  <Text style={styles.textButtonText}>{showTech ? '收起检测详情' : '查看检测详情'}</Text>
                </Pressable>
                {showTech && current?.capture ? (
                  <Text selectable style={styles.tech}>
                    {`来源 ${current.capture.analyze.source} · 框占画面 ${Math.round(
                      current.capture.analyze.areaRatio * 100,
                    )}% 置信度 ${current.capture.analyze.confidence.toFixed(2)} · 检测 ${Math.round(
                      current.capture.analyze.detectMs,
                    )}ms 亮度 ${Math.round(current.capture.analyze.metrics.brightness)} · 阴影 ${Math.round(
                      current.capture.analyze.metrics.shadowScore * 100,
                    )}% · 模糊 ${Math.round(current.capture.analyze.metrics.blurScore)}${
                      current.render
                        ? ` 出图 ${current.render.result.width}×${current.render.result.height}`
                        : ''
                    }`}
                  </Text>
                ) : null}
              </View>
            ) : null}

            <PageStrip pages={pages} index={safeIndex} onSelect={setIndex} onAdd={() => setStage('camera')} />
          </View>
        </ScrollView>

        {/* 主操作钉在底部：展开「调整」或系统字体放大时也不会被顶出屏幕外（audit-39） */}
        <View style={styles.actionsDock}>
          <View style={styles.actions}>
            <Pressable style={styles.secondaryButton} onPress={() => setStage('camera')}>
              <Text style={styles.secondaryButtonText}>继续拍</Text>
            </Pressable>
            <Pressable
              style={[styles.primaryButton, (saving || readyCount === 0) && styles.disabled]}
              disabled={saving || readyCount === 0}
              onPress={openSaveDialog}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>{saving ? '保存中…' : `保存这 ${pages.length} 页`}</Text>
            </Pressable>
          </View>
        </View>
      </View>

      {/* crop：并列页（不卸载 review，回去时状态还在） */}
      <View style={[styles.page, stage !== 'crop' && styles.pageHidden]}>
        {current && currentQuad && current.capture ? (
          <CornerAdjust
            path={current.capture.rawPath}
            imageWidth={current.capture.width}
            imageHeight={current.capture.height}
            initialQuad={currentQuad}
            onConfirm={confirmQuad}
            onCancel={() => setStage('review')}
            onReset={() => patch(current.id, { quad: current.capture?.analyze.quad ?? null })}
          />
        ) : null}
      </View>

      {/* 失败现场：默认只说「怎么办」，技术串折叠 */}
      {failure ? (
        <View style={styles.failureCard}>
          <View style={styles.failureHead}>
            <Text
              style={styles.failureTitle}
            >{`${STEP_LABEL[failure.step] ?? failure.step}这一步没成功`}</Text>
            <Pressable
              style={styles.failureCloseBtn}
              hitSlop={TOUCH.slop}
              onPress={() => {
                clearFailure();
                setFailure(null);
              }}
              accessibilityRole="button"
              accessibilityLabel="关闭错误详情"
            >
              <Text style={styles.failureClose}>关闭</Text>
            </Pressable>
          </View>
          <Text style={styles.failureHint}>
            可以再按一次快门，或者从相册选一张。反复失败就把下面的技术详情发给我。
          </Text>
          <Pressable
            style={styles.textButton}
            onPress={() => setShowTech((v) => !v)}
            accessibilityRole="button"
          >
            <Text style={styles.textButtonText}>{showTech ? '收起技术详情' : '查看技术详情'}</Text>
          </Pressable>
          {showTech ? (
            <Text selectable style={styles.tech}>
              {`${failure.code} ${failure.message}${
                failure.context
                  ? `\n${Object.entries(failure.context)
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join('  ')}`
                  : ''
              }`}
            </Text>
          ) : null}
        </View>
      ) : null}

      <Modal
        visible={askName}
        title="这份文档叫什么"
        onClose={() => setAskName(false)}
        saveLabel="保存"
        onSave={() => void finish(draftTitle)}
        saveDisabled={saving}
      >
        <TextInput
          style={styles.input}
          value={draftTitle}
          onChangeText={setDraftTitle}
          placeholder={defaultTitle()}
          maxLength={40}
          accessibilityLabel="文档名"
        />
        <Text style={styles.hintBelow}>名字之后在文档详情页随时能改。</Text>
      </Modal>

      <Modal visible={askDiscard} title="丢掉这一组？" onClose={() => setAskDiscard(false)}>
        <Text style={styles.confirmText}>
          {`这里 ${pages.length} 页都还没保存，丢掉就没了（其中 ${readyCount} 页已经处理完也一样删掉）。`}
        </Text>
        <Pressable style={[styles.primaryWide, { alignSelf: 'stretch' }]} onPress={discardAll}>
          <Text style={styles.primaryButtonText}>确认丢掉</Text>
        </Pressable>
      </Modal>
    </View>
  );
}

function PageStrip({
  pages,
  index,
  onSelect,
  onAdd,
}: {
  pages: SessionPage[];
  index: number;
  onSelect: (i: number) => void;
  onAdd: () => void;
}) {
  const listRef = useRef<FlatList<SessionPage>>(null);
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
      keyExtractor={(item) => item.id}
      showsHorizontalScrollIndicator={false}
      style={styles.strip}
      renderItem={({ item, index: i }) => {
        const selected = i === index;
        return (
          <Pressable
            style={[
              styles.stripItem,
              selected && styles.stripItemSelected,
              item.status === 'error' && styles.stripItemError,
            ]}
            onPress={() => onSelect(i)}
            accessibilityRole="button"
            accessibilityLabel={`第 ${i + 1} 页${
              item.status === 'ready' ? '' : item.status === 'error' ? '，处理失败' : '，处理中'
            }`}
            accessibilityState={{ selected }}
          >
            {item.render ? (
              <Image
                source={{
                  uri: fileUri(
                    item.render.result.thumbPath && item.render.result.thumbPath.length > 0
                      ? item.render.result.thumbPath
                      : item.render.result.outPath,
                  ),
                }}
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
  reviewBodyContent: { gap: SPACING.sm, paddingBottom: SPACING.sm },
  reviewInner: { gap: SPACING.sm, flexGrow: 1, justifyContent: 'flex-end' },
  actionsDock: { paddingHorizontal: SPACING.md, paddingBottom: SPACING.md },
  centerLight: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
    backgroundColor: COLORS.background,
    gap: SPACING.md,
  },
  title: { fontSize: FONT_SIZE.xl, fontWeight: '800', color: COLORS.text, textAlign: 'center' },
  body: { fontSize: FONT_SIZE.sm, color: COLORS.textSecondary, textAlign: 'center', lineHeight: 20 },
  primaryButton: {
    flex: 1,
    backgroundColor: COLORS.accentDark,
    borderRadius: RADIUS.md,
    minHeight: TOUCH.min,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryWide: {
    backgroundColor: COLORS.accentDark,
    borderRadius: RADIUS.md,
    minHeight: TOUCH.min,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { color: COLORS.white, fontSize: FONT_SIZE.md, fontWeight: '700', textAlign: 'center' },
  secondaryButton: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    borderRadius: RADIUS.md,
    minHeight: TOUCH.min,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { color: COLORS.text, fontSize: FONT_SIZE.md, fontWeight: '600' },
  secondaryWide: {
    minHeight: TOUCH.min,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
  },
  secondaryWideText: { fontSize: FONT_SIZE.sm, color: COLORS.accentDark, fontWeight: '600' },
  textButton: { minHeight: TOUCH.min, justifyContent: 'center', paddingVertical: SPACING.sm },
  textButtonText: {
    color: COLORS.accentDark,
    fontSize: FONT_SIZE.sm,
    fontWeight: '600',
    textAlign: 'center',
  },
  disabled: { opacity: 0.45 },

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
  cameraNote: { color: COLORS.onCameraText, fontSize: FONT_SIZE.sm, textAlign: 'center' },
  cameraControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  roundButton: {
    width: 64,
    height: 64,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.onCameraBorder,
    backgroundColor: COLORS.onCameraSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundButtonActive: { backgroundColor: COLORS.accentDark, borderColor: COLORS.accentDark },
  roundButtonText: { color: COLORS.onCameraText, fontSize: FONT_SIZE.sm, fontWeight: '600' },
  shutter: {
    width: 78,
    height: 78,
    borderRadius: RADIUS.pill,
    borderWidth: 3,
    borderColor: COLORS.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterPressed: { opacity: 0.75 },
  shutterBusy: { opacity: 0.6 },
  shutterInner: { width: 62, height: 62, borderRadius: RADIUS.pill, backgroundColor: COLORS.white },
  thumbAnchor: {
    position: 'absolute',
    right: SPACING.lg,
    width: 52,
    height: 68,
    borderRadius: RADIUS.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.onCameraBorder,
    backgroundColor: COLORS.onCameraSurface,
  },
  thumbAnchorImage: { width: '100%', height: '100%' },
  thumbAnchorBusy: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  thumbAnchorBadge: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    minWidth: 20,
    height: 20,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.accentDark,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  thumbAnchorBadgeText: { color: COLORS.white, fontSize: FONT_SIZE.xs, fontWeight: '700' },

  reviewNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    minHeight: TOUCH.min,
    gap: SPACING.sm,
  },
  navBtn: { minWidth: TOUCH.min, minHeight: TOUCH.min, alignItems: 'center', justifyContent: 'center' },
  navMuted: { color: COLORS.textSecondary, fontSize: FONT_SIZE.md, fontWeight: '600' },
  navActive: { color: COLORS.accentDark },
  navTitle: {
    fontSize: FONT_SIZE.md,
    fontWeight: '700',
    color: COLORS.text,
    flexShrink: 1,
    textAlign: 'center',
  },
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
    alignItems: 'center',
    gap: SPACING.sm,
  },
  busyText: { fontSize: FONT_SIZE.xs, color: COLORS.textSecondary, textAlign: 'center' },
  retryBtn: {
    minHeight: TOUCH.min,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.accentDark,
    alignItems: 'center',
  },
  retryBtnText: { color: COLORS.white, fontSize: FONT_SIZE.sm, fontWeight: '700' },
  reviewBody: { flex: 1, paddingHorizontal: SPACING.md, paddingTop: SPACING.sm },
  note: { color: COLORS.accentDark, fontSize: FONT_SIZE.sm, textAlign: 'center' },
  gain: { color: COLORS.success, fontSize: FONT_SIZE.sm, fontWeight: '700', textAlign: 'center' },
  modeHint: { color: COLORS.textTertiary, fontSize: FONT_SIZE.xs, textAlign: 'center' },
  tech: {
    color: COLORS.textSecondary,
    fontSize: FONT_SIZE.xs,
    lineHeight: 17,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.sm,
    padding: SPACING.sm,
  },
  adjustPanel: { gap: SPACING.xs },
  adjustLabel: { fontSize: FONT_SIZE.xs, color: COLORS.textTertiary, fontWeight: '600' },
  adjustRow: { flexDirection: 'row', gap: SPACING.sm },
  outlineButton: {
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.sm,
    minHeight: TOUCH.min,
    paddingHorizontal: SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlineGrow: { flex: 1 },
  outlineActive: { borderColor: COLORS.accent, backgroundColor: COLORS.accentSoft },
  outlineDanger: { borderColor: COLORS.danger },
  outlineButtonText: { fontSize: FONT_SIZE.sm, color: COLORS.text, fontWeight: '600', textAlign: 'center' },
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
  stripItemError: { borderColor: COLORS.danger },
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
    marginRight: SPACING.sm,
  },
  stripAddText: { fontSize: FONT_SIZE.lg, color: COLORS.textTertiary },
  actions: { flexDirection: 'row', gap: SPACING.md, paddingTop: SPACING.sm },

  failureCard: {
    position: 'absolute',
    left: SPACING.md,
    right: SPACING.md,
    bottom: SPACING.lg,
    ...CARD,
    padding: SPACING.md,
    gap: SPACING.xs,
    backgroundColor: COLORS.warningBg,
    borderColor: COLORS.warningText,
    zIndex: 60,
  },
  failureHead: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm },
  failureTitle: { flex: 1, color: COLORS.warningText, fontSize: FONT_SIZE.sm, fontWeight: '700' },
  failureCloseBtn: {
    minWidth: TOUCH.min,
    minHeight: TOUCH.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  failureClose: { color: COLORS.textSecondary, fontSize: FONT_SIZE.sm },
  failureHint: { color: COLORS.text, fontSize: FONT_SIZE.xs, lineHeight: 17 },
  confirmText: { fontSize: FONT_SIZE.sm, color: COLORS.textSecondary, lineHeight: 21 },
  input: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    borderRadius: RADIUS.sm,
    minHeight: TOUCH.min,
    paddingHorizontal: SPACING.md,
    fontSize: FONT_SIZE.md,
    color: COLORS.text,
  },
  hintBelow: { fontSize: FONT_SIZE.xs, color: COLORS.textTertiary },
});
