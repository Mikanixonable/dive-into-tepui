// 場をしきいで二値化したときの、雲の塊(連結成分)の形の特徴量。塊の数・面積の分布・
// 穴(塊に囲まれた晴れ)・周囲の長さを測る。階調やスペクトルが「量と波長」しか見ないのに
// 対して、こちらは「まとまりの形」を見る物差し — 生成雲がのっぺりした大きな塊になりがちか、
// 実写のように小さな塊へ割れるかを、数で比べるためにある。
//
// 連結性は前景(雲)を 8 近傍、背景(晴れ)を 4 近傍とする。双対の決め方で、前景を 8 近傍に
// すると背景も 8 近傍では斜めに触れた晴れ同士の分離と囲みが矛盾するため。穴は、面の縁に
// 触れていない背景の成分と数える。wrapX の面(全球)では横は経度で巻くので、縁は上下だけ
// になる — 横端で割れた塊は 1 つに繋がり、横へ抜ける晴れは穴にならない。
//
// 面積と周囲は texel の数ではなく地表の km で測る。正距円筒は緯度で横が縮むので、
// cloud-structure.mjs と同じく行ごとの横 1 texel の距離 [km] を渡す。

// 昇順に並んだ値の分位。cloud-lab-compare.mjs の quantile と同じ取り方(床の index)。
function quantileOfSorted(sorted, fraction) {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

// 二値の場 (mask: 1 = 前景) の連結成分にラベルを振り、成分ごとの texel 数を返す。
// neighbors は近傍の [dx, dy] の並び。wrapX なら横を巻く。
function labelComponents(mask, width, height, wrapX, neighbors) {
  const labels = new Int32Array(width * height).fill(-1);
  const sizes = [];
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || labels[start] !== -1) continue;
    const label = sizes.length;
    let size = 0;
    labels[start] = label;
    stack.push(start);
    while (stack.length > 0) {
      const at = stack.pop();
      size++;
      const x = at % width;
      const y = Math.floor(at / width);
      for (const [dx, dy] of neighbors) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        let nx = x + dx;
        if (wrapX) {
          nx = ((nx % width) + width) % width;
        } else if (nx < 0 || nx >= width) {
          continue;
        }
        const next = ny * width + nx;
        if (mask[next] === 1 && labels[next] === -1) {
          labels[next] = label;
          stack.push(next);
        }
      }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

const FOREGROUND_NEIGHBORS = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];
const BACKGROUND_NEIGHBORS = [[0, -1], [-1, 0], [1, 0], [0, 1]];

// 場を threshold で二値化し、雲の塊の形の特徴量を返す。rowKmPerPx は行ごとの横 1 texel の
// 地表距離 [km]、kmPerPxY は縦 1 texel の地表距離 [km]。面積は行の距離 × 縦の距離で texel
// ごとに重み付けするので、正距円筒でも高緯度が水増しされない。
export function componentStats(field, threshold, wrapX, rowKmPerPx, kmPerPxY) {
  const { width, height, data } = field;
  const mask = new Uint8Array(width * height);
  let cloudyTexels = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > threshold) {
      mask[i] = 1;
      cloudyTexels++;
    }
  }

  const foreground = labelComponents(mask, width, height, wrapX, FOREGROUND_NEIGHBORS);

  // 穴: 背景の成分のうち、面の縁(上下、wrapX でないなら左右も)に触れていないもの。
  // 外周(穴の周を含まない周囲)を成分ごとに数えるので、周囲の計算より先に背景へラベルを振る。
  const inverted = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) inverted[i] = mask[i] === 0 ? 1 : 0;
  const background = labelComponents(inverted, width, height, wrapX, BACKGROUND_NEIGHBORS);
  const touchesEdge = new Array(background.sizes.length).fill(false);
  for (let x = 0; x < width; x++) {
    touchesEdge[background.labels[x]] = true;
    touchesEdge[background.labels[(height - 1) * width + x]] = true;
  }
  if (!wrapX) {
    for (let y = 0; y < height; y++) {
      touchesEdge[background.labels[y * width]] = true;
      touchesEdge[background.labels[y * width + width - 1]] = true;
    }
  }
  let holeCount = 0;
  let holeTexels = 0;
  for (let label = 0; label < background.sizes.length; label++) {
    if (touchesEdge[label]) continue;
    holeCount++;
    holeTexels += background.sizes[label];
  }

  // 成分ごとの面積 [km²] と、周囲 [km]。周囲は前景 texel の 4 近傍で背景 (面の外を含む) に
  // 接する辺の長さの和 — 縦の辺は kmPerPxY、横の辺はその行の rowKmPerPx。
  // outerPerimeters は同じ辺のうち、穴に面したものを除いた外周だけを成分ごとに数える
  // (面の外に面する辺は外周に含める)。
  const areas = new Float64Array(foreground.sizes.length);
  const outerPerimeters = new Float64Array(foreground.sizes.length);
  let perimeterKm = 0;
  for (let y = 0; y < height; y++) {
    const rowKm = rowKmPerPx[y];
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] === 0) continue;
      const label = foreground.labels[i];
      areas[label] += rowKm * kmPerPxY;
      if (y === 0 || mask[i - width] === 0) perimeterKm += rowKm;
      if (y === height - 1 || mask[i + width] === 0) perimeterKm += rowKm;
      const west = wrapX ? y * width + ((x - 1 + width) % width) : i - 1;
      if (x === 0 && !wrapX) perimeterKm += kmPerPxY;
      else if (mask[west] === 0) perimeterKm += kmPerPxY;
      const east = wrapX ? y * width + ((x + 1) % width) : i + 1;
      if (x === width - 1 && !wrapX) perimeterKm += kmPerPxY;
      else if (mask[east] === 0) perimeterKm += kmPerPxY;
      if (y === 0) outerPerimeters[label] += rowKm;
      else if (mask[i - width] === 0 && touchesEdge[background.labels[i - width]]) outerPerimeters[label] += rowKm;
      if (y === height - 1) outerPerimeters[label] += rowKm;
      else if (mask[i + width] === 0 && touchesEdge[background.labels[i + width]]) outerPerimeters[label] += rowKm;
      if (x === 0 && !wrapX) outerPerimeters[label] += kmPerPxY;
      else if (mask[west] === 0 && touchesEdge[background.labels[west]]) outerPerimeters[label] += kmPerPxY;
      if (x === width - 1 && !wrapX) outerPerimeters[label] += kmPerPxY;
      else if (mask[east] === 0 && touchesEdge[background.labels[east]]) outerPerimeters[label] += kmPerPxY;
    }
  }
  const sortedAreas = Array.from(areas).sort((a, b) => a - b);
  const totalAreaKm2 = sortedAreas.reduce((sum, area) => sum + area, 0);

  return {
    threshold,
    count: foreground.sizes.length,
    cloudyShare: cloudyTexels / Math.max(1, width * height),
    areaKm2: {
      median: quantileOfSorted(sortedAreas, 0.5),
      p90: quantileOfSorted(sortedAreas, 0.9),
      max: sortedAreas.at(-1) ?? 0,
      total: totalAreaKm2,
    },
    largestShare: totalAreaKm2 > 0 ? (sortedAreas.at(-1) ?? 0) / totalAreaKm2 : 0,
    holeCount,
    holeAreaShare: cloudyTexels > 0 ? holeTexels / cloudyTexels : 0,
    perimeterKm,
    perimeterPerArea: totalAreaKm2 > 0 ? perimeterKm / totalAreaKm2 : 0,
    // 成分ごとの面積 [km²] と外周 [km](穴の周は含めない)。
    components: Array.from(areas, (areaKm2, index) => ({
      areaKm2,
      perimeterKm: outerPerimeters[index],
    })),
  };
}
