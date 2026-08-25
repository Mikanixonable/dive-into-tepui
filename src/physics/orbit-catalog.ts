// CR3BP の周期軌道カタログ。焼き込んだ軌道族(tools/export-lagrange-orbits.mjs が生成)を読み、
// 無次元の回転座標系での点列として取り出す。実スケール・実際の天体位置へ写すのは orbit-guide.ts。
//
// 座標系の規約: 重心原点、主天体を (−μ,0,0)、副天体を (1−μ,0,0) に置き、長さの単位を
// 両天体間距離、時間の単位を平均運動の逆数(n=1)に取る。ヤコビ定数は C = 2Ω − v²。

// 焼き込みの対象になる系。JPL の周期軌道カタログが配信する系と同じ識別子を使う。
export type CatalogSystemId =
  | 'earth-moon' | 'sun-earth' | 'sun-mars'
  | 'jupiter-europa' | 'saturn-titan' | 'saturn-enceladus' | 'mars-phobos';

// 軌道族の識別子。`<族>` または `<族>-<ラグランジュ点>` または `<族>-<ラグランジュ点>-<枝>`。
// 例: 'lyapunov-L1'、'halo-L2-N'、'dro'、'resonant-12'(1:2 共鳴)。
export type CatalogFamilyId = string;

// 族に属する軌道1本ぶんの諸元。点列そのものは CatalogFamily.points がまとめて持つ。
export interface CatalogMember {
  // 族に沿った位置。0 が族の始端、1 が終端で、メンバーの並び順に単調増加する。
  readonly s: number;
  // 軌道周期(無次元、2π が副天体の公転1周)。
  readonly period: number;
  readonly jacobi: number;
  // 安定性指数。1 が中立で、1 から離れるほど不安定(JPL の stability をそのまま持つ)。
  readonly stability: number;
}

export interface CatalogFamily {
  readonly members: readonly CatalogMember[];
  // 1メンバーあたりの点数。
  readonly samples: number;
  // 全メンバーの点列を連結した Float32 配列の base64。1点は [x, y, z, tFrac, vx, vy, vz] の
  // 7値で、tFrac はその点までの経過時刻を周期で割った 0..1 の値、速度は無次元時間に対する
  // 値。並びは members の順、各メンバー内は弧長等間隔。
  readonly points: string;
}

export interface CatalogSystem {
  readonly mu: number;
  // 両天体間距離 [km] と時間の単位 [s]。無次元量を実スケールへ戻すのに使う。
  readonly lunit: number;
  readonly tunit: number;
  readonly secondaryRadius: number; // [km]
  readonly families: Readonly<Record<CatalogFamilyId, CatalogFamily>>;
}

export interface OrbitCatalog {
  readonly systems: Readonly<Partial<Record<CatalogSystemId, CatalogSystem>>>;
  // 遅延ロードする系も含めた、系ごとの族 id 一覧。UI は起動時にこれを見て選択肢を組めるので、
  // まだ読み込んでいない系の種類が後から現れることがない。
  readonly familyIndex: Readonly<Partial<Record<CatalogSystemId, readonly string[]>>>;
}

// 1点あたりの値の数([x, y, z, tFrac, vx, vy, vz])。
export const CATALOG_STRIDE = 7;

// base64 の点列を Float32Array へ戻す。
export function decodeCatalogPoints(points: string): Float32Array {
  const binary = atob(points);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
