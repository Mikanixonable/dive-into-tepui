export interface ProteinDisplayAsset {
  readonly schemaVersion: number;
  readonly pdbId: string;
  readonly atoms: {
    readonly count: number;
    readonly elementTable: readonly string[];
    readonly elements: readonly number[];
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
  readonly coordinateFrame: { readonly centeredAt: readonly number[] };
  readonly bonds: { readonly pairs: readonly number[] };
  readonly surface: {
    readonly mesh: {
      readonly position: readonly number[];
      readonly index: readonly number[];
      readonly charge: readonly number[];
      readonly hydrophobicity: readonly number[];
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
  readonly generator: { readonly name: string };
}

export function assertProteinDisplayAsset(value: ProteinDisplayAsset, expectedPdbId: string): void {
  if (value.schemaVersion !== 1 || value.pdbId !== expectedPdbId) throw new Error(`Invalid ${expectedPdbId} display asset identity`);
  const atomCount = value.atoms.count;
  if (value.atoms.coordinates.length % 3 !== 0 || atomCount !== value.atoms.coordinates.length / 3) throw new Error(`Invalid ${expectedPdbId} atom position data`);
  if (value.atoms.elements.length !== atomCount || value.atoms.radiusCodes.length !== atomCount || value.atoms.chains.length !== atomCount
    || value.atoms.residues.length !== atomCount || value.atoms.residueNumbers.length !== atomCount) {
    throw new Error(`Invalid ${expectedPdbId} atom annotation data`);
  }
  const meshVertexCount = value.surface.mesh.position.length / 3;
  if (value.surface.mesh.position.length % 3 !== 0 || value.surface.mesh.charge.length !== meshVertexCount
    || value.surface.mesh.hydrophobicity.length !== meshVertexCount || value.surface.mesh.component.length !== meshVertexCount) {
    throw new Error(`Invalid ${expectedPdbId} surface field data`);
  }
  if (value.surface.mesh.index.some((index) => !Number.isInteger(index) || index < 0 || index >= meshVertexCount)) {
    throw new Error(`Invalid ${expectedPdbId} surface index data`);
  }
  const ribbonVertexCount = value.ribbon.mesh.position.length / 3;
  if (value.ribbon.mesh.position.length % 3 !== 0 || value.ribbon.mesh.chain.length !== ribbonVertexCount) {
    throw new Error(`Invalid ${expectedPdbId} ribbon field data`);
  }
  if (value.ribbon.mesh.index.some((index) => !Number.isInteger(index) || index < 0 || index >= ribbonVertexCount)) {
    throw new Error(`Invalid ${expectedPdbId} ribbon index data`);
  }
}
