// 自機の物理判定・部品配置・描画で共有する機体座標系の寸法。モデル生成でも同じ値を使う。

// 放熱板の蛇腹の折り数(1モジュールあたり)。
export const RADIATOR_FOLD_COUNT = 6;

// 太陽電池の剛体パネル数と根元ヒンジに並ぶ列数(1モジュールあたり)。
export const SOLAR_PANEL_COUNT = 8;
export const SOLAR_PANEL_COLUMNS = 2;

// 太陽電池1パネルの展開方向のヒンジピッチ(モジュール局所 Z)と、列全体の幅(局所 X) [m]。
// 2列それぞれが4枚を連ねる。パネルの面寸法に合わせてヒンジピッチも広げ、翼全体を 7.2 m × 4.5 m にする。
export const SOLAR_PANEL_LENGTH = 1.8;
export const SOLAR_PANEL_SPAN = 4.5;

// 太陽電池1パネルの厚み [m]。
export const SOLAR_PANEL_THICKNESS = 0.06;

// 太陽電池1モジュールの1 AU・正面入射・完全展開時の基準発電量 [W]。セクション数に依らない定格。
export const SOLAR_MODULE_GENERATION = 8250;

// 放熱板の蛇腹1折りの展開方向長さ [m]。
export const RADIATOR_SEGMENT_LENGTH = 0.8 * Math.sqrt(10); // ≈ 2.530 m

// 放熱板1折りの横幅 [m]。放熱の有効面積は片面相当として一度だけ数える。
export const RADIATOR_PANEL_WIDTH = 1.0 * Math.sqrt(10); // ≈ 3.162 m
// 放熱板1折りの厚み [m]。
export const RADIATOR_PANEL_THICKNESS = 0.08;
export const RADIATOR_MODULE_AREA = RADIATOR_FOLD_COUNT * RADIATOR_SEGMENT_LENGTH * RADIATOR_PANEL_WIDTH;

// 全開時に各折りが展開軸から残す傾き [rad]。
export const RADIATOR_DEPLOY_TILT = 15 * Math.PI / 180;

// マガジン1本の厚み [m]。積み上げ間隔とベルト方向の寸法がこれで決まる。
export const MAG_THICKNESS = 1.0;

// マガジンの平面寸法倍率。高さ方向(MAG_THICKNESS)は据え置く。
export const MAG_PLANAR_SCALE = 1.4;

// マガジンのベルト方向寸法・横幅と、端面の間に残す継手すき間 [m]。
export const MAG_WIDTH = MAG_THICKNESS * 4 * (2 / 3) * MAG_PLANAR_SCALE;
export const MAG_DEPTH = MAG_THICKNESS * 3 * (2 / 3) * MAG_PLANAR_SCALE;
export const MAG_JOINT_GAP = 0.36;
export const MAG_BELT_PITCH = MAG_WIDTH + MAG_JOINT_GAP;

// ベルトが機体へ入る給弾口の機体座標系 X 位置 [m]。
export const MAG_BELT_ANCHOR_X = -1.19;
