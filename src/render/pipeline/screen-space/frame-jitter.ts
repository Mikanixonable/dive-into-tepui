// 近傍拡散補正の走査の入力のうち、時間方向に平均するためにフレームごとに動かすもの — 走査の全体の回転とブルーノイズの
// ずれ(seed)と走査の代表の選び方 — の語彙と、フレーム番号からその位相を答える列。

// フレームごとに動かせる走査の入力。seed は走査の全体の回転とブルーノイズのずれ、scanRepresentative は走査の代表の選び方。
export type JitterSource = 'seed' | 'scanRepresentative';

// 走査の代表の選び方。grid は全ての走査の画素の代表を、受け持つブロックの中の同じ位置 fraction(走査の画素の幅に対する
// 割合。0 以上 1 未満)に置く。perPixel は走査の画素ごとに、番号 draw から引いた乱数の位置に置く。
export type ScanJitter =
  | { readonly kind: 'grid'; readonly fraction: readonly [number, number] }
  | { readonly kind: 'perPixel'; readonly draw: number };

// 1 フレームの走査の入力。seed はブルーノイズのずれ [タイルの幅]、scanRotation は走査の全体の回転 [スライスの間隔]
// (0 以上 1 未満)、scanJitter は走査の代表の選び方(null はブロックの中心)。
export interface FrameJitter {
  readonly seed: readonly [number, number];
  readonly scanRotation: number;
  readonly scanJitter: ScanJitter | null;
}

// seed の列の生成元 — R2 列(塑性数 g の逆冪 (1/g, 1/g²))。どこで打ち切ってもタイルの上に一様に散る。
const PLASTIC = 1.3247179572447461;
const SEED_ALPHA = [1 / PLASTIC, 1 / PLASTIC ** 2] as const;

// 走査の全体の回転の列の生成元 — 黄金比の逆数。R2 列の x 成分(1/g ≈ 0.755)で回すと 3/4 に近いので、整列した 2×2 の
// 走査の画素が持つ ¼ ずつの回転を並べ替えるだけになり、数十フレームのあいだ新しい回転を足さない。
const ROTATION_ALPHA = (Math.sqrt(5) - 1) / 2;

// 2×2 の Bayer 行列 [[0, 2], [3, 1]] の、番号ごとの升の座標 (x, y)。
const BAYER_2_CELLS = [[0, 0], [1, 1], [1, 0], [0, 1]] as const;

// フレーム frame(0 以上の整数)で動かす走査の入力。sources に含む入力をその番号の位相に置き、含まない入力は本番の静止画の値
// (seed (0, 0)・回転 0・代表はブロックの中心)にする。cellSize は走査の画素の幅 [描画バッファの画素](2 の冪)で、代表は cellSize²
// 通りの位置を Bayer 順に巡る。フレーム 0 は、どの入力を動かしても本番の静止画と一致する。
export function frameJitterAt(frame: number, sources: readonly JitterSource[], cellSize: number): FrameJitter {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new RangeError(`frame jitter: frame ${frame} is not a non-negative integer`);
  }
  if (!Number.isInteger(cellSize) || cellSize < 1 || (cellSize & (cellSize - 1)) !== 0) {
    throw new RangeError(`frame jitter: the scan cell size ${cellSize} is not a power of two`);
  }
  // 源 seed は、ブルーノイズのずれと走査の全体の回転をそろって動かす。
  const moveSeed = sources.includes('seed');
  const seed = moveSeed ? SEED_ALPHA.map((alpha) => fract(frame * alpha)) as [number, number] : [0, 0] as const;
  const scanRotation = moveSeed ? fract(frame * ROTATION_ALPHA) : 0;
  // 代表の巡りは cellSize² フレームで一巡し、同じ順を繰り返す。
  const scanJitter: ScanJitter | null = sources.includes('scanRepresentative')
    ? { kind: 'grid', fraction: gridFractionAt(frame % (cellSize * cellSize), cellSize) }
    : null;
  return { seed, scanRotation, scanJitter };
}

// フレーム frame に置く走査の入力。源 sources が null なら置かない(null)、履歴の上限 historyCap(1 以上の整数)が 1 なら本番の
// 静止画の値、それ以外は sources をその番号の位相で動かした値。
export function frameJitterForHistoryCap(
  frame: number, sources: readonly JitterSource[] | null, historyCap: number, cellSize: number,
): FrameJitter | null {
  if (sources === null) return null;
  if (!Number.isInteger(historyCap) || historyCap < 1) {
    throw new RangeError(`frame jitter: invalid history cap ${historyCap}`);
  }
  return frameJitterAt(frame, historyCap > 1 ? sources : [], cellSize);
}

// 一辺 cellSize のブロックの中の位置を散らばる順に巡ったときの、index 番目の位置(ブロックの幅に対する割合)。index 0 は
// ブロックの中心で、cellSize² フレームでブロックの全ての画素を 1 度ずつ巡る。
function gridFractionAt(index: number, cellSize: number): readonly [number, number] {
  const center = Math.floor(cellSize / 2);
  const [x, y] = bayerCellAt(index, cellSize);
  // Bayer 順の先頭は角なので、中心との排他的論理和で先頭を中心へ写す(散らばりは保たれる)。
  return [0.5 + ((x ^ center) - center) / cellSize, 0.5 + ((y ^ center) - center) / cellSize];
}

// 一辺 size(2 の冪)の Bayer 行列で番号 index を持つ升の座標。
function bayerCellAt(index: number, size: number): readonly [number, number] {
  let x = 0;
  let y = 0;
  for (let half = size / 2, rest = index; half >= 1; half /= 2, rest = Math.floor(rest / 4)) {
    const [quadrantX, quadrantY] = BAYER_2_CELLS[rest % 4]!;
    x += quadrantX * half;
    y += quadrantY * half;
  }
  return [x, y];
}

// 小数部。
function fract(value: number): number {
  return value - Math.floor(value);
}
