import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  PROTEIN_MOTION_LOD_FADE_DURATION_SEC,
  PROTEIN_MOTION_LOD_MODE_COUNTS,
  PROTEIN_MOTION_PHASE_GAINS,
  ProteinMotionController,
  proteinMotionLodForProjectedSize,
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
  test('protein motion: projected-size LOD selects near/medium/far/marker by screen diameter', () => {
    assert.equal(proteinMotionLodForProjectedSize(300, 'near'), 'near');
    assert.equal(proteinMotionLodForProjectedSize(60, 'near'), 'medium');
    assert.equal(proteinMotionLodForProjectedSize(20, 'medium'), 'far');
    assert.equal(proteinMotionLodForProjectedSize(4, 'far'), 'marker');
    assert.equal(proteinMotionLodForProjectedSize(1000, 'marker'), 'near');
  });

  test('protein motion: projected-size LOD applies hysteresis so a value inside the dead band holds', () => {
    // 140px は near(閾値160の-15%=136)と medium(閾値160の+15%=184)の不感帯に入る。
    assert.equal(proteinMotionLodForProjectedSize(140, 'near'), 'near');
    assert.equal(proteinMotionLodForProjectedSize(140, 'medium'), 'medium');
  });

  test('protein motion controller: applies 24/12/4/0 mode LODs and band gains', () => {
    const controller = new ProteinMotionController(assetFor(2), 'protein-enemy-1');
    assert.deepEqual(PROTEIN_MOTION_LOD_MODE_COUNTS, { near: 24, medium: 12, far: 4, marker: 0 });
    const settleGap = PROTEIN_MOTION_LOD_FADE_DURATION_SEC + 0.01;

    // LOD 切替の直後、fade 時間より先の時刻でもう一度 update してクロスフェードを完了させ、
    // 確定した変位を読む。
    let time = 2.25;
    controller.update(time, 'near');
    assert.equal(controller.activeModeCount, 24);
    const near = [...controller.residueOffsets];

    controller.update(time, 'medium');
    time += settleGap;
    controller.update(time, 'medium');
    assert.equal(controller.activeModeCount, 12);
    const medium = [...controller.residueOffsets];

    controller.update(time, 'far');
    time += settleGap;
    controller.update(time, 'far');
    assert.equal(controller.activeModeCount, 4);
    const far = [...controller.residueOffsets];

    controller.update(time, 'marker');
    time += settleGap;
    controller.update(time, 'marker');
    assert.equal(controller.activeModeCount, 0);
    assert.ok(controller.residueOffsets.every((value) => value === 0));
    assert.notDeepEqual(near, medium);
    assert.notDeepEqual(medium, far);
  });

  test('protein motion controller: LOD change cross-fades over PROTEIN_MOTION_LOD_FADE_DURATION_SEC instead of popping', () => {
    const asset = assetFor(2);
    const fading = new ProteinMotionController(asset, 'protein-enemy-fade');
    const reference = new ProteinMotionController(asset, 'protein-enemy-fade');

    fading.update(0, 'near');
    const before = [...fading.residueOffsets];
    const atSwitch = [...fading.update(0, 'medium')];
    assert.deepEqual(atSwitch, before);

    // reference は 'medium' へ切り替えて十分待たせ、以降は遷移なしの純粋な medium 目標値を返す。
    reference.update(0, 'medium');
    reference.update(1000, 'medium');

    const halfwayTime = PROTEIN_MOTION_LOD_FADE_DURATION_SEC / 2;
    const halfway = [...fading.update(halfwayTime, 'medium')];
    const pureMediumAtHalfway = [...reference.update(halfwayTime, 'medium')];
    for (let index = 0; index < before.length; index += 1) {
      const expected = before[index]! + (pureMediumAtHalfway[index]! - before[index]!) * 0.5;
      assert.ok(Math.abs(halfway[index]! - expected) < 1e-4);
    }

    const settleTime = PROTEIN_MOTION_LOD_FADE_DURATION_SEC + 1;
    const settled = [...fading.update(settleTime, 'medium')];
    const pureMediumSettled = [...reference.update(settleTime, 'medium')];
    assert.deepEqual(settled, pureMediumSettled);
  });

  test('protein motion controller: critical phase applies display-only gain', () => {
    const controller = new ProteinMotionController(assetFor(2), 'protein-enemy-critical');
    controller.update(2.25, 'near', 'intact');
    const intact = [...controller.residueOffsets];
    controller.update(2.25, 'near', 'critical');
    const critical = [...controller.residueOffsets];

    assert.equal(PROTEIN_MOTION_PHASE_GAINS.intact, 1);
    assert.equal(PROTEIN_MOTION_PHASE_GAINS.critical, 1.5);
    for (let index = 0; index < intact.length; index += 1) {
      assert.ok(Math.abs(critical[index]! - intact[index]! * 1.5) < 1e-6);
    }
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
