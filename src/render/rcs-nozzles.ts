// 自機の姿勢制御 RCS ノズルの、機体座標での取付位置と噴射方向。造形・噴射パフの唯一の定義。
// 他モジュールを import してはならない — tools/export-models.mjs がこのファイルを
// TypeScript のまま transpile して読み込む。

export interface RcsNozzle {
  readonly pos: { readonly x: number; readonly y: number; readonly z: number }; // 取付位置 [m]
  readonly dir: { readonly x: number; readonly y: number; readonly z: number }; // 噴射方向(単位ベクトル)
}

// 機首側4隅のブロックに2基ずつ。噴射方向はいずれも機体の法線に従う。
export const RCS_NOZZLES: readonly RcsNozzle[] = [
  { pos: { x: 1.0, y: 0.85, z: 1.9 }, dir: { x: 1, y: 0, z: -0 } },
  { pos: { x: 1.0, y: 0.85, z: 1.9 }, dir: { x: 0, y: 1, z: -0 } },
  { pos: { x: -1.0, y: 0.85, z: 1.9 }, dir: { x: -1, y: 0, z: -0 } },
  { pos: { x: -1.0, y: 0.85, z: 1.9 }, dir: { x: 0, y: 1, z: -0 } },
  { pos: { x: 1.0, y: -0.85, z: 1.9 }, dir: { x: 1, y: 0, z: -0 } },
  { pos: { x: 1.0, y: -0.85, z: 1.9 }, dir: { x: 0, y: -1, z: -0 } },
  { pos: { x: -1.0, y: -0.85, z: 1.9 }, dir: { x: -1, y: 0, z: -0 } },
  { pos: { x: -1.0, y: -0.85, z: 1.9 }, dir: { x: 0, y: -1, z: -0 } },
];
