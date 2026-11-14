// 2 つの時刻の場のあいだの動きを測る純粋関数。生成雲が「風に流されているか」「どれだけの
// 速さで形を変えるか」を、移流の lag 相関と重心で数にするためのもの。場は
// { width, height, data } の 0..1 の並びで、x は経度 (巻く)、y は南向きに行が増える。

// a と、b を (dx, dy) だけずらしたもののピアソン相関。b の参照は x を巻き、y は重なる行だけ
// を使う (dy のぶん端の行は落とす)。平均は両方とも重なり域で取る。dx は「模様が a から b へ
// 東へ動いた量」として読む (b(x + dx) が a(x) に合う dx が最大になる)。
export function lagCorrelation(a, b, dx, dy) {
  const { width, height } = a;
  const y0 = Math.max(0, -dy);
  const y1 = Math.min(height, height - dy);
  let meanA = 0;
  let meanB = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      meanA += a.data[y * width + x];
      meanB += b.data[(y + dy) * width + ((x + dx + width) % width)];
      count++;
    }
  }
  if (count === 0) return 0;
  meanA /= count;
  meanB /= count;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const da = a.data[y * width + x] - meanA;
      const db = b.data[(y + dy) * width + ((x + dx + width) % width)] - meanB;
      covariance += da * db;
      varianceA += da * da;
      varianceB += db * db;
    }
  }
  return covariance / Math.sqrt(varianceA * varianceB + 1e-30);
}

// 相関が最大になるずらし (dx, dy) を総当たりで探す。雲の移流は主に東西なので、横は広く、
// 縦は狭く取るのが呼び出し側の役目。
export function bestShift(a, b, maxDx, maxDy) {
  let best = { dx: 0, dy: 0, correlation: -Infinity };
  for (let dy = -maxDy; dy <= maxDy; dy++) {
    for (let dx = -maxDx; dx <= maxDx; dx++) {
      const correlation = lagCorrelation(a, b, dx, dy);
      if (correlation > best.correlation) best = { dx, dy, correlation };
    }
  }
  return best;
}

// 時刻 [h] の並びと時刻 0 からの相関の並びから、相関が level を切る時刻を線形補間で返す。
// 範囲のうちに切らなければ null (その場合は「少なくとも最後の時刻までは形が保たれる」)。
export function crossingTime(hours, correlations, level) {
  for (let i = 1; i < hours.length; i++) {
    if (correlations[i] <= level) {
      const span = correlations[i - 1] - correlations[i];
      const fraction = span > 0 ? (correlations[i - 1] - level) / span : 0;
      return hours[i - 1] + fraction * (hours[i] - hours[i - 1]);
    }
  }
  return null;
}

// 場の重み付き重心の、中心からのずれ [texel]。重みは値そのもの (被覆率なら雲の重さ)。
// dx は東向き、dy は南向き (行の向き) が正。
export function centroidOffset(field) {
  const { width, height, data } = field;
  let sum = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = data[y * width + x];
      sum += w;
      sumX += w * x;
      sumY += w * y;
    }
  }
  if (sum <= 0) return null;
  return { dx: sumX / sum - (width - 1) / 2, dy: sumY / sum - (height - 1) / 2 };
}
