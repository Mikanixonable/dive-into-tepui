// Generated from assets-src/proteins/*/protein.config.json.
// Run `npm run protein:catalog` after adding or renaming a protein asset.
import rawPdb5i4rSemantic from '../../assets/models/pdb5i4rProtein.json';
import rawPdb5i4rBackbone from '../../assets/models/pdb5i4rBackbone.json';
import rawPdb5i4rStructure from '../../assets/models/pdb5i4rStructure.json';
import rawPdb1mbnMyoglobinSemantic from '../../assets/models/myoglobin1mbnProtein.json';
import rawPdb1mbnMyoglobinBackbone from '../../assets/models/myoglobin1mbnBackbone.json';
import rawPdb1mbnMyoglobinStructure from '../../assets/models/myoglobin1mbnStructure.json';
import type { ProteinBackboneAsset } from '../../render/protein-enemy-ship';
import { assertProteinDisplayAsset, type ProteinDisplayAsset } from './protein-display-asset';
import { validateProteinAsset, type ProteinAssetDefinition } from './protein-schema';

export interface ProteinAssetBundle {
  readonly semantic: ProteinAssetDefinition;
  readonly backbone: ProteinBackboneAsset;
  readonly structure: ProteinDisplayAsset;
}

function bundle(
  semanticValue: unknown,
  backboneValue: unknown,
  structureValue: unknown,
  expectedId: string,
  expectedPdbId: string,
): ProteinAssetBundle {
  const semantic = semanticValue as ProteinAssetDefinition;
  const issues = validateProteinAsset(semantic);
  if (semantic.id !== expectedId) issues.unshift(`id must be ${expectedId}`);
  if (issues.length > 0) throw new Error(`Invalid protein asset ${expectedId}: ${issues.join('; ')}`);
  const structure = structureValue as ProteinDisplayAsset;
  assertProteinDisplayAsset(structure, expectedPdbId);
  return { semantic, backbone: backboneValue as ProteinBackboneAsset, structure };
}

export const PROTEIN_ASSET_BUNDLES = {
  'pdb-5i4r': bundle(
    rawPdb5i4rSemantic, rawPdb5i4rBackbone, rawPdb5i4rStructure, 'pdb-5i4r', '5I4R',
  ),
  'pdb-1mbn-myoglobin': bundle(
    rawPdb1mbnMyoglobinSemantic, rawPdb1mbnMyoglobinBackbone, rawPdb1mbnMyoglobinStructure, 'pdb-1mbn-myoglobin', '1MBN',
  ),
} as const satisfies Readonly<Record<string, ProteinAssetBundle>>;
