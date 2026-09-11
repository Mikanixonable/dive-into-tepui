// ブースター段の剛体形状を、機体の長手方向をローカル Z 軸として定義する。
// 他モジュールを import してはならない — tools/model-builder/ がこのファイルを
// TypeScript のまま transpile して読み込む。
export const BOOSTER_MOUNT_Z = -4.0; // 船体中心から最初の段の前端まで [m]

// 段1本の寸法 [m]。Z は段前端(前側継手の位置)を原点とする段ローカル座標。
export const BOOSTER_STAGE_DIMENSIONS = Object.freeze({
  frontZ: 0.08,
  aftZ: -7.92,
  length: 8,
  tankLength: 5.38,
  tankRadius: 1.26,
  frontCouplerZ: 0,
  aftDecouplerZ: -5.86,
  nozzleExitZ: -7.78,
});

export const BOOSTER_INTERSTAGE_COVER_SEGMENTS = 6;
export const BOOSTER_INTERSTAGE_COVER_Z = -7.02; // 段前端からの Z 位置 [m]
export const BOOSTER_INTERSTAGE_COVER_RADIUS = 1.43; // 機軸からの距離 [m]
export const BOOSTER_INTERSTAGE_BOLT_Z = -7.78; // 段前端からの Z 位置 [m]
