import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GestureResponderEvent, Image, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Polygon } from 'react-native-svg';
import { COLORS, FONT_SIZE, RADIUS, SPACING } from '../constants';
import { contentRect, isDegenerate, orderCorners, quadToScreen, screenToQuad } from '../utils/quad';
import { fileUri } from '../utils/scanFiles';
import type { QuadPoint } from '../types';

interface Props {
  /** 本地图片路径（裸路径或 file:// 都行） */
  path: string;
  imageWidth: number;
  imageHeight: number;
  initialQuad: QuadPoint[];
  onConfirm: (quad: QuadPoint[]) => void;
  onCancel: () => void;
  onReset?: () => void;
}

const HANDLE = 22;
const HIT_SLOP = 22;

/**
 * 四角调整（并列页，不是 Modal —— 相机页用 display 互斥隐藏，触摸与安全区行为才和首页一致）。
 *
 * 叠加层画在 contentRect（letterbox 后的实际图像矩形）上，
 * 否则「用户拖的角点」和「图上看到的角点」会错开几像素，看起来像算法不准。
 */
export default function CornerAdjust({
  path,
  imageWidth,
  imageHeight,
  initialQuad,
  onConfirm,
  onCancel,
  onReset,
}: Props) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [quad, setQuad] = useState<QuadPoint[]>(() => orderCorners(initialQuad));
  // 拖拽回调给的是 pageX/pageY（整页坐标），而 rect 是画布内坐标 ——
  // 不减掉画布在窗口里的原点，把手会整体偏一个导航栏的高度（这类偏移最难查，因为「能拖」）
  const canvasRef = useRef<View>(null);
  const originRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    setQuad(orderCorners(initialQuad));
  }, [initialQuad]);

  const rect = useMemo(
    () => contentRect(imageWidth, imageHeight, box.width, box.height),
    [imageWidth, imageHeight, box],
  );
  const screenPoints = useMemo(() => quadToScreen(quad, rect), [quad, rect]);

  const updateCorner = useCallback(
    (index: number, pageX: number, pageY: number) => {
      const local = { x: pageX - originRef.current.x, y: pageY - originRef.current.y };
      setQuad((prev) => {
        const next = prev.slice();
        const [normalized] = screenToQuad([local], rect);
        next[index] = normalized;
        return next;
      });
    },
    [rect],
  );

  const measureCanvas = useCallback(() => {
    canvasRef.current?.measureInWindow((x, y) => {
      originRef.current = { x, y };
    });
  }, []);

  const degenerate = isDegenerate(orderCorners(quad));
  const uri = useMemo(() => fileUri(path), [path]);

  return (
    <View style={styles.root}>
      <View style={styles.nav}>
        <Pressable onPress={onCancel} hitSlop={10} accessibilityRole="button" accessibilityLabel="返回">
          <Text style={styles.back}>‹ 返回</Text>
        </Pressable>
        <Text style={styles.navTitle} numberOfLines={1}>
          调整四角
        </Text>
        {onReset ? (
          <Pressable onPress={onReset} hitSlop={10} accessibilityRole="button" accessibilityLabel="重来">
            <Text style={styles.reset}>重来</Text>
          </Pressable>
        ) : (
          <View style={styles.navSpacer} />
        )}
      </View>

      <View
        ref={canvasRef}
        style={styles.canvas}
        onLayout={(e) => {
          setBox({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
          measureCanvas();
        }}
      >
        {box.width > 0 ? (
          <>
            <Image
              source={{ uri }}
              style={[styles.image, { left: rect.x, top: rect.y, width: rect.width, height: rect.height }]}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
            />
            {/* 多边形不吃手势（pointerEvents=none），只有四个把手可拖 */}
            <Svg width={box.width} height={box.height} style={StyleSheet.absoluteFill} pointerEvents="none">
              <Polygon
                points={screenPoints.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="rgba(121,134,203,0.10)"
                stroke={COLORS.accent}
                strokeWidth={2}
              />
              {screenPoints.map((p, i) => {
                const q = screenPoints[(i + 1) % 4];
                return (
                  <Line
                    key={`edge-${i}`}
                    x1={p.x}
                    y1={p.y}
                    x2={q.x}
                    y2={q.y}
                    stroke={COLORS.accent}
                    strokeWidth={2}
                  />
                );
              })}
            </Svg>
            {screenPoints.map((p, i) => (
              <CornerHandle
                key={`handle-${i}`}
                index={i}
                x={p.x}
                y={p.y}
                onDrag={(x, y) => updateCorner(i, x, y)}
              />
            ))}
          </>
        ) : null}
      </View>

      <Text style={styles.hint}>
        {degenerate
          ? '四个角太靠近了，这样会得到一张废图 —— 拖开到纸张的四个角'
          : '把四个角拖到纸的四角，斜着拍也能拉正'}
      </Text>

      <View style={styles.actions}>
        <Pressable style={styles.secondary} onPress={onCancel} accessibilityRole="button">
          <Text style={styles.secondaryText}>取消</Text>
        </Pressable>
        <Pressable
          style={[styles.primary, degenerate && styles.primaryDisabled]}
          disabled={degenerate}
          onPress={() => onConfirm(orderCorners(quad))}
          accessibilityRole="button"
        >
          <Text style={styles.primaryText}>确定</Text>
        </Pressable>
      </View>
    </View>
  );
}

function CornerHandle({
  index,
  x,
  y,
  onDrag,
}: {
  index: number;
  x: number;
  y: number;
  onDrag: (x: number, y: number) => void;
}) {
  // 拖拽过程中要一直拿到同一个回调，所以把最新回调存进 ref
  const dragRef = useRef(onDrag);
  dragRef.current = onDrag;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e: GestureResponderEvent) => {
          const { pageX, pageY } = e.nativeEvent;
          dragRef.current(pageX, pageY);
        },
        onPanResponderMove: (e: GestureResponderEvent) => {
          const { pageX, pageY } = e.nativeEvent;
          dragRef.current(pageX, pageY);
        },
      }),
    [],
  );

  return (
    <View
      style={[styles.handleTouch, { left: x - HIT_SLOP, top: y - HIT_SLOP, zIndex: 10 + index }]}
      {...responder.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel={`第 ${index + 1} 个角`}
    >
      <View style={styles.handle} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.cameraBackdrop },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.sm,
  },
  back: { color: COLORS.onCameraText, fontSize: FONT_SIZE.md, fontWeight: '600', minWidth: 56 },
  navTitle: {
    color: COLORS.onCameraText,
    fontSize: FONT_SIZE.lg,
    fontWeight: '700',
    flexShrink: 1,
    textAlign: 'center',
  },
  reset: {
    color: COLORS.frameGuide,
    fontSize: FONT_SIZE.md,
    fontWeight: '600',
    minWidth: 56,
    textAlign: 'right',
  },
  navSpacer: { minWidth: 56 },
  canvas: { flex: 1, marginHorizontal: SPACING.sm },
  image: { position: 'absolute' },
  hint: {
    color: COLORS.onCameraTextDim,
    fontSize: FONT_SIZE.xs,
    textAlign: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
  },
  actions: {
    flexDirection: 'row',
    gap: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.xl,
  },
  secondary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.onCameraBorder,
    alignItems: 'center',
  },
  secondaryText: { color: COLORS.onCameraText, fontSize: FONT_SIZE.md, fontWeight: '600' },
  primary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
  },
  primaryDisabled: { opacity: 0.4 },
  primaryText: { color: COLORS.white, fontSize: FONT_SIZE.md, fontWeight: '700' },
  handleTouch: {
    position: 'absolute',
    width: HIT_SLOP * 2,
    height: HIT_SLOP * 2,
  },
  handle: {
    position: 'absolute',
    left: HIT_SLOP - HANDLE / 2,
    top: HIT_SLOP - HANDLE / 2,
    width: HANDLE,
    height: HANDLE,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.white,
    borderWidth: 3,
    borderColor: COLORS.accent,
  },
});
