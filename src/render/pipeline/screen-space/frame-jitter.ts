// 近傍拡散補正の走査の入力のうち、時間方向に平均するためにフレームごとに動かすもの — ブルーノイズのずれ(seed)と
// 走査の代表の選び方 — の語彙と、フレーム番号からその位相を答える列。

// フレームごとに動かせる走査の入力。seed はブルーノイズのずれ、scanRepresentative は走査の代表の選び方。
export type JitterSource = 'seed' | 'scanRepresentative';

// 走査の代表の選び方。grid は全ての走査の画素の代表を、受け持つブロックの中の同じ位置 fraction(走査の画素の幅に対する
// 割合。0 以上 1 未満)に置く。perPixel は走査の画素ごとに、番号 draw から引いた乱数の位置に置く。
export type ScanJitter =
  | { readonly kind: 'grid'; readonly fraction: readonly [number, number] }
  | { readonly kind: 'perPixel'; readonly draw: number };

// 1 フレームの走査の入力。seed はブルーノイズのずれ [タイルの幅]、scanJitter は走査の代表の選び方(null はブロックの
// 中心)。
export interface FrameJitter {
  readonly seed: readonly [number, number];
  readonly scanJitter: ScanJitter | null;
}

// seed の列の生成元 — R2 列(塑性数 g の逆冪 (1/g, 1/g²))。どこで打ち切ってもタイルの上に一様に散る。
const PLASTIC = 1.3247179572447461;
const SEED_ALPHA = [1 / PLASTIC, 1 / PLASTIC ** 2] as const;

// 2×2 の Bayer 行列 [[0, 2], [3, 1]] の、番号ごとの升の座標 (x, y)。
const BAYER_2_CELLS = [[0, 0], [1, 1], [1, 0], [0, 1]] as const;

// フレーム frame(0 以上の整数)で動かす走査の入力。sources に含む入力だけが動き、含まない入力は本番の静止画の値(seed (0, 0)・
// 代表はブロックの中心)になる。cellSize は走査の画素の幅 [描画バッファの画素](2 の冪)で、代表は cellSize² 通りの位置を Bayer 順に
// 巡る。フレーム 0 は、どの入力を動かしても本番の静止画と一致する。
export function frameJitterAt(frame: number, sources: readonly JitterSource[], cellSize: number): FrameJitter {
  if (!Number.isInteger(frame) || frame < 0) throw new RangeError(`frame jitter: frame ${frame} is not a non-negative integer`);
  if (!Number.isInteger(cellSize) || cellSize < 1 || (cellSize & (cellSize - 1)) !== 0) {
    throw new RangeError(`frame jitter: the scan cell size ${cellSize} is not a power of two`);
  }
  const seed = sources.includes('seed')
    ? SEED_ALPHA.map((alpha) => fract(frame * alpha)) as [number, number]
    : [0, 0] as const;
  const scanJitter: ScanJitter | null = sources.includes('scanRepresentative')
    ? { kind: 'grid', fraction: gridFractionAt(frame % (cellSize * cellSize), cellSize) }
    : null;
  return { seed, scanJitter };
}

// フレーム frame に置く走査の入力。時定数 timeConstant が 1 なら本番の静止画の値、源 sources が null なら置かない(null)、
// それ以外は sources をその番号の位相で動かした値。
export function frameJitterForTimeConstant(
  frame: number, sources: readonly JitterSource[] | null, timeConstant: number, cellSize: number,
): FrameJitter | null {
  if (sources === null) return null;
  if (!Number.isInteger(timeConstant) || timeConstant < 1) {
    throw new RangeError(`frame jitter: invalid time constant ${timeConstant}`);
  }
  return frameJitterAt(frame, timeConstant > 1 ? sources : [], cellSize);
}

// 一辺 cellSize のブロックの中の位置を散らばる順に巡ったときの、index 番目の位置(ブロックの幅に対する割合)。index 0 は
// ブロックの中心で、cellSize² フレームでブロックの全ての画素を 1 度ずつ巡る。
function gridFractionAt(index: number, cellSize: number): readonly [number, number] {
  const center = Math.floor(cellSize / 2);
  const [x, y] = bayerCellAt(index, cellSize);
  // Bayer 順の先頭は角なので、中心との排他的論理和で先頭を中心へ写す(散らばりは保たれる)。
  return [0.5 + ((x ^ center) - center) / cellSize, 0.5 + ((y ^ center) - center) / cellSize];
}

// 一辺 size(2 の冪)の Bayer 行列で番号 index を持つ升の座標。番号の下位 2 bit から順に、粗い四分割の位置を決める。
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
