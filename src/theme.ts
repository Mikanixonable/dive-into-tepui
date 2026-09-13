// UI のデザイントークン(配色・文字・角丸・余白・重なり順)の表と、それを :root の CSS 変数へ
// 当てるための名前と値。配色はプリセットから選び、Primitive(色の値)と Semantic(UI 上の意味)を
// 同じパレットで公開する。

// 配色プリセット1つ。
export interface ThemePalette {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tone: 'dark' | 'light';
  readonly page: string;
  readonly surface0: string;
  readonly surface1: string;
  readonly surface2: string;
  readonly surface3: string;
  readonly title: string;
  readonly body: string;
  readonly muted: string;
  readonly faint: string;
  readonly bright: string;
  readonly accent: string;
  readonly accentNear: string;
  // 主役色と対になる差し色。
  readonly signal: string;
  // 状態色。
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  readonly info: string;
  readonly focus: string;
  readonly focusContrast: string;
}

const DARK_SURFACE = {
  page: '#07080a', surface0: '#08090c', surface1: '#0e1014', surface2: '#15171c', surface3: '#1d2026',
  title: '#eeeaf5', body: '#c3bec9', muted: '#89838f', faint: '#5f5a65', bright: '#ffffff',
} as const;

const DARK_SEMANTIC = {
  success: '#19f5c2', warning: '#ffd166', error: '#ff4f5e', info: '#3478ff',
  focus: '#ffd43b', focusContrast: '#000000',
} as const;

const LIGHT_SEMANTIC = {
  success: '#006b4f', warning: '#6b4600', error: '#b42318', info: '#005ea8',
  focus: '#ffd43b', focusContrast: '#000000',
} as const;

// 選べる配色プリセット。
export const THEME_PRESETS: readonly ThemePalette[] = [
  {
    id: 'orbital-orange', name: 'Solar Flare', description: '暖色の主役とエメラルド Signal', tone: 'dark',
    ...DARK_SURFACE, ...DARK_SEMANTIC, accent: '#ff5a00', accentNear: '#ff8b52', signal: '#19f5c2',
  },
  {
    id: 'red-orange-turquoise', name: 'Heat Shield', description: '暖色と青緑の明快な Signal', tone: 'dark',
    ...DARK_SURFACE, ...DARK_SEMANTIC, accent: '#ff4a20', accentNear: '#ff8060', signal: '#1ee7d2',
  },
  {
    id: 'fluorescent-red-blue', name: 'Arcade Pulse', description: '赤と青の強い電気的対比', tone: 'dark',
    ...DARK_SURFACE, ...DARK_SEMANTIC, page: '#08090d', accent: '#ff3155', accentNear: '#ff6b82', signal: '#3478ff',
  },
  {
    id: 'fluorescent-pink-dawn-blue', name: 'Daybreak', description: '朱色寄りの蛍光ピンクと夜明けの淡い青', tone: 'dark',
    ...DARK_SURFACE, ...DARK_SEMANTIC, accent: '#ff2d6c', accentNear: '#ff6f96', signal: '#bfe0ff',
  },
  {
    id: 'driftwood', name: 'Driftwood', description: '褐色に寒色を差した落ち着いた色調', tone: 'dark',
    ...DARK_SURFACE, ...DARK_SEMANTIC, accent: '#a97a5b', accentNear: '#c49a7c', signal: '#6f8fa0',
  },
  {
    id: 'amber-field', name: 'Amber Field', description: '琥珀色を主役に深いティールで締める', tone: 'dark',
    ...DARK_SURFACE, ...DARK_SEMANTIC, accent: '#e8b23a', accentNear: '#f0cc75', signal: '#3fae8f',
  },
  {
    id: 'sagebrush', name: 'Sagebrush', description: 'テラコッタとセージグリーンのくすみ配色', tone: 'dark',
    ...DARK_SURFACE, ...DARK_SEMANTIC, accent: '#c1694a', accentNear: '#d98f72', signal: '#8ea88a',
  },
  {
    id: 'dusk-rose', name: 'Dusk Rose', description: 'くすみローズと深いティールの対比', tone: 'dark',
    ...DARK_SURFACE, ...DARK_SEMANTIC, accent: '#d98a94', accentNear: '#e8aab1', signal: '#388781',
  },
  {
    id: 'glacier-mint', name: 'Glacier Mint', description: 'ラベンダーとミントの淡いペア', tone: 'dark',
    ...DARK_SURFACE, ...DARK_SEMANTIC, accent: '#9b8cff', accentNear: '#bfb3ff', signal: '#7de0c8',
  },
  {
    id: 'repository-mono', name: 'Terminal', description: 'ダークグレーと白、Signalは最小限', tone: 'dark',
    page: '#0d1117', surface0: '#0d1117', surface1: '#161b22', surface2: '#21262d', surface3: '#30363d',
    title: '#f0f6fc', body: '#c9d1d9', muted: '#8b949e', faint: '#6e7681', bright: '#ffffff',
    ...DARK_SEMANTIC, accent: '#c9d1d9', accentNear: '#8b949e', signal: '#58a6ff',
  },
  {
    id: 'matte-red', name: 'Sunbaked', description: '暖かい灰白地とマットな赤', tone: 'light',
    page: '#d9d7d2', surface0: '#efede8', surface1: '#f8f6f1', surface2: '#e5e2dc', surface3: '#cac6bf',
    title: '#252525', body: '#494949', muted: '#625e59', faint: '#96928c', bright: '#111111',
    ...LIGHT_SEMANTIC, accent: '#873b35', accentNear: '#a95d54', signal: '#4e545a',
  },
] as const;

// 選択中の配色によらず固定の light パレット。
export const LIGHT_PALETTE: ThemePalette = THEME_PRESETS.find((palette) => palette.tone === 'light') ?? THEME_PRESETS[0]!;

// 未保存・プリセットに無い id のときの配色。
const DEFAULT_THEME_ID = 'fluorescent-red-blue';

// id が指すプリセット。プリセットに無い id では null。
export function themePresetOf(id: string): ThemePalette | null {
  return THEME_PRESETS.find((palette) => palette.id === id) ?? null;
}

// 保存された配色 id をパレットへ読み直す。未保存・読めない id では既定の配色に戻る。
export function parseThemePalette(text: string | null): ThemePalette {
  return themePresetOf(text ?? '') ?? themePresetOf(DEFAULT_THEME_ID)!;
}

// 配色を保存へ載せる文字列にする。
export function formatThemePalette(palette: ThemePalette): string {
  return palette.id;
}

// '#rrggbb' の色に alpha を添えた CSS の rgba() 文字列。
function rgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

// 面と地の境目。選択中の配色の文字色から導く。
export function edgeColor(palette: ThemePalette): string {
  return rgba(palette.title, 0.16);
}

const SHADE_1 = 'rgba(0, 0, 0, 0.18)'; // 弱い落とし影
const GLASS_SHADOW = '0 16px 48px rgba(0, 0, 0, 0.24)';
const GLASS_BLUR_QUIET = '16px';
const GLASS_BLUR_FOCUS = '24px';
const GLASS_SATURATION = '110%';
const SCRIM = 'rgba(6, 7, 9, 0.82)'; // 全画面表示の背後を覆う膜

// グロー(text-shadow)を任意の色から作るための混合率。
// `color-mix(in srgb, <色> ${GLOW_STRONG}, transparent)` の形で使う。
const GLOW_STRONG = '60%'; // 通常のグロー
const GLOW_WEAK = '35%'; // 淡い外側のグロー

// Δv 編集の3軸(順行・法線・動径)の色。
export const AXIS_PROGRADE = '#3b82f6';
export const AXIS_NORMAL = '#10b981';
export const AXIS_RADIAL = '#ef4444';

// 文字サイズ。8段。マーカーのグリフサイズ(GLYPH_*)はこれとは別スケール。
export const FONT_XXS = '11px';
export const FONT_XS = '12px';
const FONT_S = '13px';
export const FONT_M = '14px';
const FONT_L = '15px';
export const FONT_XL = '18px';
export const FONT_2XL = '24px';
const FONT_3XL = '34px';

// 世界座標マーカーの字形に合わせた調整値。UI の文字スケール(FONT_*)とは独立。
const GLYPH_BASE = '22px'; // .mk .sym の基準
const GLYPH_POI = '5px'; // 天体ラベルの点(.mk-poi)
const GLYPH_BORESIGHT = '36px'; // .mk-boresight

// 角丸。役割ごとの4段。
export const RADIUS_MICRO = '8px';
export const RADIUS_CONTROL = '11px';
const RADIUS_PANEL = '16px';
export const RADIUS_WINDOW = '22px';
const RADIUS_PILL = '999px'; // トラックなど、完全な角丸ピル

// 余白。6段。
export const SPACE_1 = '2px';
export const SPACE_2 = '4px';
export const SPACE_3 = '6px';
export const SPACE_4 = '8px';
const SPACE_5 = '12px';
const SPACE_6 = '18px';

// トランジション。操作への即応(FAST)と、フェード・バーの伸縮など見せる変化(SLOW)の2段。
const TRANSITION_FAST = '0.15s';
export const TRANSITION_SLOW = '0.24s';

const HIT_TARGET_MIN = '44px'; // タップ最小寸法

// ページ直下(body の子)の要素間の重なり順。#hud の内部は別のスタッキング文脈なので、
// #hud 内部の z-index とは比べない。
export const Z_TOUCH_UI = 9;
const Z_HUD = 10;
export const Z_HUD_NODE_GIZMO = 5; // #hud 内部で、HUD の層の外に置く要素
const Z_HUD_RAIL_TOGGLE = 20; // #hud 内部で、HUD の層の外に置く要素
const Z_HUD_TITLE_MENU = 110;
export const Z_STAGE_SELECT = 100;
export const Z_LOADING_OVERLAY = 200;
export const Z_FATAL_ERROR = 1000;

// ノッチ・ホームインジケータ等が占める領域の幅。env() は CSS 側でしか評価できないため、
// 計算済みの値ではなく env() 呼び出し自体を注入する。
export const SAFE_AREA_TOP = 'env(safe-area-inset-top, 0px)';
export const SAFE_AREA_RIGHT = 'env(safe-area-inset-right, 0px)';
export const SAFE_AREA_BOTTOM = 'env(safe-area-inset-bottom, 0px)';
export const SAFE_AREA_LEFT = 'env(safe-area-inset-left, 0px)';

// ラテン字形は JetBrains Mono、日本語を含む残りは HackGen が担う。
export const FONT_FAMILY =
  "'JetBrains Mono', 'HackGen', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

// 配色によらないトークン。--token-name のケバブケースで :root に置く。
// calc() を要するトークンは、計算済みの値ではなく派生関係そのものを値にする。
const FIXED_CSS_VARIABLES: Readonly<Record<string, string>> = {
  // 宇宙空間のラベルは星空の上に載るので、配色によらない固定色を使う。
  '--space-label-background': '#0b0d11',
  '--space-label-text': '#f5f7ff',
  '--space-label-subtext': '#b8c1d1',
  '--glass-shadow': GLASS_SHADOW,
  '--glass-blur-quiet': GLASS_BLUR_QUIET,
  '--glass-blur-focus': GLASS_BLUR_FOCUS,
  '--glass-saturation': GLASS_SATURATION,
  '--shade-1': SHADE_1,
  '--scrim': SCRIM,
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
  '--radius-s': RADIUS_MICRO,
  '--radius-m': RADIUS_CONTROL,
  '--radius-l': RADIUS_PANEL,
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
  '--z-hud': String(Z_HUD),
  '--z-hud-title-menu': String(Z_HUD_TITLE_MENU),
  '--z-hud-rail-toggle': String(Z_HUD_RAIL_TOGGLE),
  '--safe-t': SAFE_AREA_TOP,
  '--safe-r': SAFE_AREA_RIGHT,
  '--safe-b': SAFE_AREA_BOTTOM,
  '--safe-l': SAFE_AREA_LEFT,
  '--font-family': FONT_FAMILY,
};

// palette を当てたときの CSS 変数の名前と値、すべて。
export function themeCssVariables(palette: ThemePalette): Readonly<Record<string, string>> {
  return {
    ...FIXED_CSS_VARIABLES,
    // 主役色。
    '--color-primary': palette.accent,
    '--color-primary-hover': palette.accentNear,
    '--color-signal': palette.signal,
    '--color-primary-fill-weak': rgba(palette.accent, 0.08), // 選択されていない行の背景など、ごく控えめな地色
    '--color-primary-fill': rgba(palette.accent, 0.16), // 選択中・ホバー中の地色
    '--color-primary-fill-strong': rgba(palette.accent, 0.24), // 押下中・強調表示の地色
    // 状態色。
    '--color-success': palette.success,
    '--color-success-fill': rgba(palette.success, 0.12),
    '--color-success-edge': rgba(palette.success, 0.42),
    '--color-warning': palette.warning,
    '--color-warning-fill': rgba(palette.warning, 0.12),
    '--color-warning-edge': rgba(palette.warning, 0.42),
    '--color-error': palette.error,
    '--color-error-fill': rgba(palette.error, 0.12),
    '--color-error-edge': rgba(palette.error, 0.42),
    '--color-info': palette.info,
    '--color-info-fill': rgba(palette.info, 0.12),
    '--color-info-edge': rgba(palette.info, 0.42),
    '--color-focus': palette.focus,
    '--color-focus-contrast': palette.focusContrast,
    // 地と面。
    '--bg': palette.page,
    '--theme-tone': palette.tone,
    '--surface-0': palette.surface0,
    '--surface-1': palette.surface1,
    '--surface-2': palette.surface2,
    '--surface-3': palette.surface3,
    '--surface-weak': rgba(palette.surface0, 0.52), // 背後を強く透かすラベル地
    '--surface': rgba(palette.surface1, 0.64), // Quiet Glass
    '--surface-opaque': rgba(palette.surface1, 0.96), // Solid に近い全画面表示用
    '--glass-quiet': rgba(palette.surface1, 0.64),
    '--glass-focus': rgba(palette.surface1, 0.76),
    '--glass-inset': rgba(palette.surface0, 0.28),
    '--glass-control': rgba(palette.surface2, 0.68),
    '--glass-control-hover': rgba(palette.surface3, 0.72),
    '--edge': edgeColor(palette),
    '--bar-bg': palette.surface3, // ゲージ類の不透明な地(背後を透かさない)
    // 文字と、文字色から導く中立の薄膜。値が大きいほど強く主張する。
    '--text-strong': palette.bright,
    '--text': palette.title,
    '--text-muted': palette.body,
    '--text-dim': palette.muted,
    '--text-faint': palette.faint,
    '--title': palette.title,
    '--body': palette.body,
    '--muted': palette.muted,
    '--fill-1': rgba(palette.title, 0.04),
    '--fill-2': rgba(palette.title, 0.09),
    '--fill-3': rgba(palette.title, 0.16),
    '--fill-4': rgba(palette.title, 0.32),
  };
}

// '#rrggbb' の色の WCAG 相対輝度 [0〜1]。
function relativeLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [value >> 16, value >> 8, value].map((channel) => (channel & 0xff) / 255);
  const linear = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

// 2色の WCAG コントラスト比 [1〜21]。引数の順によらない。
function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

interface ThemeContrastIssue {
  readonly themeId: string;
  readonly pair: string;
  readonly ratio: number;
  readonly minimum: number;
}

// palette の色の組のうち、WCAG のコントラスト比の基準に満たないもの。
function themeContrastIssues(palette: ThemePalette): readonly ThemeContrastIssue[] {
  // 文字とその地の組は 4.5 以上。
  const textPairs = [
    ['text', palette.title, palette.surface1],
    ['body', palette.body, palette.surface1],
    ['muted', palette.muted, palette.surface1],
    ['primary', palette.accent, palette.page],
    ['signal', palette.signal, palette.page],
    ['success', palette.success, palette.page],
    ['warning', palette.warning, palette.page],
    ['error', palette.error, palette.page],
    ['info', palette.info, palette.page],
  ] as const;
  const issues: ThemeContrastIssue[] = textPairs.flatMap(([pair, foreground, background]) => {
    const ratio = contrastRatio(foreground, background);
    return ratio >= 4.5 ? [] : [{ themeId: palette.id, pair, ratio, minimum: 4.5 }];
  });
  // フォーカス枠は非文字なので 3 以上。
  const focusRatio = contrastRatio(palette.focus, palette.focusContrast);
  if (focusRatio < 3) issues.push({ themeId: palette.id, pair: 'focus-keyline', ratio: focusRatio, minimum: 3 });
  return issues;
}

// 全プリセットのコントラスト不足の一覧。tools/verify-theme-contrast.mjs がビルドの外から呼ぶので、
// src/ に参照が無くても消さない。
export function allThemeContrastIssues(): readonly ThemeContrastIssue[] {
  return THEME_PRESETS.flatMap(themeContrastIssues);
}
