// 自機の物理判定・部品配置・描画が共有する機体座標系の寸法。
// 他モジュールを import してはならない — tools/model-builder/ がこのファイルを
// TypeScript のまま transpile して読み込む。

// 機関砲の銃口位置。発射、発光、薬莢排出はこの2点を交互に使う。
export const PLAYER_MUZZLE_OFFSETS: readonly { x: number; y: number; z: number }[] = [
  { x: 0, y: 0.55, z: 2.55 },
  { x: 0, y: -0.55, z: 2.55 },
];

// 蛇腹1折りの一辺 [m]。
export const RADIATOR_SEGMENT_LENGTH = (2.3 * 4) / 6;

// 全開時に各折りが展開軸から残す傾き [rad]。
export const RADIATOR_DEPLOY_TILT = 15 * Math.PI / 180;

// 上側放熱板のヒンジ位置。下側は X の符号を反転する。
export const RADIATOR_HINGE = { x: 1.17, y: -0.20, z: -1.80 } as const;

// マガジン1本の厚み [m]。積み上げ間隔とベルト方向の寸法がこれで決まる。
export const MAG_THICKNESS = 1.0;

// マガジンのベルト方向寸法と継手間隔 [m]。
export const MAG_WIDTH = MAG_THICKNESS * 4 * (2 / 3);
export const MAG_BELT_PITCH = MAG_WIDTH + 0.18;

// ベルトが機体へ入る給弾口の機体座標系 X 位置 [m]。
export const MAG_BELT_ANCHOR_X = -1.19;
