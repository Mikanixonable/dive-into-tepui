// 位置を持つ任意の要素を一様グリッドへ登録し、ある点を含むセルとその26近傍セル(計27セル)に
// 属する要素を列挙する。
import { Vec3 } from './vec3';

export class SpatialGrid<T> {
  private readonly cells = new Map<string, T[]>();
  private readonly invCellSize: number;

  // セルの一辺の長さ cellSize でグリッドを構築する。単位は呼び出し側の座標系に従う。
  constructor(cellSize: number) {
    this.invCellSize = 1 / cellSize;
  }

  private cellKey(cx: number, cy: number, cz: number): string {
    return `${cx},${cy},${cz}`;
  }

  private cellOf(pos: Vec3): readonly [number, number, number] {
    return [
      Math.floor(pos.x * this.invCellSize),
      Math.floor(pos.y * this.invCellSize),
      Math.floor(pos.z * this.invCellSize),
    ];
  }

  // 要素 item を位置 pos の属するセルへ登録する。
  insert(item: T, pos: Vec3): void {
    const [cx, cy, cz] = this.cellOf(pos);
    const key = this.cellKey(cx, cy, cz);
    let bucket = this.cells.get(key);
    if (bucket === undefined) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push(item);
  }

  // 点 pos を含むセルと、その26近傍セルに登録済みの要素を列挙する。
  neighbors(pos: Vec3): T[] {
    if (this.cells.size === 0) return [];
    const [cx, cy, cz] = this.cellOf(pos);
    const result: T[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.cells.get(this.cellKey(cx + dx, cy + dy, cz + dz));
          if (bucket !== undefined) result.push(...bucket);
        }
      }
    }
    return result;
  }
}
