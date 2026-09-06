// 位置を持つ任意の要素を一様グリッドへ登録し、ある点を含むセルとその26近傍セル(計27セル)に
// 属する要素と、27近傍の内側にある順不同ペアを列挙する。
import { Vec3 } from './vec3';

// セル添字 (cx, cy, cz) を x → y → z の三段の Map で引く。添字はそのまま鍵なので、
// 座標の大きさによらず別のセルが同じ鍵を共有することはない。
type ZLevel<T> = Map<number, T[]>;
type YLevel<T> = Map<number, ZLevel<T>>;

// 添字が辞書順で正になる13方向。各ペアは、辞書順で小さい側のセルから1回ずつ現れる。
const FORWARD_CELL_OFFSETS: readonly (readonly [number, number, number])[] = [
  [1, -1, -1], [1, -1, 0], [1, -1, 1],
  [1, 0, -1], [1, 0, 0], [1, 0, 1],
  [1, 1, -1], [1, 1, 0], [1, 1, 1],
  [0, 1, -1], [0, 1, 0], [0, 1, 1],
  [0, 0, 1],
];

export class SpatialGrid<T> {
  private readonly cells = new Map<number, YLevel<T>>();
  private invCellSize: number;

  // セルの一辺の長さ cellSize でグリッドを構築する。単位は呼び出し側の座標系に従う。
  public constructor(cellSize: number) {
    this.invCellSize = 1 / cellSize;
  }

  // 同じ所有者が同期的にグリッドを作り直す場合の再初期化。
  public reset(cellSize: number): void {
    this.cells.clear();
    this.invCellSize = 1 / cellSize;
  }

  // 座標 coordinate [呼び出し側の単位] が属するセルの、その軸の添字。
  private cellIndex(coordinate: number): number {
    return Math.floor(coordinate * this.invCellSize);
  }

  // 要素 item を位置 pos の属するセルへ登録する。
  public insert(item: T, pos: Vec3): void {
    const cx = this.cellIndex(pos.x);
    const cy = this.cellIndex(pos.y);
    const cz = this.cellIndex(pos.z);

    // x → y → z と段を降り、まだ無い段はその場で作りながら進む。
    let yLevel = this.cells.get(cx);
    if (yLevel === undefined) {
      yLevel = new Map<number, ZLevel<T>>();
      this.cells.set(cx, yLevel);
    }
    let zLevel = yLevel.get(cy);
    if (zLevel === undefined) {
      zLevel = new Map<number, T[]>();
      yLevel.set(cy, zLevel);
    }
    let bucket = zLevel.get(cz);
    if (bucket === undefined) {
      bucket = [];
      zLevel.set(cz, bucket);
    }
    bucket.push(item);
  }

  // セル添字 (cx, cy, cz) に登録済みの要素。そのセルが空なら undefined。
  private bucketAt(cx: number, cy: number, cz: number): T[] | undefined {
    return this.cells.get(cx)?.get(cy)?.get(cz);
  }

  // 点 pos を含むセルと、その26近傍セルに登録済みの要素を out へ列挙する。
  // out は呼び出し側が所有し、このメソッドは既存内容を破棄してから詰め直す。
  public neighborsInto(pos: Vec3, out: T[]): T[] {
    out.length = 0;
    if (this.cells.size === 0) return out;
    const cx = this.cellIndex(pos.x), cy = this.cellIndex(pos.y), cz = this.cellIndex(pos.z);
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

  // 27近傍の内側にある順不同ペアを、各1回ずつ out へ平らに詰める(out[2k], out[2k+1] が1組)。
  // out は呼び出し側が所有し、既存内容は捨てる。
  public pairsInto(out: T[]): T[] {
    out.length = 0;
    for (const [cx, yLevel] of this.cells) {
      for (const [cy, zLevel] of yLevel) {
        for (const [cz, bucket] of zLevel) {
          // 同じセルの中は、バケット内で後ろにいる要素と組む。
          for (let i = 0; i < bucket.length; i++) {
            for (let j = i + 1; j < bucket.length; j++) out.push(bucket[i]!, bucket[j]!);
          }
          // 隣接セルは、辞書順で正の側の13方向を引く。
          for (const offset of FORWARD_CELL_OFFSETS) {
            const neighbor = this.bucketAt(cx + offset[0], cy + offset[1], cz + offset[2]);
            if (neighbor === undefined) continue;
            for (const a of bucket) {
              for (const b of neighbor) out.push(a, b);
            }
          }
        }
      }
    }
    return out;
  }
}
