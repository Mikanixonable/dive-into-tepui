// 既定の有人艦・軌道基地が搭載する推進系(主タンク・配管・加圧ガスタンク)まで含めて、
// 設計として成り立つことの回帰テスト(第12版 主推進系の搭載計画 R3/R4)。
import * as assert from 'node:assert/strict';
import { crewedAssembly, orbitalBaseAssembly } from '../../src/game/vessel/vessel-assemblies';
import { createBlueprint } from '../../src/game/vessel/blueprint';
import { validateBlueprint } from '../../src/game/vessel/blueprint-validation';
import { BASE_BLUEPRINT_LIMITS } from '../../src/game/vessel/base-assembly-validation';
import { test } from '../physics/harness';

export function register(): void {
  test('既定の有人艦と軌道基地は、主機の推進系まで含めて設計として成り立つ', () => {
    const crewed = crewedAssembly(1000);
    const crewedBp = createBlueprint({
      id: 'default-crewed', name: '有人艦', tree: crewed.tree, placements: crewed.placements, now: 0,
    });
    const crewedErrors = validateBlueprint(crewedBp).filter((i) => i.severity === 'error');
    assert.deepEqual(crewedErrors, [], JSON.stringify(crewedErrors));

    // 基地は組み立て(docking.ts)で実際に使われる BASE_BLUEPRINT_LIMITS で検証する
    // (艦艇用の DEFAULT_BLUEPRINT_LIMITS は基地の大きさを元から想定していない)。
    const base = orbitalBaseAssembly(1000);
    const baseBp = createBlueprint({
      id: 'default-base', name: '軌道基地', tree: base.tree, placements: base.placements, now: 0,
    });
    const baseErrors = validateBlueprint(baseBp, BASE_BLUEPRINT_LIMITS).filter((i) => i.severity === 'error');
    assert.deepEqual(baseErrors, [], JSON.stringify(baseErrors));
  });
}
