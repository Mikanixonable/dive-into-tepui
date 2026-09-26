// 全球の雲質量場と、それを分割して供給する口の契約。正距円筒の格子へ層別・相別の
// 列質量 [kg/m²] を持つ場で、導出は game 層が担い、ここは受け渡しの形と検査だけを定義する。

// 全球の質量場。equirect 格子のセル・層ごとの列質量 [kg/m²] を持つ。配列の添字は
// (層 × height + 行) × width + 列 の層優先行優先で、行 0 は北極側の帯、列 0 は経度 -π の
// 西端(日付変更線)。描画側の equirect 投影(equirectUvFromDirection)と同じ取り決めなので、
// セル (行 r, 列 c) は uv の矩形 [c/w,(c+1)/w] × [r/h,(r+1)/h] に対応する。
export interface CloudGlobalMassField {
  readonly width: number;
  readonly height: number;
  // 格子が覆う球面の半径 [m]。
  readonly sphereRadiusM: number;
  // 連続する高度層の境界 [m]。下端を含み、内部境界は上側の層に属する。層数は長さ -1。
  readonly layerEdgesM: readonly number[];
  // 液水の列質量 [kg/m²]。長さ width × height × 層数。
  readonly liquidKgM2: Float64Array;
  // 氷の列質量 [kg/m²]。長さは liquidKgM2 と同じ。
  readonly iceKgM2: Float64Array;
}

// ジョブの完了時に返す結果。ここでは場だけを読む。
export interface GlobalMassFieldResult {
  readonly field: CloudGlobalMassField;
}

// 分割して進められる質量場の導出。step へ1回の駆動で使ってよい壁時計の上限 [ms] を渡すと、
// その範囲で内部を進める。done が立つまで result は null を返し、途中経過を外へ出さない。
export interface GlobalMassFieldJob {
  step(timeBudgetMs: number): { readonly done: boolean };
  readonly result: GlobalMassFieldResult | null;
  // 途中で放棄するときの後始末。done 以後は呼ばない。
  cancel?(): void;
}

// 表示時刻から全球の質量場を導出する口。実装は game 層に置き、こちらは契約だけを見る。
export interface GlobalMassFieldSupply {
  startJob(displayTimeSeconds: number): GlobalMassFieldJob;
}

// 場の形を検査する。配列の中身の値域は凝結の側が物理閉包を通して確かめるので、ここでは
// 寸法・層境界・配列長の整合だけを見る。
export function validateCloudGlobalMassField(field: CloudGlobalMassField): void {
  if (!Number.isSafeInteger(field.width) || field.width <= 0
    || !Number.isSafeInteger(field.height) || field.height <= 0
    || !Number.isSafeInteger(field.width * field.height)) {
    throw new RangeError('global mass field dimensions must be positive safe integers');
  }
  if (!Number.isFinite(field.sphereRadiusM) || field.sphereRadiusM <= 0) {
    throw new RangeError('sphereRadiusM must be finite and positive');
  }
  if (field.layerEdgesM.length < 2) {
    throw new RangeError('layerEdgesM must contain at least two boundaries');
  }
  for (const [index, edgeM] of field.layerEdgesM.entries()) {
    if (!Number.isFinite(edgeM) || edgeM < 0
      || (index > 0 && edgeM <= field.layerEdgesM[index - 1]!)) {
      throw new RangeError('layerEdgesM must be finite, non-negative, and strictly increasing');
    }
  }
  const expected = field.width * field.height * (field.layerEdgesM.length - 1);
  if (field.liquidKgM2.length !== expected || field.iceKgM2.length !== expected) {
    throw new RangeError('mass arrays must match width × height × layer count');
  }
}
