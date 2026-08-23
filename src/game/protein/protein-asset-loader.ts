import rawAsset from '../../assets/models/pdb5i4rProtein.json';
import type { ProteinAssetDefinition } from './protein-schema';
import { validateProteinAsset } from './protein-schema';

const asset = rawAsset as unknown as ProteinAssetDefinition;
const issues = validateProteinAsset(asset);
if (issues.length > 0) throw new Error(`Invalid protein asset ${asset.id}: ${issues.join('; ')}`);

export const PDB5I4R_ASSET = asset;

export function proteinAssetFor(id: string): ProteinAssetDefinition | null {
  return id === PDB5I4R_ASSET.id ? PDB5I4R_ASSET : null;
}
