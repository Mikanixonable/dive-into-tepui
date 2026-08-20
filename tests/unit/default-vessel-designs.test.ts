// 既定の有人艦・軌道基地が搭載する推進系(主タンク・配管・加圧ガスタンク)まで含めて、
// 設計として成り立つことの回帰テスト(第12版 主推進系の搭載計画 R3/R4)。
import * as assert from 'node:assert/strict';
import { crewedAssembly, orbitalBaseAssembly } from '../../src/game/vessel/vessel-assemblies';
import { createBlueprint } from '../../src/game/vessel/blueprint';
import type { BlueprintLimits } from '../../src/game/vessel/blueprint-validation';
import { DEFAULT_BLUEPRINT_LIMITS, validateBlueprint } from '../../src/game/vessel/blueprint-validation';
import { test } from '../physics/harness';

// 軌道基地は艦艇用の寸法・質量の上限(DEFAULT_BLUEPRINT_LIMITS)を素で超える大きさの構造物で
// あり、それは推進系の有無とは無関係な既存の事実。ここで確かめたいのは推進系そのものの
// 成立(配管の連結・タンク材料・内容積・加圧)なので、寸法・質量の上限だけ大きく緩める。
const BASE_LIMITS: BlueprintLimits = { ...DEFAULT_BLUEPRINT_LIMITS, maxMass: 2e7, maxDimension: 200 };

export function register(): void {
  test('既定の有人艦と軌道基地は、主機の推進系まで含めて設計として成り立つ', () => {
    const crewed = crewedAssembly(1000);
    const crewedBp = createBlueprint({
      id: 'default-crewed', name: '有人艦', tree: crewed.tree, placements: crewed.placements, now: 0,
    });
    const crewedErrors = validateBlueprint(crewedBp).filter((i) => i.severity === 'error');
    assert.deepEqual(crewedErrors, [], JSON.stringify(crewedErrors));

    const base = orbitalBaseAssembly(1000);
    const baseBp = createBlueprint({
      id: 'default-base', name: '軌道基地', tree: base.tree, placements: base.placements, now: 0,
    });
    const baseErrors = validateBlueprint(baseBp, BASE_LIMITS).filter((i) => i.severity === 'error');
    assert.deepEqual(baseErrors, [], JSON.stringify(baseErrors));
  });
}
