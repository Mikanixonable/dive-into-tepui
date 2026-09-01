// ゲームバランス・チューニング定数
import type { GuideGroupId } from './celestial/orbit-guide/orbit-guide-settings';

// --- 空力加熱・構造限界 ---

// --- ラジエーター(上下2枚、個別展開) ---

// --- 太陽電池による発電 ---

export const BASE_FOV = 55; // 通常時の垂直画角 [deg]

// キーボードでの視点回転(矢印キー)[rad/s]。マウスドラッグと同じ感覚になる値。
export const CAM_KEY_YAW_RATE = 1.4;
export const CAM_KEY_PITCH_RATE = 1.0;

// --- 弾薬・マガジン ---
export const MAX_ACTIVE_AMMO_PICKUPS = 3; // 同時に存在する補給の最大数
// pointer:coarse(タッチ等)向けの上記3定数の緩和版。~44px半径。
export const CLICK_MOVE_THRESHOLD = 6; // これ未満の累積移動量ならドラッグではなくクリック扱い [px]

// --- 高負荷デバッグステージ(stage-debug-load.ts)---
// 破片は衛星の破壊直後の雲を想定し、自機の周囲に留める。
export const DEBUG_LOAD_DEBRIS_COUNT = 500;
export const DEBUG_LOAD_DEBRIS_MAX_DIST = 250000; // [m]
export const DEBUG_LOAD_PLACEMENT_MIN_DIST = 5000; // 自機からの配置距離下限 [m]
export const DEBUG_LOAD_RNG_SEED = 20260810;

// --- HUD マーカー ---
export const MARKER_DIR_DIST = 5e4; // 方向マーカーを投影する仮想距離 [m](実在の位置ではなく方向のみを示す)
// 画面上で近接する2対象(マーカー・天体ラベル・ラグランジュ点ラベルいずれも)のカメラからの
// 距離比がこれ以上なら、優先度に関わらず遠い側を隠す(奥にあるだけの対象が手前の対象を
// 消してしまう逆転を防ぐ)。
export const DEPTH_GUARD_RATIO = 3;
// 一度 DEPTH_GUARD で隠した対象を再び出す距離比のしきい値(ENTER より緩い値)。同じ値だと
// しきい値ちょうどで距離比が揺れたときに毎フレーム表示・非表示が反転する
// (周期が数時間の衛星どうしなど、タイムワープ中に距離比が急変する組で顕著)。
export const DEPTH_GUARD_EXIT_RATIO = 2;

// マーカーラベル優先度 (数値が大きいものが優先。天体 > 船・エンティティ)
export const MARKER_PRIORITY = {
  STAR_PLANET: 5000,
  DWARF_PLANET: 4000,
  SATELLITE_SMALL_BODY: 3000,
  LAGRANGE: 2000,
  PRIMARY_TARGET: 900,
  IMPACT: 850,
  BASE: 700,
  PLAYER: 600,
  ENEMY: 500,
  AMMO: 300,
  MANEUVER_NODE: 150,
  ORBITAL_NODE: 100,
  PROTEIN_SITE: 50,
} as const;

// 共線点(L1/L2/L3)を持たせる下限。副天体の半径を単位とした L1 までの距離で、これを下回る系は
// L1 が表面すれすれに来てハロー軌道の振幅が収まらない(フォボス 1.5・イオ 5.8 が落ちる)。
export const LAGRANGE_MIN_CLEARANCE_RATIO = 10;

// --- 軌道計画モード([M]) ---
export const OVERVIEW_CAMERA_MIN_DIST = 1e3; // 広範囲視点カメラの注視点までの距離 [m]
export const OVERVIEW_CAMERA_FOV_MIN = 15; // 広範囲視点の最小垂直画角 [deg]
export const OVERVIEW_CAMERA_FOV_MAX = 120; // 広範囲視点の最大垂直画角 [deg]
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

// 色管理 (Colors)
// ゲーム世界の識別色(方位マーカー・陣営ごとの軌道線・ステージ演出)のみ。UI の色は theme.ts、
// 「どう見えるか」だけを決めるエフェクトの色は render/vfx-style.ts が持つ。
// 軌道3軸(prograde/normal/radial)だけは theme.ts の AXIS_* を使う。Δv 編集の 3D ギズモと
// 方位マーカーは同じ軸を指すので、同じ軸に二系統の色を持たせない。
export const COLOR_MARKER_NODE = '#8b93a0';
export const COLOR_MARKER_FUEL = '#ffcf70';
export const COLOR_MARKER_ALLY = '#ffffff';
export const COLOR_MARKER_ENEMY = '#ffffff';
export const COLOR_ENEMY_ORBIT_LINE = '#565b63';
export const COLOR_BASE_ORBIT_LINE = '#4f8f7d'; // 拠点(味方施設)の軌道線。落ち着いた緑がかった色で他線と区別
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
