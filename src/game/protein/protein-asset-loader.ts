import rawAsset from '../../assets/models/pdb5i4rProtein.json';
import type { ProteinAssetDefinition } from './protein-schema';
import { validateProteinAsset } from './protein-schema';

const asset = rawAsset as unknown as ProteinAssetDefinition;
const issues = validateProteinAsset(asset);
if (issues.length > 0) throw new Error(`Invalid protein asset ${asset.id}: ${issues.join('; ')}`);

export const PROTEIN_ASSETS = {
  'pdb-5i4r': asset,
} as const satisfies Readonly<Record<string, ProteinAssetDefinition>>;

export type ProteinAssetId = keyof typeof PROTEIN_ASSETS;
export const PROTEIN_ASSET_IDS: readonly ProteinAssetId[] = Object.freeze(Object.keys(PROTEIN_ASSETS) as ProteinAssetId[]);
export const PDB5I4R_ASSET = PROTEIN_ASSETS['pdb-5i4r'];

export function proteinAssetFor(id: string): ProteinAssetDefinition | null {
  return PROTEIN_ASSETS[id as ProteinAssetId] ?? null;
}

export function requireProteinAsset(id: string): ProteinAssetDefinition {
  const asset = proteinAssetFor(id);
  if (!asset) throw new Error(`Unknown protein asset: ${id}`);
  return asset;
}
