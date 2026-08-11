// 位置を持つ任意の要素を一様グリッドへ登録し、ある点を含むセルとその26近傍セル(計27セル)に
// 属する要素を列挙する。
import { Vec3 } from './vec3';

export class SpatialGrid<T> {
  private readonly cells = new Map<string, T[]>();
  private invCellSize: number;
  private readonly bucketPool: T[][] = [];

  // セルの一辺の長さ cellSize でグリッドを構築する。単位は呼び出し側の座標系に従う。
  constructor(cellSize: number) {
    this.invCellSize = 1 / cellSize;
  }

  // 同じ所有者が同期的にグリッドを作り直す場合の再初期化。セルの挿入順と近傍走査順は
  // 新規生成時と同じで、セル配列だけを再利用して一時オブジェクトを抑える。
  reset(cellSize: number): void {
    for (const bucket of this.cells.values()) {
      bucket.length = 0;
      this.bucketPool.push(bucket);
    }
    this.cells.clear();
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
      bucket = this.bucketPool.pop() ?? [];
      this.cells.set(key, bucket);
    }
    bucket.push(item);
  }

  // 点 pos を含むセルと、その26近傍セルに登録済みの要素を列挙する。
  neighbors(pos: Vec3): T[] {
    return this.neighborsInto(pos, []);
  }

  // 点 pos を含むセルと、その26近傍セルに登録済みの要素を out へ列挙する。
  // out は呼び出し側が所有し、このメソッドは既存内容を破棄してから詰め直す。
  // neighbors() は互換性のため新しい配列を返す薄いラッパーとして残す。
  neighborsInto(pos: Vec3, out: T[]): T[] {
    out.length = 0;
    if (this.cells.size === 0) return out;
    return this.appendNeighborsInto(pos, out);
  }

  // neighborsInto と同じ近傍を out の末尾へ追加する。既に集めた常時重力源へ
  // グリッド由来の重力源を合流する用途で使う。out はクリアしない。
  appendNeighborsInto(pos: Vec3, out: T[]): T[] {
    if (this.cells.size === 0) return out;
    const [cx, cy, cz] = this.cellOf(pos);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.cells.get(this.cellKey(cx + dx, cy + dy, cz + dz));
          if (bucket !== undefined) {
            for (const item of bucket) out.push(item);
          }
        }
      }
    }
    return out;
  }
}
