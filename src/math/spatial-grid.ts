// 位置を持つ任意の要素を一様グリッドへ登録し、ある点を含むセルとその26近傍セル(計27セル)に
// 属する要素を列挙する。
import { Vec3 } from './vec3';

// セル添字 (cx, cy, cz) を x → y → z の三段の Map で引く。添字はそのまま鍵なので、
// 座標の大きさによらず別のセルが同じ鍵を共有することはない。
type ZLevel<T> = Map<number, T[]>;
type YLevel<T> = Map<number, ZLevel<T>>;

export class SpatialGrid<T> {
  private readonly cells = new Map<number, YLevel<T>>();
  private invCellSize: number;
  private readonly bucketPool: T[][] = [];
  private readonly mapPool: Map<number, unknown>[] = [];

  // セルの一辺の長さ cellSize でグリッドを構築する。単位は呼び出し側の座標系に従う。
  constructor(cellSize: number) {
    this.invCellSize = 1 / cellSize;
  }

  // 同じ所有者が同期的にグリッドを作り直す場合の再初期化。セルの挿入順と近傍走査順は
  // 新規生成時と同じで、セル配列と中間 Map だけを再利用して一時オブジェクトを抑える。
  reset(cellSize: number): void {
    for (const yLevel of this.cells.values()) {
      for (const zLevel of yLevel.values()) {
        for (const bucket of zLevel.values()) {
          bucket.length = 0;
          this.bucketPool.push(bucket);
        }
        zLevel.clear();
        this.mapPool.push(zLevel);
      }
      yLevel.clear();
      this.mapPool.push(yLevel);
    }
    this.cells.clear();
    this.invCellSize = 1 / cellSize;
  }

  // 空の Map を1つ得る。
  private takeMap<V>(): Map<number, V> {
    return (this.mapPool.pop() as Map<number, V> | undefined) ?? new Map<number, V>();
  }

  // 要素 item を位置 pos の属するセルへ登録する。
  insert(item: T, pos: Vec3): void {
    const cx = Math.floor(pos.x * this.invCellSize);
    const cy = Math.floor(pos.y * this.invCellSize);
    const cz = Math.floor(pos.z * this.invCellSize);

    let yLevel = this.cells.get(cx);
    if (yLevel === undefined) {
      yLevel = this.takeMap<ZLevel<T>>();
      this.cells.set(cx, yLevel);
    }
    let zLevel = yLevel.get(cy);
    if (zLevel === undefined) {
      zLevel = this.takeMap<T[]>();
      yLevel.set(cy, zLevel);
    }
    let bucket = zLevel.get(cz);
    if (bucket === undefined) {
      bucket = this.bucketPool.pop() ?? [];
      zLevel.set(cz, bucket);
    }
    bucket.push(item);
  }

  // 点 pos を含むセルと、その26近傍セルに登録済みの要素を列挙する。
  neighbors(pos: Vec3): T[] {
    return this.neighborsInto(pos, []);
  }

  // 点 pos を含むセルと、その26近傍セルに登録済みの要素を out へ列挙する。
  // out は呼び出し側が所有し、このメソッドは既存内容を破棄してから詰め直す。
  neighborsInto(pos: Vec3, out: T[]): T[] {
    out.length = 0;
    return this.appendNeighborsInto(pos, out);
  }

  // neighborsInto と同じ近傍を out の末尾へ追加する。out はクリアしない。
  appendNeighborsInto(pos: Vec3, out: T[]): T[] {
    if (this.cells.size === 0) return out;
    const cx = Math.floor(pos.x * this.invCellSize);
    const cy = Math.floor(pos.y * this.invCellSize);
    const cz = Math.floor(pos.z * this.invCellSize);
    for (let dx = -1; dx <= 1; dx++) {
      const yLevel = this.cells.get(cx + dx);
      if (yLevel === undefined) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const zLevel = yLevel.get(cy + dy);
        if (zLevel === undefined) continue;
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = zLevel.get(cz + dz);
          if (bucket !== undefined) {
            for (const item of bucket) out.push(item);
          }
        }
      }
    }
    return out;
  }
}
