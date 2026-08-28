// CR3BP 周期軌道族の並びを扱う共通処理。取得(fetch-orbit-catalog.mjs)と焼き込み
// (export-lagrange-orbits.mjs)の双方が、族に沿った連続性の判定と弦長等間隔の間引きに使う。
//
// 「族」は初期状態ベクトルが連続に変わる1本の列であることが前提で、そうなっていない元データ
// (互いに繋がらない枝を含む族)は連続する区間へ分ける。区間ごとの族 id は元の id に
// `#<番号>` を付けた形にする(番号は族に沿った順に1から)。`-` で区切る既存の規約
// (`<族>-<ラグランジュ点>-<枝>`、src/physics/orbit-catalog.ts)と衝突させないため、
// 区切りには `-` を使わない。

// 区間を表す族 id の区切り。
export const SEGMENT_MARK = '#';

// 族 id に区間の番号を付ける。1区間しか無いときは元の id のままにする — 分ける必要が
// 無かった族の id が変わると、保存済みの表示設定が失われる。
// baseKey には区間番号を含めないこと(番号が入れ子になると id を解釈できなくなる)。
export function segmentFamilyKey(baseKey, index, total) {
  return total <= 1 ? baseKey : `${baseKey}${SEGMENT_MARK}${index + 1}`;
}

// 区間つき族 id を、区間を除いた族 id と区間番号へ分ける。区間番号が無ければ 0 を返す。
export function splitSegmentKey(key) {
  const mark = key.indexOf(SEGMENT_MARK);
  if (mark < 0) return { baseKey: key, segment: 0 };
  const segment = Number(key.slice(mark + SEGMENT_MARK.length));
  if (!Number.isInteger(segment) || segment < 1) return { baseKey: key, segment: 0 };
  return { baseKey: key.slice(0, mark), segment };
}

// 状態ベクトル(先頭6要素が [x,y,z,vx,vy,vz])どうしの2乗距離。
export function squaredStateDistance(rows, i, j) {
  const a = rows[i];
  const b = rows[j];
  let sum = 0;
  for (let k = 0; k < 6; k++) {
    const d = a[k] - b[k];
    sum += d * d;
  }
  return sum;
}

// 並び order に沿った隣接ステップ距離。
export function chainSteps(rows, order) {
  const steps = [];
  for (let i = 1; i < order.length; i++) {
    steps.push(Math.sqrt(squaredStateDistance(rows, order[i - 1], order[i])));
  }
  return steps;
}

// rows をいまの並びのまま見たときの、隣接ステップ距離。
export function neighborSteps(rows) {
  return chainSteps(rows, rows.map((_, index) => index));
}

// 値の中央値。空なら 0。
export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// 大きなステップと見なす倍率(中央値に対する比)。
export const LARGE_STEP_FACTOR = 8;
// 大きなステップがこの本数以下だけ連続していたら、刻みの粗い区間ではなくデータの断絶と見なす。
export const BREAK_RUN_LIMIT = 2;

// 並びの中の「断絶」の位置(その添字の手前で切れる)を返す。
// 中央値の LARGE_STEP_FACTOR 倍を超えるステップが連続する塊のうち、短いものだけを拾う。
// 刻みが疎な区間では大きなステップが何十本も続くが、それは並びが正しくても起きるので断絶では
// ない。逆に、繋がらない枝どうしの境目では大きなステップが1〜2本だけ孤立して現れる。
export function breakIndices(steps) {
  const typical = median(steps);
  if (!(typical > 0)) return [];

  const breaks = [];
  let runStart = -1;
  for (let i = 0; i <= steps.length; i++) {
    const large = i < steps.length && steps[i] > LARGE_STEP_FACTOR * typical;
    if (large && runStart < 0) runStart = i;
    if (!large && runStart >= 0) {
      // steps[k] は rows[k] と rows[k+1] の間なので、塊の手前と後ろの両方で切る。
      if (i - runStart <= BREAK_RUN_LIMIT) breaks.push({ from: runStart + 1, to: i });
      runStart = -1;
    }
  }
  return breaks;
}

// 並んだ rows を、断絶で区切った連続区間の配列へ分ける。断絶そのものに含まれる行
// (どちらの区間にも属さない孤立メンバー)は落とす。
// minLength は分割で生じた断片を捨てるための下限で、断絶が無い族には効かせない — 元から
// 短いだけの族まで消してしまうため。すべての区間が下限に満たないときは最長のものを残す。
export function splitAtBreaks(rows, minLength) {
  const breaks = breakIndices(neighborSteps(rows));
  if (breaks.length === 0) return [rows];

  const segments = [];
  let start = 0;
  for (const { from, to } of breaks) {
    if (from > start) segments.push(rows.slice(start, from));
    start = to;
  }
  if (rows.length > start) segments.push(rows.slice(start));
  return keepLongEnough(segments, minLength);
}

// minLength 以上の区間だけを残す。1つも残らなければ最長の区間だけを残す。
export function keepLongEnough(segments, minLength) {
  const kept = segments.filter((segment) => segment.length >= minLength);
  if (kept.length > 0) return kept;
  if (segments.length === 0) return [];
  return [segments.reduce((longest, segment) => (segment.length > longest.length ? segment : longest))];
}

// 族に沿って、状態ベクトルの累積弦長が等間隔になる位置に最も近い count 件を選ぶ。
// rows は族に沿った順に並んでいることが前提。先頭と末尾は必ず含む。
// 選ぶ添字は必ず前回より後ろへ進め、かつ残りの本数を確保できる範囲に収める — 単純に
// 「目標にいちばん近い行」を選ぶと、族に大きな断絶があるとき目標の多くが隙間の中に落ちて
// 同じ行に丸まり、count 件に届かなくなる。
export function thinByChordLength(rows, count) {
  if (rows.length <= count) return rows;
  const n = rows.length;
  const cumulative = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    cumulative[i] = cumulative[i - 1] + Math.sqrt(squaredStateDistance(rows, i - 1, i));
  }
  const total = cumulative[n - 1];

  const picked = [];
  let previous = -1;
  for (let i = 0; i < count; i++) {
    const target = total === 0 ? (i * (n - 1)) / (count - 1) : (i * total) / (count - 1);
    const lowest = previous + 1;
    const highest = n - (count - i);
    let bestIndex = lowest;
    let bestDiff = Infinity;
    for (let j = lowest; j <= highest; j++) {
      const diff = Math.abs((total === 0 ? j : cumulative[j]) - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIndex = j;
      }
    }
    picked.push(rows[bestIndex]);
    previous = bestIndex;
  }
  return picked;
}
