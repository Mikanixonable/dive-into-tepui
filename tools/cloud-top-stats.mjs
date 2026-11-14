// 雲頂高度 [m] の分布を、雲のある texel だけから要約する純粋関数。生成の焼き場と
// MODIS Terra の実写参照で同じ定義を使う — 雲頂の距離が、生成と実写の同じ物差しで
// 測れるようにするため。面積・中央値・四分位幅・高さ帯の割合・金床の割合を返す。

// 雲と見なす被覆率の下限。MODIS の参照では、雲のある texel に 1、無い texel に 0 を
// 入れた場を渡すので、同じしきいが「雲マスクがある」ことと等しくなる。
const CLOUD_TOP_COVERAGE = 0.3;
// 金床の判定。この高さ [m] を超える texel のうち、周り ANVIL_RADIUS_KM [km] の雲の
// 雲頂の平均もこの高さを超えているものの、ANVIL_HEIGHT を超える texel に対する割合。
const ANVIL_HEIGHT = 9000;
const ANVIL_RADIUS_KM = 100;

// 分位。空なら 0。比較の他の節と同じ定義 (floor による最近順位) を使う。
export function quantile(sorted, fraction) {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

// 雲頂 [m] の分位。被覆率が CLOUD_TOP_COVERAGE を超え、mask(null なら全域)が立つ texel
// だけを数える。area は数えた範囲に対する雲域の割合、金床は周り ANVIL_RADIUS_KM の雲の
// 雲頂の平均も ANVIL_HEIGHT を超えているものの、ANVIL_HEIGHT を超える texel に対する割合。
export function cloudTopStats(top, coverage, kmPerPx, mask) {
  const { width, height } = top;
  const stride = width + 1;
  // 周りの雲の雲頂の平均を半径に依らず一定の手数で引くための積算表。
  const sumTop = new Float64Array(stride * (height + 1));
  const sumCount = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cloudy = coverage.data[y * width + x] > CLOUD_TOP_COVERAGE ? 1 : 0;
      const i = (y + 1) * stride + (x + 1);
      sumTop[i] = cloudy * top.data[y * width + x] + sumTop[i - 1] + sumTop[i - stride] - sumTop[i - stride - 1];
      sumCount[i] = cloudy + sumCount[i - 1] + sumCount[i - stride] - sumCount[i - stride - 1];
    }
  }
  const boxSum = (table, x0, y0, x1, y1) => table[(y1 + 1) * stride + x1 + 1] - table[y0 * stride + x1 + 1]
    - table[(y1 + 1) * stride + x0] + table[y0 * stride + x0];
  const radius = Math.max(1, Math.round(ANVIL_RADIUS_KM / kmPerPx));

  const tops = [];
  let considered = 0;
  let high = 0;
  let anvils = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask !== null && mask[i] === 0) continue;
      considered++;
      if (coverage.data[i] <= CLOUD_TOP_COVERAGE) continue;
      tops.push(top.data[i]);
      if (top.data[i] <= ANVIL_HEIGHT) continue;
      high++;
      const x0 = Math.max(0, x - radius);
      const y0 = Math.max(0, y - radius);
      const x1 = Math.min(width - 1, x + radius);
      const y1 = Math.min(height - 1, y + radius);
      const count = boxSum(sumCount, x0, y0, x1, y1);
      if (count > 0 && boxSum(sumTop, x0, y0, x1, y1) / count > ANVIL_HEIGHT) anvils++;
    }
  }
  tops.sort((a, b) => a - b);
  const share = (test) => tops.filter(test).length / Math.max(1, tops.length);
  return {
    area: tops.length / Math.max(1, considered),
    median: quantile(tops, 0.5),
    iqr: quantile(tops, 0.75) - quantile(tops, 0.25),
    below3: share((v) => v <= 3000),
    middle: share((v) => v > 3000 && v <= 7000),
    above9: share((v) => v > 9000),
    above12: share((v) => v > 12000),
    anvil: anvils / Math.max(1, high),
  };
}
