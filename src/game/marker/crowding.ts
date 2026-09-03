// 画面上で近接する2つの対象(マーカー/天体ラベル)のうち、どちらを間引く(隠す)かを決める
// 共通ロジック。判定順は「カメラからの距離比(depth-guard)→優先度→(必要なら)深さ・id の
// 決定論的タイブレーク」。手前にある対象が、奥にあるだけの高優先度対象に隠され続けることを
// 防ぐのが depth-guard の役目 — DEVELOP/SPEC/MAP.md 7.2 節が定める挙動。
// 近接判定そのもの(CrowdingGrid)と、隠す側を選ぶ規則(resolveCrowdingWinner)の両方を持つ。
// 呼び出し頻度が高い(近接判定のペアごとに呼ばれる)ため、引数はオブジェクトではなくスカラーで渡す。

// マーカーラベル優先度 (数値が大きいものが優先。天体 > 船・エンティティ)
export const MARKER_PRIORITY = {
  STAR_PLANET: 5000,
  DWARF_PLANET: 4000,
  SATELLITE_SMALL_BODY: 3000,
  LAGRANGE: 2000,
  PRIMARY_TARGET: 900,
  IMPACT: 850,
  BASE: 700,
  PLAYER: 600,
  ENEMY: 500,
  AMMO: 300,
  MANEUVER_NODE: 150,
  ORBITAL_NODE: 100,
  PROTEIN_SITE: 50,
} as const;

// 画面上で近接する2対象のカメラからの距離比がこれ以上なら、優先度に関わらず遠い側を隠す
// (奥にあるだけの対象が手前の対象を消してしまう逆転を防ぐ)。
export const DEPTH_GUARD_RATIO = 3;
// 一度隠した対象を再び出す距離比のしきい値(ENTER より緩い値)。同じ値だと
// しきい値ちょうどで距離比が揺れたときに毎フレーム表示・非表示が反転する
// (周期が数時間の衛星どうしなど、タイムワープ中に距離比が急変する組で顕著)。
export const DEPTH_GUARD_EXIT_RATIO = 2;

// a・b のうち隠す側を 'a' | 'b' で返す。優先度が等しく tieBreakOnEqualPriority が false の
// ときは、どちらも隠さない(undefined)— 呼び出し元が別の手段(ラベル位置の反発など)で
// 共存させる前提の組。depth は優先度が等しいときの決定論的タイブレークにのみ使う値で、
// 持たない呼び出し元は省略してよい(既定 0 同士は id によるタイブレークへ落ちる)。
export function resolveCrowdingWinner(
  aId: string, aPriority: number, aDist: number | undefined, aWasHidden: boolean,
  bId: string, bPriority: number, bDist: number | undefined, bWasHidden: boolean,
  depthGuardRatio: number, depthGuardExitRatio: number,
  tieBreakOnEqualPriority: boolean,
  aDepth = 0, bDepth = 0,
): 'a' | 'b' | undefined {
  if (aDist !== undefined && bDist !== undefined) {
    const aRatio = aWasHidden ? depthGuardExitRatio : depthGuardRatio;
    const bRatio = bWasHidden ? depthGuardExitRatio : depthGuardRatio;
    if (aDist > bDist * aRatio) return 'a';
    if (bDist > aDist * bRatio) return 'b';
  }
  if (aPriority > bPriority) return 'b';
  if (bPriority > aPriority) return 'a';
  if (!tieBreakOnEqualPriority) return undefined;
  if (aDepth > bDepth) return 'a';
  if (bDepth > aDepth) return 'b';
  return aId > bId ? 'a' : 'b';
}

// 間引きの判定に要る、投影済みのラベル1件。
export interface ProjectedLabel {
  readonly id: string;
  readonly priority: number;
  // 主星を 0 とする階層の深さ。優先度が等しいときのタイブレークに使う。
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly dist: number;
}

// 画面上で近接する2つの投影済みラベルのうち、優先度または奥行きガードで隠す側を選ぶ一様グリッド。
// 混雑半径と距離比ヒステリシスの状態を持つので、間引きの種類ごとに1インスタンスを立てる。
export class CrowdingGrid {
  private readonly cellsScratch = new Map<number, Map<number, ProjectedLabel[]>>();
  private readonly cellPool: ProjectedLabel[][] = [];
  private readonly cellRowPool: Map<number, ProjectedLabel[]>[] = [];
  private readonly hiddenScratchA = new Set<string>();
  private readonly hiddenScratchB = new Set<string>();
  private hiddenLastFrame: ReadonlySet<string> = new Set();

  constructor(
    private readonly cellSizePx: number,
    private readonly depthGuardRatio: number,
    private readonly depthGuardExitRatio: number,
  ) {}

  // items 内で cellSizePx 未満に近接するペアごとに、距離比(depth-guard)→優先度→深さ→id の順で
  // 隠す側を決め、隠す id の集合を返す。返した集合は次回呼び出しまで有効(内部でダブルバッファ)。
  compute(items: readonly ProjectedLabel[]): ReadonlySet<string> {
    const hidden = this.hiddenLastFrame === this.hiddenScratchA ? this.hiddenScratchB : this.hiddenScratchA;
    hidden.clear();
    for (const row of this.cellsScratch.values()) {
      for (const cell of row.values()) {
        cell.length = 0;
        this.cellPool.push(cell);
      }
      row.clear();
      this.cellRowPool.push(row);
    }
    this.cellsScratch.clear();
    const cells = this.cellsScratch;
    // 一様グリッドで近傍セルだけを比較する。ラベル数が増えても O(N²) で全画面を走査しない。
    for (const current of items) {
      const cx = Math.floor(current.x / this.cellSizePx);
      const cy = Math.floor(current.y / this.cellSizePx);
      for (let x = cx - 1; x <= cx + 1; x++) {
        const row = cells.get(x);
        if (row === undefined) continue;
        for (let y = cy - 1; y <= cy + 1; y++) {
          const cell = row.get(y);
          if (cell === undefined) continue;
          for (const other of cell) {
            if (Math.hypot(current.x - other.x, current.y - other.y) >= this.cellSizePx) continue;
            const winner = resolveCrowdingWinner(
              current.id, current.priority, current.dist, this.hiddenLastFrame.has(current.id),
              other.id, other.priority, other.dist, this.hiddenLastFrame.has(other.id),
              this.depthGuardRatio, this.depthGuardExitRatio, true,
              current.depth, other.depth,
            );
            if (winner === 'a') hidden.add(current.id);
            else if (winner === 'b') hidden.add(other.id);
          }
        }
      }
      let row = cells.get(cx);
      if (row === undefined) {
        row = this.cellRowPool.pop() ?? new Map<number, ProjectedLabel[]>();
        cells.set(cx, row);
      }
      const cell = row.get(cy);
      if (cell) cell.push(current);
      else {
        const nextCell = this.cellPool.pop() ?? [];
        nextCell.push(current);
        row.set(cy, nextCell);
      }
    }
    this.hiddenLastFrame = hidden;
    return hidden;
  }
}
