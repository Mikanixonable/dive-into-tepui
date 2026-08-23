// 3D の絵に出るエフェクト(フラッシュ・破片・プルーム)の色と寸法。「どう見えるか」だけを
// 決める値で、ゲームのバランス値でも UI のトークンでもない。
//
// ここの明るさは物理量ではなく手書きの表示値のまま。放射量として組み直すのはボリューム
// レンダリングの段階で、それまでは 1 天文単位を基準にした表示値の目盛りで置く。

// --- 被弾・撃破フラッシュ(サイズは [m]、DURATION は [s]) ---
export const BULLET_IMPACT_FLASH_COLOR = '#ffe2a0';
export const BULLET_IMPACT_FLASH_SIZE0 = 1.5;
export const BULLET_IMPACT_FLASH_SIZE1 = 6;
export const BULLET_IMPACT_FLASH_DURATION = 0.25;
export const MUZZLE_FLASH_COLOR = '#fff0b8';
export const MUZZLE_FLASH_SIZE0 = 2.2;
export const MUZZLE_FLASH_SIZE1 = 6;
export const MUZZLE_FLASH_DURATION = 0.07;
export const PLASMA_IMPACT_FLASH_COLOR = '#ffa0ff';
export const PLASMA_IMPACT_FLASH_SIZE0 = 2;
export const PLASMA_IMPACT_FLASH_SIZE1 = 8;
export const PLASMA_IMPACT_FLASH_DURATION = 0.3;
// 被弾・デブリ命中時のガス放出。灰色の低透明度のビルボードを2枚重ねて気体らしさを出す。
export const GAS_PUFF_COLOR_1 = '#aaaaaa';
export const GAS_PUFF_COLOR_2 = '#ffffff';
// 撃破フラッシュ。芯(1)と外殻(2)の2枚。サイズは敵機の ENEMY_SCALE 倍される。
export const DESTROY_FLASH_COLOR_1 = '#ffb36b';
export const DESTROY_FLASH1_SIZE0 = 10;
export const DESTROY_FLASH1_SIZE1 = 110;
export const DESTROY_FLASH1_DURATION = 1.1;
export const DESTROY_FLASH_COLOR_2 = '#fffbe8';
export const DESTROY_FLASH2_SIZE0 = 6;
export const DESTROY_FLASH2_SIZE1 = 40;
export const DESTROY_FLASH2_DURATION = 0.5;

// --- 破片 ---
export const DESTROY_FRAG_SIZE_MIN = 1.5; // 撃破デブリの破片サイズ下限。ENEMY_SCALE 倍される
export const DESTROY_FRAG_SIZE_MAX = 6.0;
export const PLAYER_DESTROY_FRAG_COLOR = '#9fd8e8';
export const ENEMY_DESTROY_FRAG_COLOR = '#ff6a4a';
// 破片のうち、外殻の塗装ではなく機体内部の暗色部が割れたぶんの色。
export const SHIP_DARK_HULL_COLOR = '#2e3340';

// --- 噴射プルーム(メインエンジン) ---
export const THRUST_PLUME_CORE_COLOR = 0xaee6ff;
export const THRUST_PLUME_OUTER_COLOR = 0x4f9fff;
// 出力比 0..1 に対するプルームの基準サイズ [m]。
export const THRUST_PLUME_SIZE_MIN = 1.5;
export const THRUST_PLUME_SIZE_SPAN = 2.5;
// 基準サイズに対するコア・アウターの倍率と、機体からノズル方向へのずらし量 [m]。
export const THRUST_PLUME_CORE_SIZE_RATIO = 1.6;
export const THRUST_PLUME_OUTER_SIZE_RATIO = 3.6;
export const THRUST_PLUME_CORE_OFFSET = -3.4;
export const THRUST_PLUME_OUTER_OFFSET = -5.6;
export const THRUST_PLUME_CORE_BRIGHTNESS = 0.85;
export const THRUST_PLUME_OUTER_BRIGHTNESS = 0.32;

// --- RCS パフ ---
export const RCS_PLUME_COLOR = 0xcfeaff;
export const RCS_PLUME_OFFSET = 0.55; // ノズルからプルーム中心までの距離 [m]
export const RCS_PLUME_SIZE = 0.55;
export const RCS_PLUME_BRIGHTNESS = 0.75;

// --- 再突入の輝き ---
export const REENTRY_CORE_COLOR = 0xfff2d9;
export const REENTRY_OUTER_COLOR = 0xff7a1f;
// 強度 0..1 に対する基準サイズ [m] と、コア・アウターの倍率・機首前方へのずらし量 [m]。
export const REENTRY_SIZE_MIN = 1.5;
export const REENTRY_SIZE_SPAN = 3.5;
export const REENTRY_CORE_SIZE_RATIO = 1.4;
export const REENTRY_OUTER_SIZE_RATIO = 3.2;
export const REENTRY_CORE_OFFSET = 3.0;
export const REENTRY_OUTER_OFFSET = 5.5;
export const REENTRY_CORE_BRIGHTNESS = 0.75;
export const REENTRY_OUTER_BRIGHTNESS = 0.35;

// --- 弾 ---
export const ENEMY_PLASMA_COLOR = '#ff3333'; // 蛍光色の赤
