// 到達量が桁で異なる要素を、一辺 minCellSize·2^k の段へ振り分けて登録し、中心距離が到達量の和
// 以下になりうる全ペアを列挙する一様グリッドの階層。密集した小さい要素どうしの候補は、
// その要素の到達量だけで決まる。
import { SpatialGrid } from './spatial-grid';
import type { Vec3 } from './vec3';

export class HierarchicalSpatialGrid<T> {
  // 段 level は一辺 minCellSize·2^level。要る段が現れた時点で末尾へ足し、reset を跨いで使い回す。
  private readonly grids: SpatialGrid<T>[] = [];
  // 登録した要素を挿入順に並べ、同じ添字で段と、その段でのセル添字を引く。
  private readonly items: T[] = [];
  private readonly itemLevels: number[] = [];
  private readonly itemCx: number[] = [];
  private readonly itemCy: number[] = [];
  private readonly itemCz: number[] = [];
  // pairsInto が使い回す作業領域。
  private readonly levelPairs: T[] = [];
  private readonly coarseNeighbors: T[] = [];

  // minCellSize は最も細かい段の一辺。単位は呼び出し側の座標系に従う。
  public constructor(private readonly minCellSize: number) {}

  // 段 level の一辺。
  private cellSizeAt(level: number): number {
    return this.minCellSize * 2 ** level;
  }

  // 一辺が 2·reach 以上になる最も細かい段。reach = 0 なら最も細かい段。
  // Math.log2 で求めると、一辺がちょうど 2·reach の段が丸めで1段細かい側へ落ち、
  // 隣の段へ登録された相手を取りこぼす。
  private levelFor(reach: number): number {
    let level = 0;
    while (this.cellSizeAt(level) < 2 * reach) level++;
    return level;
  }

  // 段 level のグリッド。まだ無い段は、そこまでまとめて作る。
  private gridAt(level: number): SpatialGrid<T> {
    while (this.grids.length <= level) {
      this.grids.push(new SpatialGrid<T>(this.cellSizeAt(this.grids.length)));
    }
    return this.grids[level]!;
  }

  // 全段を空にする。段の器は使い回す。
  public reset(): void {
    for (let level = 0; level < this.grids.length; level++) this.grids[level]!.reset(this.cellSizeAt(level));
    this.items.length = 0;
    this.itemLevels.length = 0;
    this.itemCx.length = 0;
    this.itemCy.length = 0;
    this.itemCz.length = 0;
  }

  // 要素 item を、一辺が 2·reach 以上になる最も細かい段の、pos の属するセルへ登録する。
  // reach は有限で 0 以上でなければならない。
  public insert(item: T, pos: Vec3, reach: number): void {
    const level = this.levelFor(reach);
    const grid = this.gridAt(level);
    grid.insert(item, pos);
    this.items.push(item);
    this.itemLevels.push(level);
    this.itemCx.push(grid.cellIndex(pos.x));
    this.itemCy.push(grid.cellIndex(pos.y));
    this.itemCz.push(grid.cellIndex(pos.z));
  }

  // 中心距離が到達量の和以下になりうる順不同ペアを、各1回ずつ out へ平らに詰める
  // (out[2k], out[2k+1] が1組)。out は呼び出し側が所有し、既存内容は捨てる。
  public pairsInto(out: T[]): T[] {
    out.length = 0;
    // 同じ段どうしのペア。
    for (const grid of this.grids) {
      for (const item of grid.pairsInto(this.levelPairs)) out.push(item);
    }
    // 段をまたぐペアは、細かい側の要素が自分より粗い全ての段の27近傍を引いて集める。
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      const level = this.itemLevels[i]!;
      for (let coarse = level + 1; coarse < this.grids.length; coarse++) {
        const span = 2 ** (coarse - level);
        this.coarseNeighbors.length = 0;
        this.grids[coarse]!.appendCellNeighborsInto(
          Math.floor(this.itemCx[i]! / span),
          Math.floor(this.itemCy[i]! / span),
          Math.floor(this.itemCz[i]! / span),
          this.coarseNeighbors,
        );
        for (const neighbor of this.coarseNeighbors) out.push(item, neighbor);
      }
    }
    return out;
  }
}
