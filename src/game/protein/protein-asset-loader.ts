import rawAsset from '../../assets/models/pdb5i4rProtein.json';
import rawMyoglobinAsset from '../../assets/models/myoglobin1mbnProtein.json';
import type { ProteinAssetDefinition } from './protein-schema';
import { validateProteinAsset } from './protein-schema';

const asset = rawAsset as unknown as ProteinAssetDefinition;
const myoglobinAsset = rawMyoglobinAsset as unknown as ProteinAssetDefinition;
for (const candidate of [asset, myoglobinAsset]) {
  const issues = validateProteinAsset(candidate);
  if (issues.length > 0) throw new Error(`Invalid protein asset ${candidate.id}: ${issues.join('; ')}`);
}

export const PROTEIN_ASSETS = {
  'pdb-5i4r': asset,
  'pdb-1mbn-myoglobin': myoglobinAsset,
} as const satisfies Readonly<Record<string, ProteinAssetDefinition>>;

export type ProteinAssetId = keyof typeof PROTEIN_ASSETS;
export const PROTEIN_ASSET_IDS: readonly ProteinAssetId[] = Object.freeze(Object.keys(PROTEIN_ASSETS) as ProteinAssetId[]);
export const PDB5I4R_ASSET = PROTEIN_ASSETS['pdb-5i4r'];
export const MYOGLOBIN_1MBN_ASSET = PROTEIN_ASSETS['pdb-1mbn-myoglobin'];

export function proteinAssetFor(id: string): ProteinAssetDefinition | null {
  return PROTEIN_ASSETS[id as ProteinAssetId] ?? null;
}

export function requireProteinAsset(id: string): ProteinAssetDefinition {
  const asset = proteinAssetFor(id);
  if (!asset) throw new Error(`Unknown protein asset: ${id}`);
  return asset;
}
