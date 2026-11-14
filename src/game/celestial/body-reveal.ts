// 天体の解放(SPEC/GAME.md「天体の解放」)。太陽・地球・月は常に解放されていて、それ以外の天体は
// ステージのクリアで解放される。解放された天体だけがマップの一覧・記号・ラベル・軌道線・選択に現れる。
// 天体の登録そのものは変えない — 解放は表示と選択の規則であり、重力源は登録どおり働く。

// 解放の記録が無いとき(新しいセーブ枠・古い記録)から始まる、解放された天体の id。
export const BODY_REVEAL_BASE: readonly string[] = ['sun', 'earth', 'moon'];

// ステージのクリアで解放する天体の対応(SPEC/GAME.md「天体の解放」)。解放されるのは惑星
// 本体だけで、その衛星は含まない。
const BODIES_REVEALED_BY_CLEAR: Readonly<Record<string, readonly string[]>> = {
  '0': ['mars'],
  '1': ['venus', 'mercury'],
  '2': ['jupiter'],
};

// revealed の天体に、stageId をクリアしたときに解放される天体を加えた集合。重複は除く。
export function revealedAfterClear(revealed: readonly string[], stageId: string): readonly string[] {
  const added = BODIES_REVEALED_BY_CLEAR[stageId] ?? [];
  return [...new Set([...revealed, ...added])];
}
