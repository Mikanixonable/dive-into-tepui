// ゲームバランス・チューニング定数
import type { GuideGroupId } from './celestial/orbit-guide/orbit-guide-settings';

// --- 空力加熱・構造限界 ---

// --- ラジエーター(上下2枚、個別展開) ---

// --- 太陽電池による発電 ---

// --- 弾薬・マガジン ---
export const MAX_ACTIVE_AMMO_PICKUPS = 3; // 同時に存在する補給の最大数

// --- 高負荷デバッグステージ(stage-debug-load.ts)---
// 破片は衛星の破壊直後の雲を想定し、自機の周囲に留める。
export const DEBUG_LOAD_DEBRIS_COUNT = 500;
export const DEBUG_LOAD_DEBRIS_MAX_DIST = 250000; // [m]
export const DEBUG_LOAD_PLACEMENT_MIN_DIST = 5000; // 自機からの配置距離下限 [m]
export const DEBUG_LOAD_RNG_SEED = 20260810;

// --- HUD マーカー ---

// 共線点(L1/L2/L3)を持たせる下限。副天体の半径を単位とした L1 までの距離で、これを下回る系は
// L1 が表面すれすれに来てハロー軌道の振幅が収まらない(フォボス 1.5・イオ 5.8 が落ちる)。
export const LAGRANGE_MIN_CLEARANCE_RATIO = 10;

// --- 軌道計画モード([M]) ---
// 星球シェル・天球グリッドの表示半径。マップの広範囲視点カメラの far は dist に連動して
// 毎フレーム変わるため、そこに結びつけると星殻半径も毎フレーム変動してしまう。
// far とは独立に固定する。
// far の下限(OVERVIEW_CAMERA_FAR_MIN)より 10% 内側に取る — 等しいと最小ズームで
// 殻のジオメトリが far 平面上に乗り、視線方向の星・グリッドがクリップされる。
export const NODE_DV_RATE = 300; // Δv 調整速度 [m/s per 実秒]
export const NODE_DV_RATE_FINE = 30; // 微調整モード時
// ノード実行時刻の何秒前から「実行の窓」とみなすか [s]。噴射準備の通知・達成判定の開始・
// 自動ワープの解除がこの1点を共有する。
export const NODE_APPROACH_LEAD = 10;

// --- 未来表示の時刻(display-window-manager.ts のスライダー) ---
export const DISPLAY_DURATION_MAX = 365 * 86400; // 手動レンジで指定できる表示期間の上限 [s](1年)

// --- 軌道計画の折れ線(plan/plan-path.ts) ---
// 周期を持たない軌道(双曲線・放物線)で、1周期の代わりに区間の長さとして使う値 [s]。
export const APERIODIC_ARC_DURATION = 86400;

// --- 第零ステージ(近接戦闘訓練) ---
export const STAGE0_PER_GROUP = 10; // グループあたりの機数
export const STAGE0_MAX_RANGE = 5000; // 自機からの配置半径の上限 [m]

// --- ステージ00(無限耐久サバイバル) ---
export const STAGE00_LOGISTICS_MIN_DIST = 12.5; // 補給の配置距離 [m](自機から)
export const STAGE00_LOGISTICS_MAX_DIST = 50;

// ゼロ速度曲線(ガイドタブ5.3節)。軌道ガイド線の青・橙・緑・紫、静止軌道リングの灰色と
// 見分けがつく控えめな薔薇色。
export const COLOR_STAGE0_GROUP_ACCENTS = ['#ff4a3d', '#3dc6ff', '#3dff8f', '#ffe23d', '#bf3dff'];

// 軌道ガイド(orbit-guide-lines.ts)の群ごとの基準色相。群の中の種類は明度違いで分ける
// (guideKindDefaultColors)。静止軌道リング(0x8b93a0)と同じ控えめな系統でまとめる。
const GUIDE_GROUP_HUE: Readonly<Record<GuideGroupId, number>> = {
  collinear: 0x6fa3c9, // 青(旧ハロー色を踏襲)
  triangular: 0xc9a969, // 橙
  secondary: 0x6fc9b8, // 緑(DRO/DPO/LPO)
  resonant: 0xb08bc9, // 紫
};

// color を towards との線形補間で t(0..1)だけ明るく/暗くした 0xRRGGBB を返す。
function lerpColor(color: number, towards: number, t: number): number {
  const r0 = (color >> 16) & 0xff, g0 = (color >> 8) & 0xff, b0 = color & 0xff;
  const r1 = (towards >> 16) & 0xff, g1 = (towards >> 8) & 0xff, b1 = towards & 0xff;
  return (Math.round(r0 + (r1 - r0) * t) << 16) | (Math.round(g0 + (g1 - g0) * t) << 8) | Math.round(b0 + (b1 - b0) * t);
}

// 群の色相を、群内での種類の並び順(index/count)に応じた明度違いへ展開する。
function guideKindShade(group: GuideGroupId, index: number, count: number): number {
  const base = GUIDE_GROUP_HUE[group];
  if (count <= 1) return base;
  return lerpColor(base, 0xffffff, 0.15 + 0.5 * (index / (count - 1)));
}

// GuideKindSettings の既定色(始・終)。始は上の shade、終はそこからさらに明るい側を採る。
export function guideKindDefaultColors(group: GuideGroupId, index: number, count: number): readonly [number, number] {
  const start = guideKindShade(group, index, count);
  return [start, lerpColor(start, 0xffffff, 0.35)];
}
