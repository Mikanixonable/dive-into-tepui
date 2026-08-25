// Generated from assets-src/proteins/*/protein.config.json.
// Run npm run protein:catalog after adding or renaming a protein asset.
import rawPdb8rucRubiscoSemantic from '../../assets/models/rubisco8rucProtein.json';
import rawPdb8rucRubiscoBackbone from '../../assets/models/rubisco8rucBackbone.json';
import rawPdb8rucRubiscoStructure from '../../assets/models/rubisco8rucStructure.json';
import rawPdb8rucRubiscoMotion from '../../assets/models/rubisco8rucMotion.json';
import rawPdb6n2yAtpSynthaseSemantic from '../../assets/models/atpSynthase6n2yProtein.json';
import rawPdb6n2yAtpSynthaseBackbone from '../../assets/models/atpSynthase6n2yBackbone.json';
import rawPdb6n2yAtpSynthaseStructure from '../../assets/models/atpSynthase6n2yStructure.json';
import rawPdb6n2yAtpSynthaseMotion from '../../assets/models/atpSynthase6n2yMotion.json';
import rawPdb5i4rSemantic from '../../assets/models/pdb5i4rProtein.json';
import rawPdb5i4rBackbone from '../../assets/models/pdb5i4rBackbone.json';
import rawPdb5i4rStructure from '../../assets/models/pdb5i4rStructure.json';
import rawPdb5i4rMotion from '../../assets/models/pdb5i4rMotion.json';
import rawPdb1mbnMyoglobinSemantic from '../../assets/models/myoglobin1mbnProtein.json';
import rawPdb1mbnMyoglobinBackbone from '../../assets/models/myoglobin1mbnBackbone.json';
import rawPdb1mbnMyoglobinStructure from '../../assets/models/myoglobin1mbnStructure.json';
import rawPdb1mbnMyoglobinMotion from '../../assets/models/myoglobin1mbnMotion.json';
import type { ProteinBackboneAsset } from '../../render/protein-enemy-ship';
import { assertProteinDisplayAsset, type ProteinDisplayAsset } from './protein-display-asset';
import { validateProteinAsset, validateProteinMotionAsset, type ProteinAssetDefinition, type ProteinMotionAsset } from './protein-schema';

export interface ProteinAssetBundle {
  readonly semantic: ProteinAssetDefinition;
  readonly backbone: ProteinBackboneAsset;
  readonly structure: ProteinDisplayAsset;
  readonly motion: ProteinMotionAsset;
}

function bundle(
  semanticValue: unknown,
  backboneValue: unknown,
  structureValue: unknown,
  motionValue: unknown,
  expectedId: string,
  expectedPdbId: string,
): ProteinAssetBundle {
  const semantic = semanticValue as ProteinAssetDefinition;
  const issues = validateProteinAsset(semantic);
  if (semantic.id !== expectedId) issues.unshift("id must be " + expectedId);
  if (issues.length > 0) throw new Error("Invalid protein asset " + expectedId + ": " + issues.join("; "));
  const structure = structureValue as ProteinDisplayAsset;
  assertProteinDisplayAsset(structure, expectedPdbId);
  const motion = motionValue as ProteinMotionAsset;
  const backbone = backboneValue as ProteinBackboneAsset;
  const motionIssues = validateProteinMotionAsset(motion, expectedPdbId, {
    atomResidues: structure.atoms.count,
    backboneResidues: backbone.backboneCount,
    surfaceResidues: structure.surface.mesh.position.length / 3,
    ribbonResidues: structure.ribbon.mesh.position.length / 3,
    siteResidues: semantic.sites.length,
    modificationResidues: semantic.modificationSlots.length,
  });
  if (motionIssues.length > 0) throw new Error("Invalid protein motion asset " + expectedId + ": " + motionIssues.join("; "));
  const structureHash = (structure as ProteinDisplayAsset & { readonly generator?: { readonly contentHash?: string } }).generator?.contentHash;
  const backboneHash = (backboneValue as ProteinBackboneAsset & { readonly contentHash?: string }).contentHash;
  if (motion.source.structureHash !== structureHash) throw new Error("Protein motion " + expectedId + " structure hash mismatch");
  if (motion.source.backboneHash !== backboneHash) throw new Error("Protein motion " + expectedId + " backbone hash mismatch");
  return { semantic, backbone, structure, motion };
}

export const PROTEIN_ASSET_BUNDLES = {
  'pdb-8ruc-rubisco': bundle(
    rawPdb8rucRubiscoSemantic, rawPdb8rucRubiscoBackbone, rawPdb8rucRubiscoStructure, rawPdb8rucRubiscoMotion, 'pdb-8ruc-rubisco', '8RUC',
  ),
  'pdb-6n2y-atp-synthase': bundle(
    rawPdb6n2yAtpSynthaseSemantic, rawPdb6n2yAtpSynthaseBackbone, rawPdb6n2yAtpSynthaseStructure, rawPdb6n2yAtpSynthaseMotion, 'pdb-6n2y-atp-synthase', '6N2Y',
  ),
  'pdb-5i4r': bundle(
    rawPdb5i4rSemantic, rawPdb5i4rBackbone, rawPdb5i4rStructure, rawPdb5i4rMotion, 'pdb-5i4r', '5I4R',
  ),
  'pdb-1mbn-myoglobin': bundle(
    rawPdb1mbnMyoglobinSemantic, rawPdb1mbnMyoglobinBackbone, rawPdb1mbnMyoglobinStructure, rawPdb1mbnMyoglobinMotion, 'pdb-1mbn-myoglobin', '1MBN',
  ),
} as const satisfies Readonly<Record<string, ProteinAssetBundle>>;
