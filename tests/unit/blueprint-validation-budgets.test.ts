// 設計の収支検証(§4.C): 電力・廃熱・姿勢制御の縮退。part-inventory.ts の既存の合計と
// attitude-control.ts の既存の配分をそのまま使うので、ここでは既定の有人艦の設計を土台に
// 収支を崩す/アクチュエータを間引くことで、その組み合わせが正しく指摘に落ちることだけを確かめる。
import * as assert from 'node:assert/strict';
import { createPart } from '../../src/game/game-entity/parts';
import type { AnyPart } from '../../src/game/game-entity/parts';
import type { PartPlacement } from '../../src/game/vessel/assembly';
import { crewedAssembly } from '../../src/game/vessel/vessel-assemblies';
import type { VesselBlueprint } from '../../src/game/vessel/blueprint';
import { createBlueprint } from '../../src/game/vessel/blueprint';
import type { BlueprintIssue } from '../../src/game/vessel/blueprint-validation';
import { validateBlueprint } from '../../src/game/vessel/blueprint-validation';
import { test } from '../physics/harness';

function part(type: Parameters<typeof createPart>[0], props: object): AnyPart {
  return createPart(type, { maxHp: 10, hp: 10, ...props } as never);
}

// 既定の有人艦の設計。加圧式の主機に加圧ガスタンクを足して成り立たせる(blueprint-validation.test.ts と同じ)。
function baseBlueprint(): VesselBlueprint {
  const assembly = crewedAssembly(1000);
  const pressurant: PartPlacement = {
    kind: 'internal',
    part: part('pressurant_tank', { name: 'Pressurant Tank', weight: 20, volume: 0.2, maxPressure: 30, gas: 'nitrogen' }),
    edgeIds: ['mid'],
  };
  return createBlueprint({
    id: 'bp-base', name: '試験機', tree: assembly.tree, placements: [...assembly.placements, pressurant], now: 1000,
  });
}

function withPlacements(bp: VesselBlueprint, placements: readonly PartPlacement[]): VesselBlueprint {
  return { ...bp, placements };
}

function without(bp: VesselBlueprint, ...types: readonly string[]): VesselBlueprint {
  return withPlacements(bp, bp.placements.filter((p) => !types.includes(p.part.type)));
}

function messages(issues: readonly BlueprintIssue[]): string {
  return issues.map((i) => `${i.severity} ${i.targetId}: ${i.message}`).join(' | ');
}

function assertIssue(
  issues: readonly BlueprintIssue[],
  severity: BlueprintIssue['severity'],
  ...needles: readonly string[]
): void {
  const hit = issues.some((i) =>
    i.severity === severity && needles.every((n) => i.message.includes(n) || i.targetId === n));
  assert.ok(hit, `期待した ${severity} の指摘が出ていない (${needles.join(', ')}): ${messages(issues)}`);
}

export function register(): void {
  test('blueprint budgets: 既定の有人艦の設計は収支の指摘を持たない', () => {
    assert.deepEqual(validateBlueprint(baseBlueprint()), []);
  });

  test('blueprint budgets: 消費電力が発電量を上回ると警告になる', () => {
    const bp = baseBlueprint();
    const overdraw: PartPlacement = {
      kind: 'internal',
      part: part('magnetorquer', { name: 'Overdraw', weight: 5, maxMagneticMoment: 0, powerDraw: 1e7 }),
      edgeIds: ['mid'],
    };
    const issues = validateBlueprint(withPlacements(bp, [...bp.placements, overdraw]));
    assertIssue(issues, 'warning', '発電量');
  });

  test('blueprint budgets: 廃熱が外殻温度の上限での放熱能力を上回ると警告になる', () => {
    const bp = baseBlueprint();
    const furnace: PartPlacement = {
      kind: 'internal',
      part: part('life_support', {
        name: 'Furnace', weight: 5, crewCapacity: 1, powerDraw: 0, consumableRate: 0, extraWasteHeat: 1e8,
      }),
      edgeIds: ['mid'],
    };
    const issues = validateBlueprint(withPlacements(bp, [...bp.placements, furnace]));
    assertIssue(issues, 'warning', '放熱能力');
  });

  test('blueprint budgets: アクチュエータを1つも積んでいないと姿勢制御が指摘される', () => {
    const bp = without(baseBlueprint(), 'rcs_thruster', 'flywheel', 'magnetorquer');
    const issues = validateBlueprint(bp);
    assertIssue(issues, 'error', '姿勢制御ができない軸があります');
  });

  // RCSスラスタを1基だけ残すと、それ単独では3軸を賄いきれず、フライホイール1基がその不足を
  // 埋めている構成になる — フライホイールを失う指摘が出て当然だが、フライホイール自体を
  // 外すと(2つとも欠けるので)全く姿勢制御できない設計になる、という2つの段階を確かめる。
  test('blueprint budgets: RCSスラスタが1基だけだと、フライホイールを失う指摘が出る', () => {
    const bp = baseBlueprint();
    const thrusters = bp.placements.filter((p) => p.part.type === 'rcs_thruster');
    const kept = thrusters[0]!;
    const thin = withPlacements(bp, bp.placements.filter((p) => p.part.type !== 'rcs_thruster' || p === kept));
    const flywheel = thin.placements.find((p) => p.part.type === 'flywheel')!.part;

    assertIssue(validateBlueprint(thin), 'warning', flywheel.id);

    const noWheel = without(thin, 'flywheel');
    assertIssue(validateBlueprint(noWheel), 'error', '姿勢制御ができない軸があります');
  });
}
