import type { ProteinAssetDefinition } from './protein-schema';
import { PROTEIN_ASSET_BUNDLES } from './protein-asset-catalog.generated';

export const PROTEIN_ASSETS = Object.fromEntries(
  Object.entries(PROTEIN_ASSET_BUNDLES).map(([id, candidate]) => [id, candidate.semantic]),
) as { readonly [Id in keyof typeof PROTEIN_ASSET_BUNDLES]: ProteinAssetDefinition };

export type ProteinAssetId = keyof typeof PROTEIN_ASSETS;
export const PROTEIN_ASSET_IDS: readonly ProteinAssetId[] = Object.freeze(Object.keys(PROTEIN_ASSETS) as ProteinAssetId[]);

export function proteinAssetBundleFor(id: string) {
  return PROTEIN_ASSET_BUNDLES[id as ProteinAssetId] ?? null;
}

export function proteinAssetFor(id: string): ProteinAssetDefinition | null {
  return PROTEIN_ASSETS[id as ProteinAssetId] ?? null;
}

export function requireProteinAsset(id: string): ProteinAssetDefinition {
  const asset = proteinAssetFor(id);
  if (!asset) throw new Error(`Unknown protein asset: ${id}`);
  return asset;
}
