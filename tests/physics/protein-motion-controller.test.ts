import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  PROTEIN_MOTION_LOD_MODE_COUNTS,
  ProteinMotionController,
  proteinMotionLodForDistance,
  proteinMotionUpdatePhaseFor,
} from '../../src/game/protein/protein-motion-controller';
import type { ProteinMotionAsset } from '../../src/game/protein/protein-schema';

function assetFor(residueCount: number, modeCount = 24): ProteinMotionAsset {
  const modes = Array.from({ length: modeCount }, (_, modeIndex) => {
    const displacements = new Float32Array(residueCount * 3);
    for (let residueIndex = 0; residueIndex < residueCount; residueIndex += 1) {
      const offset = residueIndex * 3;
      displacements[offset] = (modeIndex + 1) * (residueIndex + 1);
      displacements[offset + 1] = modeIndex % 2;
      displacements[offset + 2] = -residueIndex;
    }
    return {
      id: `mode-${modeIndex}`,
      band: modeIndex < 4 ? 'collective' as const : 'local' as const,
      eigenvalue: 0.1 + modeIndex,
      displayRelaxationRate: 0.4 + modeIndex * 0.2,
      physicalRmsAngstrom: 0.05 + modeIndex * 0.005,
      displacements: Array.from(displacements),
    };
  });
  return {
    schemaVersion: 1,
    model: 'c-alpha-anm-overdamped',
    source: {
      pdbId: 'TEST', structureHash: 'structure', backboneHash: 'backbone',
      generatorVersion: 1, cutoffAngstrom: 10,
    },
    residueCount,
    residues: {
      chains: Array.from({ length: residueCount }, () => 'A'),
      residueNumbers: Array.from({ length: residueCount }, (_, index) => index + 1),
      centers: Array.from({ length: residueCount * 3 }, () => 0),
      bFactors: Array.from({ length: residueCount }, () => 1),
    },
    bindings: {
      atomResidues: [], backboneResidues: [], surfaceResidues: [], siteResidues: [], modificationResidues: [],
    },
    modes,
    display: { sampleHz: 60, collectiveGain: 0.5, localGain: 0.2 },
    amplitudeCalibration: 'b-factor-relative',
  };
}

export function register(): void {
  test('protein motion: distance LOD selects near/medium/far/marker without changing collision inputs', () => {
    assert.equal(proteinMotionLodForDistance(10, 1), 'near');
    assert.equal(proteinMotionLodForDistance(24, 1), 'near');
    assert.equal(proteinMotionLodForDistance(25, 1), 'medium');
    assert.equal(proteinMotionLodForDistance(96, 1), 'medium');
    assert.equal(proteinMotionLodForDistance(97, 1), 'far');
    assert.equal(proteinMotionLodForDistance(384, 1), 'far');
    assert.equal(proteinMotionLodForDistance(385, 1), 'marker');
  });

  test('protein motion controller: applies 24/12/4/0 mode LODs and band gains', () => {
    const controller = new ProteinMotionController(assetFor(2), 'protein-enemy-1');
    assert.deepEqual(PROTEIN_MOTION_LOD_MODE_COUNTS, { near: 24, medium: 12, far: 4, marker: 0 });

    controller.update(2.25, 'near');
    assert.equal(controller.activeModeCount, 24);
    const near = [...controller.residueOffsets];
    controller.update(2.25, 'medium');
    assert.equal(controller.activeModeCount, 12);
    const medium = [...controller.residueOffsets];
    controller.update(2.25, 'far');
    assert.equal(controller.activeModeCount, 4);
    const far = [...controller.residueOffsets];
    controller.update(2.25, 'marker');
    assert.equal(controller.activeModeCount, 0);
    assert.ok(controller.residueOffsets.every((value) => value === 0));
    assert.notDeepEqual(near, medium);
    assert.notDeepEqual(medium, far);
  });

  test('protein motion controller: reuses coefficient and residue buffers', () => {
    const controller = new ProteinMotionController(assetFor(3), 'protein-enemy-2');
    const coefficients = controller.modeCoefficients;
    const offsets = controller.residueOffsets;
    controller.update(0, 'near');
    controller.update(1.5, 'near');
    assert.strictEqual(controller.modeCoefficients, coefficients);
    assert.strictEqual(controller.residueOffsets, offsets);
    assert.equal(controller.modeCoefficients.length, 24);
    assert.equal(controller.residueOffsets.length, 3 * 4);
  });

  test('protein motion controller: direct seek is deterministic across frame rates and direction', () => {
    const asset = assetFor(2);
    const sixtyHz = new ProteinMotionController(asset, 'protein-enemy-seek');
    const thirtyHz = new ProteinMotionController(asset, 'protein-enemy-seek');
    const backward = new ProteinMotionController(asset, 'protein-enemy-seek');
    const targetTime = 12.375;

    sixtyHz.update(0, 'near');
    for (let frame = 1; frame <= 60 * targetTime; frame += 1) {
      sixtyHz.update(frame / 60, 'near');
    }
    sixtyHz.update(targetTime, 'near');
    thirtyHz.update(0, 'near');
    for (let frame = 1; frame <= 30 * targetTime; frame += 1) {
      thirtyHz.update(frame / 30, 'near');
    }
    thirtyHz.update(targetTime, 'near');
    backward.update(100, 'near');
    backward.update(2, 'near');

    assert.deepEqual([...sixtyHz.residueOffsets], [...thirtyHz.residueOffsets]);
    assert.deepEqual([...sixtyHz.residueOffsets], [...backward.seek(targetTime, 'near')]);
  });

  test('protein motion controller: enemy IDs have stable, distinct update phases', () => {
    const first = proteinMotionUpdatePhaseFor('protein-enemy-a');
    const repeat = proteinMotionUpdatePhaseFor('protein-enemy-a');
    const second = proteinMotionUpdatePhaseFor('protein-enemy-b');
    assert.equal(first, repeat);
    assert.notEqual(first, second);
    assert.ok(first >= 0 && first < 1);
    assert.ok(second >= 0 && second < 1);
  });
}
