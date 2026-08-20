// baseInvariants の継続性チェック(基地モジュールの同一性・収容中の艦のドック口)の純粋テスト。
import * as assert from 'node:assert/strict';
import * as C from '../../src/game/const';
import { baseInvariants, type BaseModuleContinuity } from '../../src/game/vessel/base-assembly-validation';
import { deriveBaseDockingPorts } from '../../src/game/vessel/base-geometry';
import { orbitalBaseAssembly } from '../../src/game/vessel/vessel-assemblies';
import type { BaseModulePart } from '../../src/game/game-entity/parts';
import type { VesselAssembly } from '../../src/game/vessel/assembly';
import { v3 } from '../../src/physics/vec3';
import { test } from '../physics/harness';

function baseModuleOf(assembly: VesselAssembly): BaseModulePart {
  const placement = assembly.placements.find((candidate) => candidate.part.type === 'base_module');
  assert.ok(placement);
  return placement.part as BaseModulePart;
}

function withModule(assembly: VesselAssembly, module: BaseModulePart): VesselAssembly {
  return {
    tree: assembly.tree,
    placements: assembly.placements.map((placement) =>
      placement.part.type === 'base_module' ? { ...placement, part: module } : placement),
  };
}

export function register(): void {
  test('baseInvariants: continuity なしなら、モジュールID差し替え・ドック口移動を拒まない', () => {
    const assembly = orbitalBaseAssembly(C.BASE_MAX_HP);
    const module = baseModuleOf(assembly);
    const edited = withModule(assembly, { ...module, id: 'different-module-id' });

    assert.deepEqual(baseInvariants(edited, 1, null), []);
  });

  test('baseInvariants: continuity ありでモジュールIDが変わると拒む', () => {
    const assembly = orbitalBaseAssembly(C.BASE_MAX_HP);
    const module = baseModuleOf(assembly);
    const continuity: BaseModuleContinuity = { moduleId: module.id, occupiedPorts: new Map() };
    const edited = withModule(assembly, { ...module, id: 'different-module-id' });

    const issues = baseInvariants(edited, 0, continuity);
    assert.ok(issues.some((issue) => issue.includes('基地モジュールのIDは変更できません')));
  });

  test('baseInvariants: 収容中のドック口が動くと拒み、空きドック口が動くのは拒まない', () => {
    const assembly = orbitalBaseAssembly(C.BASE_MAX_HP);
    const module = baseModuleOf(assembly);
    const ports = deriveBaseDockingPorts(assembly, module).slots;
    assert.ok(ports.length >= 2);
    const continuity: BaseModuleContinuity = {
      moduleId: module.id,
      occupiedPorts: new Map([[0, ports[0]!]]),
    };

    // 収容中のスロット0を動かす —— 拒まれる。
    const movedOccupied = withModule(assembly, {
      ...module,
      dockSlots: module.dockSlots.map((port, i) =>
        i === 0 ? { ...port, localPos: v3(port.localPos.x + 100, port.localPos.y, port.localPos.z) } : port),
    });
    const occupiedIssues = baseInvariants(movedOccupied, 1, continuity);
    assert.ok(occupiedIssues.some((issue) => issue.includes('ドック 1 は船が収容中のため変更できません')));

    // 空いているスロット1を動かす —— 拒まれない。
    const movedFree = withModule(assembly, {
      ...module,
      dockSlots: module.dockSlots.map((port, i) =>
        i === 1 ? { ...port, localPos: v3(port.localPos.x + 100, port.localPos.y, port.localPos.z) } : port),
    });
    const freeIssues = baseInvariants(movedFree, 1, continuity);
    assert.ok(!freeIssues.some((issue) => issue.includes('ドック')));
  });

  test('baseInvariants: continuity ありでも構成が変わらなければ何も拒まない', () => {
    const assembly = orbitalBaseAssembly(C.BASE_MAX_HP);
    const module = baseModuleOf(assembly);
    const ports = deriveBaseDockingPorts(assembly, module).slots;
    const continuity: BaseModuleContinuity = {
      moduleId: module.id,
      occupiedPorts: new Map([[0, ports[0]!], [1, ports[1]!]]),
    };

    assert.deepEqual(baseInvariants(assembly, 2, continuity), []);
  });

  test('baseInvariants: 稼働中の base_module を持たない構成は continuity の有無に関わらず拒む', () => {
    const assembly = orbitalBaseAssembly(C.BASE_MAX_HP);
    const stripped: VesselAssembly = {
      tree: assembly.tree,
      placements: assembly.placements.filter((placement) => placement.part.type !== 'base_module'),
    };

    const issues = baseInvariants(stripped, 0, null);
    assert.ok(issues.some((issue) => issue.includes('base_module がちょうど1つ必要です')));
  });
}
