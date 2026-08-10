// 放熱板蛇腹のヒンジ機体座標系位置(up 側の値。down 側は X 符号を反転する)。
// 他モジュールを import してはならない — tools/export-models.mjs がこのファイルを
// TypeScript のまま transpile して読み込む。
export const RADIATOR_HINGE = { x: 1.17, y: -0.20, z: -1.80 } as const;
