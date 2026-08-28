import * as assert from 'node:assert/strict';
import { test } from '../harness';
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
      atomResidues: [], backboneResidues: [], surfaceResidues: [], ribbonResidues: [], siteResidues: [], modificationResidues: [],
    },
    modes,
    display: { sampleHz: 60, collectiveGain: 0.5, localGain: 0.2 },
    amplitudeCalibration: 'b-factor-relative',
  };
}

/** Reference projection: mode displacements dotted with the controller's current coefficients, for every residue. */
function projectAllResidues(controller: ProteinMotionController, residueCount: number, asset: ProteinMotionAsset): Float32Array {
  const target = new Float32Array(residueCount * 4);
  controller.projectResidues(Array.from({ length: residueCount }, (_, index) => index), target);
  return target;
}

/** Naive reference projection built directly from the asset's raw mode displacements and the controller's coefficients. */
function projectFromAssetModes(coefficients: ArrayLike<number>, asset: ProteinMotionAsset, residueCount: number): Float32Array {
  const target = new Float32Array(residueCount * 4);
  for (let modeIndex = 0; modeIndex < asset.modes.length; modeIndex += 1) {
    const coefficient = coefficients[modeIndex] ?? 0;
    if (coefficient === 0) continue;
    const displacements = asset.modes[modeIndex]!.displacements;
    for (let residueIndex = 0; residueIndex < residueCount; residueIndex += 1) {
      const sourceOffset = residueIndex * 3;
      const outputOffset = residueIndex * 4;
      target[outputOffset] = target[outputOffset]! + coefficient * (displacements[sourceOffset] ?? 0);
      target[outputOffset + 1] = target[outputOffset + 1]! + coefficient * (displacements[sourceOffset + 1] ?? 0);
      target[outputOffset + 2] = target[outputOffset + 2]! + coefficient * (displacements[sourceOffset + 2] ?? 0);
    }
  }
  return target;
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
    const asset = assetFor(2);
    const controller = new ProteinMotionController(asset, 'protein-enemy-1');
    assert.deepEqual(PROTEIN_MOTION_LOD_MODE_COUNTS, { near: 24, medium: 12, far: 4, marker: 0 });
    const settleGap = PROTEIN_MOTION_LOD_FADE_DURATION_SEC + 0.01;

    // LOD 切替の直後、fade 時間より先の時刻でもう一度 update してクロスフェードを完了させ、
    // 確定した係数を読む。
    let time = 2.25;
    controller.update(time, 'near');
    assert.equal(controller.activeModeCount, 24);
    const near = projectAllResidues(controller, 2, asset);

    controller.update(time, 'medium');
    time += settleGap;
    controller.update(time, 'medium');
    assert.equal(controller.activeModeCount, 12);
    const medium = projectAllResidues(controller, 2, asset);

    controller.update(time, 'far');
    time += settleGap;
    controller.update(time, 'far');
    assert.equal(controller.activeModeCount, 4);
    const far = projectAllResidues(controller, 2, asset);

    controller.update(time, 'marker');
    time += settleGap;
    controller.update(time, 'marker');
    assert.equal(controller.activeModeCount, 0);
    assert.ok(controller.effectiveModeCoefficients.every((value) => value === 0));
    assert.ok(projectAllResidues(controller, 2, asset).every((value) => value === 0));
    assert.notDeepEqual([...near], [...medium]);
    assert.notDeepEqual([...medium], [...far]);
  });

  test('protein motion controller: LOD change cross-fades over PROTEIN_MOTION_LOD_FADE_DURATION_SEC instead of popping', () => {
    const asset = assetFor(2);
    const fading = new ProteinMotionController(asset, 'protein-enemy-fade');
    const reference = new ProteinMotionController(asset, 'protein-enemy-fade');

    fading.update(0, 'near');
    const before = [...fading.effectiveModeCoefficients];
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

    // 残基変位はモード係数の線形結合なので、フェード中の係数を投影した結果は
    // 残基空間でフェードした結果と厳密に一致するはず。
    const beforeResidues = projectFromAssetModes(before, asset, 2);
    const afterResidues = projectFromAssetModes(pureMediumAtHalfway, asset, 2);
    const halfwayResidues = new Float32Array(8);
    fading.projectResidues([0, 1], halfwayResidues);
    for (let index = 0; index < halfwayResidues.length; index += 1) {
      const expected = beforeResidues[index]! + (afterResidues[index]! - beforeResidues[index]!) * 0.5;
      assert.ok(Math.abs(halfwayResidues[index]! - expected) < 1e-3);
    }

    const settleTime = PROTEIN_MOTION_LOD_FADE_DURATION_SEC + 1;
    const settled = [...fading.update(settleTime, 'medium')];
    const pureMediumSettled = [...reference.update(settleTime, 'medium')];
    assert.deepEqual(settled, pureMediumSettled);
  });

  test('protein motion controller: critical phase applies display-only gain', () => {
    const asset = assetFor(2);
    const controller = new ProteinMotionController(asset, 'protein-enemy-critical');
    controller.update(2.25, 'near', 'intact');
    const intact = projectAllResidues(controller, 2, asset);
    controller.update(2.25, 'near', 'critical');
    const critical = projectAllResidues(controller, 2, asset);

    const gainRatio = PROTEIN_MOTION_PHASE_GAINS.critical / PROTEIN_MOTION_PHASE_GAINS.intact;
    for (let index = 0; index < intact.length; index += 1) {
      assert.ok(Math.abs(critical[index]! - intact[index]! * gainRatio) < 1e-6);
    }
  });

  test('protein motion controller: reuses coefficient buffers and projects only listed residues', () => {
    const controller = new ProteinMotionController(assetFor(3), 'protein-enemy-2');
    const coefficients = controller.modeCoefficients;
    const effective = controller.effectiveModeCoefficients;
    controller.update(0, 'near');
    controller.update(1.5, 'near');
    assert.strictEqual(controller.modeCoefficients, coefficients);
    assert.strictEqual(controller.effectiveModeCoefficients, effective);
    assert.equal(controller.modeCoefficients.length, 24);
    assert.equal(controller.effectiveModeCoefficients.length, 24);

    const target = new Float32Array(3 * 4);
    controller.projectResidues([1], target);
    assert.ok(target.slice(4, 7).some((value) => value !== 0), 'listed residue must be projected');
    assert.deepEqual([...target.slice(0, 4)], [0, 0, 0, 0], 'unlisted residue must stay untouched');
    assert.deepEqual([...target.slice(8, 12)], [0, 0, 0, 0], 'unlisted residue must stay untouched');

    // 非整数・範囲外の残基は無視する。
    target.fill(0);
    controller.projectResidues([-1, 3, 1.5, 1], target);
    assert.ok(target.slice(4, 7).some((value) => value !== 0));
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
    backward.seek(targetTime, 'near');

    assert.deepEqual([...sixtyHz.effectiveModeCoefficients], [...thirtyHz.effectiveModeCoefficients]);
    assert.deepEqual([...sixtyHz.effectiveModeCoefficients], [...backward.effectiveModeCoefficients]);
    assert.deepEqual(
      [...projectAllResidues(sixtyHz, 2, asset)],
      [...projectAllResidues(backward, 2, asset)],
    );
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
