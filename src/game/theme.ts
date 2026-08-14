// Runtime UI の意味トークン。値と役割は UI_DESIGN_REFERENCE_V6 を正本とする。
// ゲーム世界(マーカー・演出・船体など)の Material 色は const.ts が持ち、ここには含まない。

export const ACCENT = '#ff5a00';
export const ACCENT_SOFT = '#ff8b52';
export const ACCENT_SECONDARY = '#19f5c2';
// 危険・警告だけに使う意味色。第一ターゲットは ACCENT を使う。
export const DANGER = '#ff4f5e';
export const DANGER_FILL = 'rgba(255, 79, 94, 0.08)'; // 危険を示す領域の地色

export const BG = '#07080a';
export const SURFACE_0 = '#08090c';
export const SURFACE_1 = '#0e1014';
export const SURFACE_2 = '#15171c';
export const SURFACE_3 = '#1d2026';
export const SURFACE_WEAK = 'rgba(8, 9, 12, 0.52)'; // 背後を強く透かすラベル地
export const SURFACE = 'rgba(14, 16, 20, 0.64)'; // Quiet Glass
export const SURFACE_OPAQUE = 'rgba(14, 16, 20, 0.96)'; // Solid に近い全画面表示用
export const GLASS_QUIET = 'rgba(14, 16, 20, 0.64)';
export const GLASS_FOCUS = 'rgba(14, 16, 20, 0.76)';
export const EDGE = 'rgba(238, 234, 245, 0.16)';

export const TEXT_STRONG = '#ffffff';
// UI用のわずかに紫がかった白。ゲーム世界のマーカー色とは独立したHUD基準色。
export const TEXT = '#eeeaf5';
export const TEXT_MUTED = '#c3bec9';
export const TEXT_DIM = '#89838f';

// アクセントの薄膜。値が大きいほど強く主張する。
export const ACCENT_FILL_WEAK = 'rgba(255, 90, 0, 0.08)'; // 選択されていない行の背景など、ごく控えめな地色
export const ACCENT_FILL = 'rgba(255, 90, 0, 0.16)'; // 選択中・ホバー中の地色
export const ACCENT_FILL_STRONG = 'rgba(255, 90, 0, 0.24)'; // 押下中・強調表示の地色
export const ACCENT_EDGE_SOFT = 'rgba(255, 90, 0, 0.22)'; // 見出し下線などの控えめな縁
export const ACCENT_EDGE = 'rgba(255, 90, 0, 0.4)'; // ボタン・パネルの通常の縁

// 中立の薄膜。値が大きいほど強く主張する。EDGE と同じオフホワイトを基調とする。
export const FILL_1 = 'rgba(238, 235, 248, 0.04)';
export const FILL_2 = 'rgba(238, 235, 248, 0.09)';
export const FILL_3 = 'rgba(238, 235, 248, 0.16)';
export const FILL_4 = 'rgba(238, 235, 248, 0.32)';

export const SHADE_1 = 'rgba(0, 0, 0, 0.18)'; // 弱い落とし影
export const SCRIM = 'rgba(6, 7, 9, 0.82)'; // 全画面表示の背後を覆う膜
export const BAR_BG = '#222222'; // ゲージ類の不透明な地(背後を透かさない)

// グロー(text-shadow)を任意の色から作るための混合率。
// `color-mix(in srgb, <色> ${GLOW_STRONG}, transparent)` の形で使う。
export const GLOW_STRONG = '60%'; // 通常のグロー
export const GLOW_WEAK = '35%'; // 淡い外側のグロー

// Δv 編集の3軸。plan-editor.ts の DOM パネルと plan-gizmo-3d.ts の3D矢印が共有する。
export const AXIS_PROGRADE = '#3b82f6';
export const AXIS_NORMAL = '#10b981';
export const AXIS_RADIAL = '#ef4444';

// 文字サイズ。8段。マーカーのグリフサイズ(GLYPH_*)はこれとは別スケール。
export const FONT_XXS = '9px';
export const FONT_XS = '10px';
export const FONT_S = '11px';
export const FONT_M = '12px';
export const FONT_L = '13px';
export const FONT_XL = '16px';
export const FONT_2XL = '24px';
export const FONT_3XL = '34px';

// 世界座標マーカーの字形に合わせた調整値。UI の文字スケール(FONT_*)とは独立。
export const GLYPH_BASE = '22px'; // .mk .sym の基準
export const GLYPH_2_3 = `calc(${GLYPH_BASE} * 2 / 3)`; // .mk-bearing-triangle
export const GLYPH_1_3 = `calc(${GLYPH_BASE} / 3)`; // .mk-ally-dir
export const GLYPH_POI = '5px'; // 天体ラベルの点(.mk-poi)
export const GLYPH_BORESIGHT = '36px'; // .mk-boresight

// 角丸。役割名を正本とし、旧3段名は既存UIとの互換用に対応させる。
export const RADIUS_MICRO = '8px';
export const RADIUS_CONTROL = '11px';
export const RADIUS_PANEL = '16px';
export const RADIUS_WINDOW = '22px';
export const RADIUS_S = RADIUS_MICRO;
export const RADIUS_M = RADIUS_CONTROL;
export const RADIUS_L = RADIUS_PANEL;
export const RADIUS_PILL = '999px'; // トラックなど、完全な角丸ピル

// 余白。6段。
export const SPACE_1 = '2px';
export const SPACE_2 = '4px';
export const SPACE_3 = '6px';
export const SPACE_4 = '8px';
export const SPACE_5 = '12px';
export const SPACE_6 = '18px';

// トランジション。操作への即応(FAST)と、フェード・バーの伸縮など見せる変化(SLOW)の2段。
export const TRANSITION_FAST = '0.15s';
export const TRANSITION_SLOW = '0.24s';

export const HIT_TARGET_MIN = '44px'; // タップ最小寸法

// ノッチ・ホームインジケータ等が占める領域の幅。env() は CSS 側でしか評価できないため、
// 計算済みの値ではなく env() 呼び出し自体を注入する。
export const SAFE_AREA_TOP = 'env(safe-area-inset-top, 0px)';
export const SAFE_AREA_RIGHT = 'env(safe-area-inset-right, 0px)';
export const SAFE_AREA_BOTTOM = 'env(safe-area-inset-bottom, 0px)';
export const SAFE_AREA_LEFT = 'env(safe-area-inset-left, 0px)';

// ラテン字形は JetBrains Mono、日本語を含む残りは HackGen が担う。どちらも main.ts が
// バンドルから読み込むので、外部への追加リクエストは発生しない。
export const FONT_FAMILY =
  "'JetBrains Mono', 'HackGen', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

// --token-name のケバブケースで :root にカスタムプロパティとして注入するトークンの一覧。
// calc() を要するトークンは、計算済みの値ではなく派生関係そのものを注入する。
const CSS_VARIABLES: Readonly<Record<string, string>> = {
  '--accent': ACCENT,
  '--accent-soft': ACCENT_SOFT,
  '--accent-near': ACCENT_SOFT,
  '--accent-secondary': ACCENT_SECONDARY,
  '--danger': DANGER,
  '--danger-fill': DANGER_FILL,
  '--bg': BG,
  '--page': BG,
  '--surface-0': SURFACE_0,
  '--surface-1': SURFACE_1,
  '--surface-2': SURFACE_2,
  '--surface-3': SURFACE_3,
  '--surface-weak': SURFACE_WEAK,
  '--surface': SURFACE,
  '--surface-opaque': SURFACE_OPAQUE,
  '--glass-quiet': GLASS_QUIET,
  '--glass-focus': GLASS_FOCUS,
  '--edge': EDGE,
  '--text-strong': TEXT_STRONG,
  '--text': TEXT,
  '--text-muted': TEXT_MUTED,
  '--text-dim': TEXT_DIM,
  '--title': TEXT,
  '--body': TEXT_MUTED,
  '--muted': TEXT_DIM,
  '--accent-fill-weak': ACCENT_FILL_WEAK,
  '--accent-fill': ACCENT_FILL,
  '--accent-fill-strong': ACCENT_FILL_STRONG,
  '--accent-edge-soft': ACCENT_EDGE_SOFT,
  '--accent-edge': ACCENT_EDGE,
  '--fill-1': FILL_1,
  '--fill-2': FILL_2,
  '--fill-3': FILL_3,
  '--fill-4': FILL_4,
  '--shade-1': SHADE_1,
  '--scrim': SCRIM,
  '--bar-bg': BAR_BG,
  '--glow-strong': GLOW_STRONG,
  '--glow-weak': GLOW_WEAK,
  '--axis-prograde': AXIS_PROGRADE,
  '--axis-normal': AXIS_NORMAL,
  '--axis-radial': AXIS_RADIAL,
  '--font-xxs': FONT_XXS,
  '--font-xs': FONT_XS,
  '--font-s': FONT_S,
  '--font-m': FONT_M,
  '--font-l': FONT_L,
  '--font-xl': FONT_XL,
  '--font-2xl': FONT_2XL,
  '--font-3xl': FONT_3XL,
  '--glyph-base': GLYPH_BASE,
  '--glyph-2-3': 'calc(var(--glyph-base) * 2 / 3)',
  '--glyph-1-3': 'calc(var(--glyph-base) / 3)',
  '--glyph-poi': GLYPH_POI,
  '--glyph-boresight': GLYPH_BORESIGHT,
  '--radius-s': RADIUS_S,
  '--radius-m': RADIUS_M,
  '--radius-l': RADIUS_L,
  '--radius-micro': RADIUS_MICRO,
  '--radius-control': RADIUS_CONTROL,
  '--radius-panel': RADIUS_PANEL,
  '--radius-window': RADIUS_WINDOW,
  '--radius-pill': RADIUS_PILL,
  '--space-1': SPACE_1,
  '--space-2': SPACE_2,
  '--space-3': SPACE_3,
  '--space-4': SPACE_4,
  '--space-5': SPACE_5,
  '--space-6': SPACE_6,
  '--transition-fast': TRANSITION_FAST,
  '--transition-slow': TRANSITION_SLOW,
  '--hit-target-min': HIT_TARGET_MIN,
  '--safe-t': SAFE_AREA_TOP,
  '--safe-r': SAFE_AREA_RIGHT,
  '--safe-b': SAFE_AREA_BOTTOM,
  '--safe-l': SAFE_AREA_LEFT,
  '--font-family': FONT_FAMILY,
};

let injected = false;

// 全トークンを :root にカスタムプロパティとして注入する。#touch-ui は #hud の外
// (body 直下)にあるため、両方から見える :root に置く。多重呼び出しに耐える。
export function injectThemeVariables(): void {
  if (injected) return;
  injected = true;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(CSS_VARIABLES)) {
    root.style.setProperty(name, value);
  }
}
