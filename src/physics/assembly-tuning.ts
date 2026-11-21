// 組み立て型の敵の形を決める生成パラメータ(SPEC/ASSEMBLY.md)。値は個体ごとの**ばらつきの範囲**で、
// 個体の形は seed がこの範囲の中から決める。調整は敵の実験環境(tools/enemy-lab)が行い、
// 「既定値へ確定」で ASSEMBLY_TUNING_DEFAULTS の右辺だけを書き換える(tools/enemy-lab-apply-tuning.cjs)。
// 開発ビルドのゲームは、実験環境が書く git 管理外の上書きを applyAssemblyTuningOverrides で重ねて使う。

// 調整値の既定値と並び。**1 行 1 項目で、右辺は数値**(書き換えの窓口がこの形を前提にする)。
export const ASSEMBLY_TUNING_DEFAULTS = {
  // 大きさ — 個体の外接半径 [m]。範囲の中から個体ごとに一様に引く。
  outerRadiusMin: 40,
  outerRadiusMax: 70,
  // 管 — 管半径の範囲。主鎖の歩行 1 ステップの長さ(正規化前)を 1 とした値で、個体は外接半径へ
  // 一様に縮められるので、見た目の太さは形とともに決まる。
  tubeRadiusMin: 0.08,
  tubeRadiusMax: 0.12,
  // 型 — 全体が結び目の個体の出る確率と、枝分かれ型に局所的な結び目部品が付く確率。
  wholeKnotProbability: 0.35,
  localKnotProbability: 0.3,
  // 歩行 — 1 ステップで曲がる角度の上限 [rad]。「緩やかに折れ曲がる」程度を決める。
  walkTurnMax: 0.6,
  // 枝分かれ型の主鎖 — 歩行の節数と、主鎖を分ける部品数。
  spineStepsMin: 5,
  spineStepsMax: 8,
  spinePartsMin: 2,
  spinePartsMax: 4,
  // 枝分かれ型の枝 — 本数の上限(0 本から)、1 本の節数、外側からの振れ幅。
  branchCountMax: 3,
  branchStepsMin: 2,
  branchStepsMax: 4,
  branchSpread: 0.8,
  // 局所結び目の大きさ(正規化前の主鎖に対する倍率)。
  localKnotScale: 1.2,
  // 全体が結び目の個体 — 閉ループを分ける部品数、付属の枝の本数の上限(0 本から)、枝の節数と振れ幅。
  wholeKnotPartsMin: 2,
  wholeKnotPartsMax: 3,
  wholeKnotBranchCountMax: 2,
  wholeKnotBranchStepsMin: 2,
  wholeKnotBranchStepsMax: 3,
  wholeKnotBranchSpread: 0.6,
} as const;

export type AssemblyTuningId = keyof typeof ASSEMBLY_TUNING_DEFAULTS;
export type AssemblyTuning = { readonly [K in AssemblyTuningId]: number };

// 整数でなければならない項目(節数・部品数・本数)。
const INTEGER_IDS: ReadonlySet<AssemblyTuningId> = new Set<AssemblyTuningId>([
  'spineStepsMin', 'spineStepsMax', 'spinePartsMin', 'spinePartsMax', 'branchCountMax',
  'branchStepsMin', 'branchStepsMax', 'wholeKnotPartsMin', 'wholeKnotPartsMax',
  'wholeKnotBranchCountMax', 'wholeKnotBranchStepsMin', 'wholeKnotBranchStepsMax',
]);

// 下限と上限の対。調整の結果、上限が下限を下回らないようにする。
const RANGE_PAIRS: readonly (readonly [min: AssemblyTuningId, max: AssemblyTuningId])[] = [
  ['outerRadiusMin', 'outerRadiusMax'], ['tubeRadiusMin', 'tubeRadiusMax'],
  ['spineStepsMin', 'spineStepsMax'], ['spinePartsMin', 'spinePartsMax'],
  ['branchStepsMin', 'branchStepsMax'], ['wholeKnotPartsMin', 'wholeKnotPartsMax'],
  ['wholeKnotBranchStepsMin', 'wholeKnotBranchStepsMax'],
];

// 部分的な値を既定値へ重ね、整数の項目を丸め、上限が下限を下回る対は上限を下限へ揃える。
// 知らない項目と有限でない値は捨てる — 上書きファイルは外から来る未検証の値なので。
export function resolveAssemblyTuning(values: Readonly<Record<string, unknown>>): AssemblyTuning {
  const merged: Record<string, number> = { ...ASSEMBLY_TUNING_DEFAULTS };
  for (const id of Object.keys(ASSEMBLY_TUNING_DEFAULTS) as AssemblyTuningId[]) {
    const value = values[id];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    merged[id] = INTEGER_IDS.has(id) ? Math.round(value) : value;
  }
  for (const [min, max] of RANGE_PAIRS) merged[max] = Math.max(merged[min]!, merged[max]!);
  return merged as unknown as AssemblyTuning;
}

// いま個体の生成が読む調整値。ゲームでは既定値のまま動き、開発ビルドだけ上書きが重なる。
let activeTuning: AssemblyTuning = resolveAssemblyTuning({});

export function currentAssemblyTuning(): AssemblyTuning {
  return activeTuning;
}

// 開発ビルドの上書き(id → 数値)を、既定値へ重ねてゲームの調整値にする。以降に出る個体にだけ効く。
export function applyAssemblyTuningOverrides(overrides: Readonly<Record<string, unknown>>): void {
  activeTuning = resolveAssemblyTuning(overrides);
}
