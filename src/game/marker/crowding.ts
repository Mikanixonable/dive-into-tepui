// 画面上で近接する2つの対象(マーカー/天体ラベル)のうち、どちらを間引く(隠す)かを決める
// 共通ロジック。判定順は「カメラからの距離比(depth-guard)→優先度→(必要なら)深さ・id の
// 決定論的タイブレーク」。手前にある対象が、奥にあるだけの高優先度対象に隠され続けることを
// 防ぐのが depth-guard の役目 — DEVELOP/SPEC/MAP.md 7.2 節が定める挙動。
// marker-manager.ts・camera/focus-markers.ts・marker/grouped-markers.ts の3箇所から使う。
// 呼び出し頻度が高い(近接判定のペアごとに呼ばれる)ため、引数はオブジェクトではなくスカラーで渡す。

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
