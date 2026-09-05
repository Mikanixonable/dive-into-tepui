// Generated from assets-src/proteins/*/protein.config.json.
// Run npm run protein:catalog after adding or renaming a protein asset.
import rawPdb8rucRubiscoSemantic from '../../assets/models/rubisco8rucProtein.json';
import rawPdb8rucRubiscoBackboneUrl from '../../assets/models/rubisco8rucBackbone.json';
import rawPdb8rucRubiscoStructureUrl from '../../assets/models/rubisco8rucStructure.json';
import rawPdb8rucRubiscoMotionUrl from '../../assets/models/rubisco8rucMotion.json';
import rawPdb6n2yAtpSynthaseSemantic from '../../assets/models/atpSynthase6n2yProtein.json';
import rawPdb6n2yAtpSynthaseBackboneUrl from '../../assets/models/atpSynthase6n2yBackbone.json';
import rawPdb6n2yAtpSynthaseStructureUrl from '../../assets/models/atpSynthase6n2yStructure.json';
import rawPdb6n2yAtpSynthaseMotionUrl from '../../assets/models/atpSynthase6n2yMotion.json';
import rawPdb5i4rSemantic from '../../assets/models/pdb5i4rProtein.json';
import rawPdb5i4rBackboneUrl from '../../assets/models/pdb5i4rBackbone.json';
import rawPdb5i4rStructureUrl from '../../assets/models/pdb5i4rStructure.json';
import rawPdb5i4rMotionUrl from '../../assets/models/pdb5i4rMotion.json';
import rawPdb1mbnMyoglobinSemantic from '../../assets/models/myoglobin1mbnProtein.json';
import rawPdb1mbnMyoglobinBackboneUrl from '../../assets/models/myoglobin1mbnBackbone.json';
import rawPdb1mbnMyoglobinStructureUrl from '../../assets/models/myoglobin1mbnStructure.json';
import rawPdb1mbnMyoglobinMotionUrl from '../../assets/models/myoglobin1mbnMotion.json';
import type { ProteinAssetDefinition } from './protein-schema';
import type { ProteinAssetSource } from './protein-asset-loader';

export const PROTEIN_ASSET_SOURCES = {
  'pdb-8ruc-rubisco': {
    semantic: rawPdb8rucRubiscoSemantic as unknown as ProteinAssetDefinition,
    backboneUrl: rawPdb8rucRubiscoBackboneUrl as unknown as string,
    structureUrl: rawPdb8rucRubiscoStructureUrl as unknown as string,
    motionUrl: rawPdb8rucRubiscoMotionUrl as unknown as string,
    expectedId: 'pdb-8ruc-rubisco',
    expectedPdbId: '8RUC',
  },
  'pdb-6n2y-atp-synthase': {
    semantic: rawPdb6n2yAtpSynthaseSemantic as unknown as ProteinAssetDefinition,
    backboneUrl: rawPdb6n2yAtpSynthaseBackboneUrl as unknown as string,
    structureUrl: rawPdb6n2yAtpSynthaseStructureUrl as unknown as string,
    motionUrl: rawPdb6n2yAtpSynthaseMotionUrl as unknown as string,
    expectedId: 'pdb-6n2y-atp-synthase',
    expectedPdbId: '6N2Y',
  },
  'pdb-5i4r': {
    semantic: rawPdb5i4rSemantic as unknown as ProteinAssetDefinition,
    backboneUrl: rawPdb5i4rBackboneUrl as unknown as string,
    structureUrl: rawPdb5i4rStructureUrl as unknown as string,
    motionUrl: rawPdb5i4rMotionUrl as unknown as string,
    expectedId: 'pdb-5i4r',
    expectedPdbId: '5I4R',
  },
  'pdb-1mbn-myoglobin': {
    semantic: rawPdb1mbnMyoglobinSemantic as unknown as ProteinAssetDefinition,
    backboneUrl: rawPdb1mbnMyoglobinBackboneUrl as unknown as string,
    structureUrl: rawPdb1mbnMyoglobinStructureUrl as unknown as string,
    motionUrl: rawPdb1mbnMyoglobinMotionUrl as unknown as string,
    expectedId: 'pdb-1mbn-myoglobin',
    expectedPdbId: '1MBN',
  },
} as const satisfies Readonly<Record<string, ProteinAssetSource>>;
