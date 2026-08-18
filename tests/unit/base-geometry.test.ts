// 基地assemblyから導くドック境界と広域衝突半径の純粋テスト。
import * as assert from 'node:assert/strict';
import * as C from '../../src/game/const';
import { deriveCapsules } from '../../src/game/vessel/collision-shape';
import {
  baseAssemblyCollisionRadius,
  deriveBaseDockingPorts,
} from '../../src/game/vessel/base-geometry';
import { orbitalBaseAssembly } from '../../src/game/vessel/vessel-assemblies';
import { createPart, type BaseModulePart } from '../../src/game/game-entity/parts';
import { test } from '../physics/harness';

function baseModuleOf(assembly: ReturnType<typeof orbitalBaseAssembly>): BaseModulePart {
  const placement = assembly.placements.find((candidate) => candidate.part.type === 'base_module');
  assert.ok(placement);
  return placement.part as BaseModulePart;
}

export function register(): void {
  test('base geometry: base_module slots receive stable ids and preserve declared ports', () => {
    const assembly = orbitalBaseAssembly(C.BASE_MAX_HP);
    const module = baseModuleOf(assembly);
    const ports = deriveBaseDockingPorts(assembly, module);

    assert.equal(ports.slots.length, module.capacity);
    assert.deepEqual(ports.slots.map((port) => port.id), [
      `base-module:${module.id}:slot:0`,
      `base-module:${module.id}:slot:1`,
      `base-module:${module.id}:slot:2`,
      `base-module:${module.id}:slot:3`,
    ]);
    assert.equal(ports.hatch?.id, `base-module:${module.id}:hatch`);
    for (const port of ports.slots) {
      assert.ok(Math.abs(Math.hypot(port.localNormal.x, port.localNormal.y, port.localNormal.z) - 1) < 1e-12);
    }
  });

  test('base geometry: dock parts become stable ports when module slots are absent', () => {
    const source = orbitalBaseAssembly(C.BASE_MAX_HP);
    const module = baseModuleOf(source);
    const replacementModule: BaseModulePart = {
      ...module,
      dockSlots: [],
      capacity: 0,
    };
    const dock = createPart('dock', {
      id: 'dock-stable', name: 'Custom Dock', capacity: 2, maxVesselSize: 100,
      maxHp: 100, hp: 100, weight: 10, powerDraw: 0,
    });
    const assembly = {
      tree: source.tree,
      placements: [
        ...source.placements.filter((placement) => placement.part.type !== 'base_module'),
        { kind: 'internal' as const, part: replacementModule, edgeIds: ['fore'] },
        { kind: 'internal' as const, part: dock, edgeIds: ['fore'] },
      ],
    };
    const ports = deriveBaseDockingPorts(assembly, replacementModule);

    assert.equal(ports.slots.length, 2);
    assert.deepEqual(ports.slots.map((port) => port.id), [
      'dock:dock-stable:fore:0', 'dock:dock-stable:fore:1',
    ]);
    assert.notDeepEqual(ports.slots[0]!.localPos, ports.slots[1]!.localPos);
    assert.equal(ports.slots[0]!.maxVesselSize, 100);
  });

  test('base geometry: collision radius covers every custom assembly capsule', () => {
    const source = orbitalBaseAssembly(C.BASE_MAX_HP);
    const expanded = {
      tree: {
        ...source.tree,
        nodes: source.tree.nodes.map((node) => node.id === 'truss-l-tip'
          ? { ...node, pos: { ...node.pos, x: node.pos.x + 150 } }
          : node),
      },
      placements: source.placements,
    };
    const radius = baseAssemblyCollisionRadius(expanded);
    const originalRadius = baseAssemblyCollisionRadius(source);
    assert.ok(radius > originalRadius + 100);
    for (const capsule of deriveCapsules(expanded.tree)) {
      assert.ok(radius >= Math.hypot(capsule.a.x, capsule.a.y, capsule.a.z) + capsule.radius - 1e-9);
      assert.ok(radius >= Math.hypot(capsule.b.x, capsule.b.y, capsule.b.z) + capsule.radius - 1e-9);
    }
  });
}
