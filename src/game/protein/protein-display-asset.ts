import rawAsset from '../../assets/models/pdb5i4rStructure.json';

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
    readonly hydrophobicity: readonly number[];
    readonly surfaceCharge: readonly number[];
  };
  readonly generator: { readonly name: string };
}

const asset = rawAsset as unknown as ProteinDisplayAsset;

function assertDisplayAsset(value: ProteinDisplayAsset): void {
  if (value.schemaVersion !== 1 || value.pdbId !== '5I4R') throw new Error('Invalid 5I4R display asset identity');
  const atomCount = value.atoms.count;
  if (value.atoms.coordinates.length % 3 !== 0 || atomCount !== value.atoms.coordinates.length / 3) throw new Error('Invalid 5I4R atom position data');
  if (value.atoms.elements.length !== atomCount || value.atoms.radiusCodes.length !== atomCount || value.atoms.chains.length !== atomCount) {
    throw new Error('Invalid 5I4R atom annotation data');
  }
  const meshVertexCount = value.surface.mesh.position.length / 3;
  if (value.surface.mesh.position.length % 3 !== 0 || value.surface.mesh.charge.length !== meshVertexCount
    || value.surface.mesh.hydrophobicity.length !== meshVertexCount || value.surface.mesh.component.length !== meshVertexCount) {
    throw new Error('Invalid 5I4R surface field data');
  }
  if (value.surface.mesh.index.some((index) => !Number.isInteger(index) || index < 0 || index >= meshVertexCount)) {
    throw new Error('Invalid 5I4R surface index data');
  }
}

assertDisplayAsset(asset);
export const PDB5I4R_DISPLAY_ASSET = asset;
