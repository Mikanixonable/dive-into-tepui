// 焼き込み済みのタンパク質表示 asset(原子・結合・表面・リボン)の形と、その整合の検証。
export interface ProteinDisplayAsset {
  readonly schemaVersion: number;
  readonly pdbId: string;
  readonly atoms: {
    readonly count: number;
    readonly elementTable: readonly string[];
    readonly elements: readonly number[];
    /** 原子ごとの xyz [Å]。中心寄せ済み。 */
    readonly coordinates: readonly number[];
    readonly radiusTable: readonly number[];
    readonly radiusCodes: readonly number[];
    readonly chainTable: readonly string[];
    readonly chains: readonly number[];
    readonly entities: readonly number[];
    readonly bFactors: readonly number[];
    readonly residueTable: readonly string[];
    readonly residues: readonly number[];
    readonly residueNumbers: readonly number[];
  };
  /** 中心寄せの基準点 [Å]。表面・リボンのメッシュ座標はこれを引くと原子と同じ系になる。 */
  readonly coordinateFrame: { readonly centeredAt: readonly number[] };
  /** 結合する原子索引の組を平坦に並べたもの。 */
  readonly bonds: { readonly pairs: readonly number[] };
  readonly surface: {
    readonly mesh: {
      readonly position: readonly number[];
      readonly index: readonly number[];
      // charge と hydrophobicity は頂点ごとの値で、どちらも -127〜127。
      readonly charge: readonly number[];
      readonly hydrophobicity: readonly number[];
      /** 頂点の由来の鎖 ID。 */
      readonly component: readonly string[];
    };
  };
  readonly ribbon: {
    readonly mesh: {
      readonly position: readonly number[];
      readonly index: readonly number[];
      readonly chain: readonly string[];
    };
  };
  readonly generator: {
    readonly name: string;
    /** 生成物の内容ハッシュ。motion asset が参照する構造の同一性を確かめる。 */
    readonly contentHash: string;
  };
}

/** 識別子と、各配列の長さ・索引の範囲が揃っているかを検証し、崩れていれば例外を投げる。 */
export function assertProteinDisplayAsset(value: ProteinDisplayAsset, expectedPdbId: string): void {
  if (value.schemaVersion !== 1 || value.pdbId !== expectedPdbId) throw new Error(`Invalid ${expectedPdbId} display asset identity`);
  // 原子の配列長。
  const atomCount = value.atoms.count;
  if (value.atoms.coordinates.length % 3 !== 0 || atomCount !== value.atoms.coordinates.length / 3) throw new Error(`Invalid ${expectedPdbId} atom position data`);
  if (value.atoms.elements.length !== atomCount || value.atoms.radiusCodes.length !== atomCount || value.atoms.chains.length !== atomCount
    || value.atoms.residues.length !== atomCount || value.atoms.residueNumbers.length !== atomCount) {
    throw new Error(`Invalid ${expectedPdbId} atom annotation data`);
  }
  // 表面メッシュの属性長と索引範囲。
  const meshVertexCount = value.surface.mesh.position.length / 3;
  if (value.surface.mesh.position.length % 3 !== 0 || value.surface.mesh.charge.length !== meshVertexCount
    || value.surface.mesh.hydrophobicity.length !== meshVertexCount || value.surface.mesh.component.length !== meshVertexCount) {
    throw new Error(`Invalid ${expectedPdbId} surface field data`);
  }
  if (value.surface.mesh.index.some((index) => !Number.isInteger(index) || index < 0 || index >= meshVertexCount)) {
    throw new Error(`Invalid ${expectedPdbId} surface index data`);
  }
  // リボンメッシュの属性長と索引範囲。
  const ribbonVertexCount = value.ribbon.mesh.position.length / 3;
  if (value.ribbon.mesh.position.length % 3 !== 0 || value.ribbon.mesh.chain.length !== ribbonVertexCount) {
    throw new Error(`Invalid ${expectedPdbId} ribbon field data`);
  }
  if (value.ribbon.mesh.index.some((index) => !Number.isInteger(index) || index < 0 || index >= ribbonVertexCount)) {
    throw new Error(`Invalid ${expectedPdbId} ribbon index data`);
  }
}
