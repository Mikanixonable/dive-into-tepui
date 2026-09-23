import * as assert from 'node:assert/strict';
import { qFromUnitVectors, qRotate, LOCAL_FORWARD, LOCAL_UP } from '../../src/math/quat';
import { add, scale, v3 } from '../../src/math/vec3';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { ShipCapabilities } from '../../src/game/ship/ship-capabilities';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { createBasePreset, createDefaultCombatPreset } from '../../src/game/ship/ship-presets';
import { shipRenderAssembly } from '../../src/game/ship/ship-render-adapter';
import { restoreShipAssembly } from '../../src/game/ship/ship-save';
import { sameTransform, sideSlotRotation } from '../../src/game/ship/ship-assembly-transform';
import { test } from '../harness';

function module(definitionId: string, id: string, state = {}) {
  return createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), id, state);
}

export function register(): void {
  test('ship assembly: 既定戦闘船は既存の HP と性能、質量を保つ', () => {
    const assembly = createDefaultCombatPreset();
    const totals = assembly.totals();
    assert.equal(assembly.role, 'ship');
    assert.equal(totals.hp, 1_000);
    assert.equal(totals.maxHp, 1_000);
    assert.equal(totals.thrust, 400_000);
    assert.equal(totals.torque, 24_000);
    assert.equal(totals.power, 1_650);
    assert.equal(totals.radiation, 9.6);
    assert.equal(totals.weaponDamage, 1);
    assert.equal(totals.fireRate, 1 / 0.06);
    assert.equal(totals.muzzleVelocity, 1_000);
    assert.equal(totals.mainFuel, 1_000);
    assert.equal(totals.mass, 1_000);
    assert.equal(totals.dryMass, 400);
    assert.equal(assembly.validate().valid, true);
  });

  test('ship render adapter: assembly state and world transforms become display input', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(module('cockpit-standard', 'cockpit', { hp: 40 }));
    assembly.append(module('tank-3-main', 'tank'));
    assembly.connectSide(module('radiator-standard', 'radiator', { deployed: 1 }), 'cockpit', 'side:+x');

    const rendered = shipRenderAssembly(assembly).modules;
    const cockpit = rendered.find(item => item.id === 'cockpit');
    const tank = rendered.find(item => item.id === 'tank');
    const radiator = rendered.find(item => item.id === 'radiator');
    assert.ok(cockpit !== undefined && tank !== undefined && radiator !== undefined);
    assert.equal(cockpit.modelId, 'cockpit-standard');
    assert.equal(cockpit.hp, 40);
    assert.equal(cockpit.maxHp, 100);
    assert.equal(tank.transform.position.z, -3);
    assert.equal(radiator.transform.position.x, 3.5);
    assert.equal(radiator.deployed, 1);
  });

  test('ship assembly: -Z append は端面を隙間なく接続する', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(module('cockpit-standard', 'root'));
    assembly.append(module('tank-12-main', 'tank'));
    const edge = assembly.graph[0];
    assert.ok(edge !== undefined);
    assert.equal(edge.kind, 'axial');
    assert.equal(edge.childTransform.position.x, 0);
    assert.equal(edge.childTransform.position.y, 0);
    assert.equal(edge.childTransform.position.z, -7.5);
    const tankTransform = assembly.worldTransformOf('tank');
    assert.ok(tankTransform !== null);
    assert.equal(tankTransform.position.z, -7.5);
    assert.equal(assembly.validate().valid, true);
  });

  test('ship assembly: 側面接続は明示 transform を保持する', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(module('cockpit-standard', 'root'));
    const transform = { position: v3(0, 3.5, 0), rotation: qFromUnitVectors(LOCAL_FORWARD, v3(0, 1, 0)) };
    assembly.connectSide(module('dock-standard', 'dock'), 'root', transform, 'side-edge');
    assert.deepEqual(assembly.transformOf('dock'), transform);
    const sideEdge = assembly.graph[0];
    assert.ok(sideEdge !== undefined);
    assert.equal(sideEdge.id, 'side-edge');
  });

  test('ship assembly: side slot は parent/child 寸法から配置を導出し、module を差し替えられる', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(module('tank-6-main', 'tank'));
    assembly.connectSide(module('solar-panel-standard', 'solar'), 'tank', 'side:+y');
    const transform = assembly.transformOf('solar');
    const edge = assembly.graph[0];
    assert.ok(transform !== null && edge !== undefined);
    assert.equal(edge.sideSlot, 'side:+y');
    assert.deepEqual(transform.position, v3(0, 3.5, 0));
    const forward = qRotate(transform.rotation, LOCAL_FORWARD);
    assert.ok(Math.hypot(forward.x, forward.y - 1, forward.z) < 1e-9);
    assert.equal(assembly.validate().valid, true);

    const relocated = new ShipAssembly();
    relocated.addRoot(module('tank-6-main', 'tank'));
    relocated.connectSide(module('radiator-standard', 'radiator'), 'tank', 'side:-x');
    const relocatedTransform = relocated.transformOf('radiator');
    assert.ok(relocatedTransform !== null);
    assert.deepEqual(relocatedTransform.position, v3(-3.5, 0, 0));
    assert.equal(relocated.validate().valid, true);
  });

  test('ship assembly: 建造枝は docking edge と別の建造接続へ確定する', () => {
    const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
    assembly.addRoot(module('cockpit-standard', 'cockpit'));
    assembly.connectSide(module('dock-standard', 'dock'), 'cockpit', {
      position: v3(3.5, 0, 0), rotation: qFromUnitVectors(LOCAL_FORWARD, v3(1, 0, 0)),
    });
    assembly.addModule(module('tank-3-main', 'construction-tank'), 'dock', {
      position: v3(0, 0, 2), rotation: { x: 0, y: 0, z: 0, w: 1 },
    }, 'axial', 'construction-edge');

    assembly.completeConstructionConnection('construction-edge');

    assert.equal(assembly.dockingConnections().length, 0);
    assert.equal(assembly.constructionConnections()[0]?.id, 'construction-edge');
    assert.equal(assembly.isDockingPortOccupied('dock'), false);
    assert.equal(assembly.isPortConnected('dock'), true);
    assert.equal(assembly.graph.find(edge => edge.id === 'construction-edge')?.kind, 'construction');
    assert.equal(assembly.validate().valid, true);
  });

  test('ship assembly: docking edge は接舷面を一致させ、重複IDを安定名へ写す', () => {
    const host = new ShipAssembly(SHIP_MODULE_CATALOG, true);
    host.addRoot(module('cockpit-standard', 'cockpit'));
    host.append(module('dock-standard', 'dock'));
    const guest = new ShipAssembly(SHIP_MODULE_CATALOG, true);
    guest.addRoot(module('docking-port-standard', 'port'));
    guest.append(module('cockpit-standard', 'cockpit'));
    const merged = host.mergedAtDock(guest, 'dock', 'port', 'guest');
    assert.equal(merged.moduleIds.get('cockpit'), 'guest:cockpit');
    assert.equal(merged.assembly.validate().valid, true);
    assert.equal(merged.assembly.graph.find(edge => edge.id === merged.connectionId)?.kind, 'docking');
    const hostTransform = merged.assembly.worldTransformOf('dock');
    const guestTransform = merged.assembly.worldTransformOf('port');
    assert.ok(hostTransform !== null && guestTransform !== null);
    const hostPoint = add(hostTransform.position, scale(qRotate(hostTransform.rotation, LOCAL_FORWARD), 0.5));
    const guestPoint = add(guestTransform.position, scale(qRotate(guestTransform.rotation, LOCAL_FORWARD), 0.5));
    assert.ok(Math.hypot(
      hostPoint.x - guestPoint.x, hostPoint.y - guestPoint.y, hostPoint.z - guestPoint.z,
    ) < 1e-9);
    const hostUp = qRotate(hostTransform.rotation, LOCAL_UP);
    const guestUp = qRotate(guestTransform.rotation, LOCAL_UP);
    assert.ok(Math.hypot(hostUp.x - guestUp.x, hostUp.y - guestUp.y, hostUp.z - guestUp.z) < 1e-9);
    const [retained, detached] = merged.assembly.splitAt(merged.connectionId);
    assert.ok(retained.module('dock'));
    assert.ok(detached.module('port'));
    assert.equal(retained.isDockingPortOccupied('dock'), false);
    assert.equal(detached.isDockingPortOccupied('port'), false);
  });

  test('ship assembly: role は健全 cockpit と dock だけから導出し booster では変わらない', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(module('booster-standard', 'booster'));
    assert.equal(assembly.role, 'material');
    assembly.append(module('cockpit-standard', 'cockpit'));
    assert.equal(assembly.role, 'ship');
    assembly.connectSide(module('dock-standard', 'dock'), 'cockpit', { position: v3(3.5, 0, 0), rotation: qFromUnitVectors(LOCAL_FORWARD, v3(1, 0, 0)) });
    assert.equal(assembly.role, 'base');
    assembly.damage(200, 1, 'cockpit');
    assert.equal(assembly.role, 'material');
  });

  test('ship assembly: clone は module state を共有せず split は元を消費する', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(module('cockpit-standard', 'a'));
    assembly.append(module('tank-3-main', 'b', { fuel: 10 }));
    assembly.append(module('thruster-standard', 'c'));
    const clone = assembly.clone();
    clone.damage(10, 1, 'a');
    const moduleA = assembly.module('a');
    const splitEdge = assembly.graph[1];
    assert.ok(moduleA !== null && splitEdge !== undefined);
    assert.equal(moduleA.hp, 100);
    const [left, right] = assembly.splitAt(splitEdge.id);
    assert.deepEqual(left.moduleIds, ['a', 'b']);
    assert.deepEqual(right.moduleIds, ['c']);
    assert.equal(assembly.size, 0);
    const leftTank = left.module('b');
    assert.ok(leftTank !== null);
    assert.equal(leftTank.kind, 'tank');
    assert.equal(right.validate().valid, true);
  });

  test('ship assembly: base preset は必要な側面 dock 2個を持つ', () => {
    const assembly = createBasePreset();
    assert.equal(assembly.role, 'base');
    assert.equal(assembly.modules.filter(module => module.kind === 'dock').length, 2);
    assert.equal(assembly.modules.filter(module => module.kind === 'tank').length, 2);
    assert.equal(assembly.modules.filter(module => module.kind === 'solar_panel').length, 2);
    assert.equal(assembly.modules.filter(module => module.kind === 'radiator').length, 2);
    assert.equal(assembly.validate().valid, true);
  });

  test('ship assembly: 取り出した modules は内部 state を変更しない', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(module('cockpit-standard', 'cockpit'));
    const listed = assembly.modules;
    const listedCockpit = listed[0];
    const cockpit = assembly.module('cockpit');
    assert.ok(listedCockpit !== undefined && cockpit !== null);
    listedCockpit.hp = 0;
    assert.equal(cockpit.hp, 100);
  });

  test('ship assembly: 可変 state は狭い所有 API から更新する', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(module('tank-3-main', 'tank', { fuel: 10 }));
    assembly.append(module('booster-standard', 'booster', { fuel: 2 }));
    assembly.append(module('radiator-standard', 'radiator'));
    assembly.setIgnited('booster', true);
    assert.equal(assembly.consumeFuel('main', 3), 3);
    const boosterBefore = assembly.module('booster');
    assert.ok(boosterBefore !== null);
    assert.equal(boosterBefore.kind === 'booster' && boosterBefore.fuel, 2);
    assert.equal(assembly.consumeBoosterFuel('booster', 1), 1);
    const booster = assembly.module('booster');
    assert.ok(booster !== null);
    assert.equal(booster.kind, 'booster');
    assembly.setDeployment('radiator', 0.4);
    assembly.setTemperature('radiator', 500);
    const radiator = assembly.module('radiator');
    assert.ok(radiator !== null);
    assert.equal(radiator.temperature, 500);
    assert.equal(radiator.kind, 'radiator');
  });

  test('ship assembly: 過去の非対称 rotation を持つセーブデータも対称姿勢へマイグレーションして復元できる', () => {
    // 変更前の旧クォータニオン (qFromUnitVectors(LOCAL_FORWARD, direction))
    // 例: side:-x は direction = (-1, 0, 0), 旧クォータニオンは { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }
    const oldSaved = {
      playerOwned: true,
      modules: [
        { id: 'cockpit', definitionId: 'cockpit-standard', kind: 'cockpit' as const, hp: 100, temperature: 300 },
        { id: 'solar-right', definitionId: 'solar-panel-standard', kind: 'solar_panel' as const, hp: 100, temperature: 300, deployed: 1 },
      ],
      connections: [
        {
          id: 'connection-8',
          parentId: 'cockpit',
          childId: 'solar-right',
          kind: 'side' as const,
          sideSlot: 'side:-x' as const,
          position: { x: -3.5, y: 0, z: 0 },
          // 旧ローテーション（現在の sideSlotRotation('side:-x') とは異なる）
          rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
        },
      ],
    };
    const restored = restoreShipAssembly(oldSaved);
    assert.equal(restored.validate().valid, true);
    const edge = restored.graph.find(c => c.id === 'connection-8');
    assert.ok(edge !== undefined);
    const expected = {
      position: v3(-3.5, 0, 0),
      rotation: sideSlotRotation('side:-x'),
    };
    assert.equal(sameTransform(edge.childTransform, expected), true);
  });

  test('ship assembly: 過去の +Z axial を持つセーブデータも -Z 船尾方向へマイグレーションして復元できる', () => {
    const oldSaved = {
      playerOwned: true,
      modules: [
        { id: 'cockpit', definitionId: 'cockpit-standard', kind: 'cockpit' as const, hp: 100, temperature: 300 },
        { id: 'tank', definitionId: 'tank-3-main', kind: 'tank' as const, hp: 100, temperature: 300, fuelKind: 'main' as const, fuel: 100 },
      ],
      connections: [
        {
          id: 'connection-1',
          parentId: 'cockpit',
          childId: 'tank',
          kind: 'axial' as const,
          position: { x: 0, y: 0, z: 3 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
      ],
    };
    const restored = restoreShipAssembly(oldSaved);
    assert.equal(restored.validate().valid, true);
    const edge = restored.graph.find(c => c.id === 'connection-1');
    assert.ok(edge !== undefined);
    assert.equal(edge.childTransform.position.z, -3);
  });

  test('ship assembly: +Z prepend は前端面を隙間なく接続し headId を更新する', () => {
    const assembly = new ShipAssembly();
    assembly.addRoot(module('cockpit-standard', 'cockpit'));
    assert.equal(assembly.headId(), 'cockpit');
    assert.equal(assembly.tailId(), 'cockpit');

    assembly.prepend(module('weapon-gatling', 'weapon'));
    assert.equal(assembly.headId(), 'weapon');
    assert.equal(assembly.tailId(), 'cockpit');

    const edge = assembly.graph.find(c => c.childId === 'weapon');
    assert.ok(edge !== undefined);
    assert.equal(edge.kind, 'axial');
    // cockpit (length 3, center 0, forward +1.5) + weapon (length 1, center +0.5) -> z = +2.0
    assert.equal(edge.childTransform.position.z, 2.0);
    const weaponTransform = assembly.worldTransformOf('weapon');
    assert.ok(weaponTransform !== null);
    assert.equal(weaponTransform.position.z, 2.0);
    assert.equal(assembly.validate().valid, true);
  });

  test('ship assembly: side slot の rotation は左右線対称であり、受光面法線（local Y）が天頂を向く', () => {
    const rotPlusX = sideSlotRotation('side:+x');
    const rotMinusX = sideSlotRotation('side:-x');

    // local Y (0, 1, 0) を各クォータニオンで回転した世界方向
    const upPlusX = qRotate(rotPlusX, v3(0, 1, 0));
    const upMinusX = qRotate(rotMinusX, v3(0, 1, 0));

    // 両者ともに +Y（天頂）を向くこと
    assert.ok(Math.abs(upPlusX.y - 1.0) < 1e-9);
    assert.ok(Math.abs(upMinusX.y - 1.0) < 1e-9);

    // 外向き展開方向（local +Z）が、それぞれ +X と -X を向くこと
    const fwdPlusX = qRotate(rotPlusX, v3(0, 0, 1));
    const fwdMinusX = qRotate(rotMinusX, v3(0, 0, 1));
    assert.ok(Math.abs(fwdPlusX.x - 1.0) < 1e-9);
    assert.ok(Math.abs(fwdMinusX.x - (-1.0)) < 1e-9);
  });

  test('ship assembly: 戦闘艦プリセットは機首前面に砲口を持つ', () => {
    const assembly = createDefaultCombatPreset();
    const muzzles = new ShipCapabilities(assembly).muzzlePositions();
    assert.equal(muzzles.length, 1);
    const bow = Math.max(...assembly.modules.map((module) => {
      const transform = assembly.worldTransformOf(module.id)!;
      return transform.position.z + assembly.definition(module.id)!.length / 2;
    }));
    for (const muzzle of muzzles) assert.ok(muzzle.z > bow, `muzzle z ${muzzle.z} behind bow ${bow}`);
=======
  });
}
