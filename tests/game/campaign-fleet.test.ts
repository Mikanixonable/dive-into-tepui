// ストーリーの引き継ぎ艦隊: 捕捉が対象の艦だけを記録し、拠点へ接舷している艦を
// 拠点の実体を書き換えずに切り出すこと、復元で組立と状態が保たれること、建造・修理の
// 完了時刻が残り時間へ移ることを検査する(GAME.md 11.2)。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { v3 } from '../../src/math/vec3';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import type { EntityRegistry } from '../../src/game/dynamic/entity-registry';
import { EntityIdAllocators } from '../../src/game/dynamic/dynamic-entity/entity-id';
import { RunEventLog } from '../../src/game/run-events';
import { ModularShip } from '../../src/game/ship/modular-ship';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { ShipDockState } from '../../src/game/ship/ship-dock-state';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { createBasePreset, createDefaultCombatPreset } from '../../src/game/ship/ship-presets';
import {
  assemblyOriginHeight, surfaceAnchorAtLatLon,
} from '../../src/game/ship/surface-anchor';
import { serializeShipAssembly } from '../../src/game/ship/ship-save';
import {
  captureCarriedFleet, createCarriedShip, MAX_CARRIED_SHIPS,
} from '../../src/game/campaign/campaign-fleet';
import { buildStoryLunarDebrisAssembly } from '../../src/game/stages/stage-story-lunar';
import { test } from '../harness';

// ModularShip の生成は見た目(発光ビルボードの canvas)を伴う。node には DOM が無いので、
// テスト中だけ、その生成が読む面だけを立てる(story-lunar-stage.test と同じ代役)。
function installCanvasStub(): () => void {
  const context = {
    createRadialGradient: () => ({ addColorStop: () => {} }),
    fillStyle: '' as unknown,
    fillRect: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
    }),
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.document;
  globals.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
  return () => { globals.document = previous; };
}

function stubRegistry(): EntityRegistry {
  return {
    idAllocators: new EntityIdAllocators(),
    events: new RunEventLog(),
    add: () => {},
    spawnWhenReady: () => {},
    pendingEnemyCount: 0,
  };
}

const STATE: KinematicState = kinematicState<'eci'>(0, v3(7.0e6, 0, 0), v3(0, 7.5e3, 0));
const FACILITY_IDS: ReadonlySet<string> = new Set(['test-base']);

function createShip(
  registry: EntityRegistry, scene: THREE.Scene,
  init: Parameters<typeof ModularShip.create>[0],
): ModularShip {
  return ModularShip.create({ state: STATE, ...init }, registry, scene);
}

// 客船の assembly: タンクを根に、接舷部と太陽電池を側面へ付けた最小の艦
// (漂流デブリと同じ組み方)。
function guestAssembly(): ShipAssembly {
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  const instance = (definitionId: string, id: string) =>
    createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), id);
  assembly.addRoot(instance('tank-6-main', 'guest-tank'));
  assembly.connectSide(instance('docking-port-standard', 'guest-port'), 'guest-tank', 'side:+y');
  assembly.connectSide(instance('solar-panel-standard', 'guest-solar'), 'guest-tank', 'side:+x');
  assembly.assertValid();
  return assembly;
}

export function register(): void {
  test('campaign-fleet: 独立した艦は組立・損傷・弾薬を保って記録され、復元できる', () => {
    const restoreCanvas = installCanvasStub();
    try {
      const scene = new THREE.Scene();
      const registry = stubRegistry();
      const ship = createShip(registry, scene, {
        name: '試験船', id: 'test-ship-1', assembly: createDefaultCombatPreset(),
      });
      // 損傷を与えてから捕捉する — 損傷も引き継がれる。
      const module = ship.assembly.modules[0];
      assert.ok(module !== undefined);
      ship.assembly.setHp(module.id, module.hp / 2);
      const expectedHp = ship.assembly.module(module.id)?.hp;

      const carried = captureCarriedFleet([ship], FACILITY_IDS, 0);
      assert.equal(carried.length, 1);
      const record = carried[0];
      assert.ok(record !== undefined);
      assert.equal(record.id, 'test-ship-1');
      assert.equal(record.name, '試験船');
      assert.deepEqual(record.assembly, serializeShipAssembly(ship.assembly));
      assert.deepEqual(record.ammo, { mags: ship.fire.mags, rounds: ship.fire.rounds });

      // 復元は新しいレジストリ(次の幕のラン)で行う — id と名前と組立がそのまま戻る。
      const restored = createCarriedShip(
        record, kinematicState<'eci'>(0, v3(7.1e6, 0, 0), v3(0, 7.4e3, 0)),
        stubRegistry(), scene,
      );
      assert.equal(restored.id, 'test-ship-1');
      assert.equal(restored.name, '試験船');
      assert.deepEqual(restored.assembly.moduleIds, ship.assembly.moduleIds);
      assert.equal(restored.assembly.module(module.id)?.hp, expectedHp);
      assert.deepEqual(restored.motion.state.r, v3(7.1e6, 0, 0));
    } finally {
      restoreCanvas();
    }
  });

  test('campaign-fleet: 拠点・デブリ・喪失した艦・地表固定の艦は引き継がれない', () => {
    const restoreCanvas = installCanvasStub();
    try {
      const scene = new THREE.Scene();
      const registry = stubRegistry();
      const base = createShip(registry, scene, {
        name: '拠点', id: 'test-base', assembly: createBasePreset(),
      });
      const debris = createShip(registry, scene, {
        name: 'デブリ', id: 'test-debris', assembly: buildStoryLunarDebrisAssembly(),
      });
      const lost = createShip(registry, scene, {
        name: '喪失艦', id: 'test-lost', assembly: createDefaultCombatPreset(),
      });
      lost.motion.kill();
      const anchoredAssembly = createBasePreset();
      const anchored = createShip(registry, scene, {
        name: '地表基地', id: 'test-anchored', assembly: anchoredAssembly,
        surfaceAnchor: surfaceAnchorAtLatLon(
          'moon', 1.7374e6, 0, 0, assemblyOriginHeight(anchoredAssembly),
        ),
      });
      // GAME.md 11.2: 引き継ぎの対象は独立したプレイヤーの艦だけである。
      assert.deepEqual(captureCarriedFleet([base, debris, lost, anchored], FACILITY_IDS, 0), []);
    } finally {
      restoreCanvas();
    }
  });

  test('campaign-fleet: 拠点へ接舷している艦は、拠点を書き換えずに切り出される', () => {
    const restoreCanvas = installCanvasStub();
    try {
      const scene = new THREE.Scene();
      const registry = stubRegistry();
      const facility = createShip(registry, scene, {
        name: '拠点', id: 'test-base', assembly: createBasePreset(),
      });
      // 客船を拠点のドックへ接舷した状態を、実行時の接舷と同じ部品で組む。
      const merged = facility.assembly.mergedAtDock(
        guestAssembly(), 'dock-left', 'guest-port', 'guest-ship',
      );
      facility.assembly.replaceWith(merged.assembly);
      facility.docks.mergeFrom(new ShipDockState(), merged.moduleIds, merged.connectionIds);
      facility.connections.setDockedVessel(
        merged.connectionId, { id: 'guest-ship', name: '客船' },
      );
      facility.motion.synchronizeAssembly();
      const facilityModules = facility.assembly.moduleIds;

      const carried = captureCarriedFleet([facility], FACILITY_IDS, 0);
      assert.equal(carried.length, 1);
      const record = carried[0];
      assert.ok(record !== undefined);
      assert.equal(record.id, 'guest-ship');
      assert.equal(record.name, '客船');
      assert.deepEqual(
        [...record.assembly.modules.map((m) => m.id)].sort(),
        ['guest-port', 'guest-solar', 'guest-tank'],
      );
      // 捕捉は拠点の実体を書き換えない — 接舷は保たれたままである。
      assert.deepEqual(facility.assembly.moduleIds, facilityModules);
      assert.equal(facility.connections.serializeDockedVessels().length, 1);

      const restored = createCarriedShip(record, STATE, stubRegistry(), scene);
      assert.equal(restored.id, 'guest-ship');
      assert.deepEqual(
        [...restored.assembly.moduleIds].sort(),
        ['guest-port', 'guest-solar', 'guest-tank'],
      );
    } finally {
      restoreCanvas();
    }
  });

  test('campaign-fleet: 建造と修理の完了時刻は、引き継ぎ先の残り時間へ移る', () => {
    const restoreCanvas = installCanvasStub();
    try {
      const scene = new THREE.Scene();
      const registry = stubRegistry();
      const ship = createShip(registry, scene, {
        name: '工作艦',
        id: 'test-builder',
        assembly: createBasePreset(),
        dockState: [{
          dockId: 'dock-left', addedIds: [], axialTailId: 'dock-left', firstConnectionId: null,
          paidModuleIds: [],
          pendingModule: {
            id: 'pending-1', definitionId: 'thruster-standard', slotId: 'axial', completesAt: 900,
          },
        }],
        pendingRepairs: [{ dockId: 'dock-left', completesAt: 1000, materials: 5 }],
      });
      // simTime 300 で捕捉すると、完了までの残り(600 / 700)が新しい完了時刻になる。
      const carried = captureCarriedFleet([ship], FACILITY_IDS, 300);
      const record = carried[0];
      assert.ok(record !== undefined);
      assert.equal(record.dockState[0]?.pendingModule?.completesAt, 600);
      assert.equal(record.pendingRepairs[0]?.completesAt, 700);

      const restored = createCarriedShip(record, STATE, stubRegistry(), scene);
      const serialized = restored.serialize();
      assert.equal(serialized.dockState[0]?.pendingModule?.completesAt, 600);
      assert.equal(serialized.pendingRepairs?.[0]?.completesAt, 700);
    } finally {
      restoreCanvas();
    }
  });

  test('campaign-fleet: 引き継がれるのは最大で6隻まで', () => {
    const restoreCanvas = installCanvasStub();
    try {
      const scene = new THREE.Scene();
      const registry = stubRegistry();
      const ships = Array.from({ length: MAX_CARRIED_SHIPS + 1 }, (_, i) => createShip(
        registry, scene, {
          name: `艦${i}`, id: `test-ship-${i}`, assembly: createDefaultCombatPreset(),
        },
      ));
      // GAME.md 11.2: 同時に運用できる艦は6隻までで、引き継ぎも同じ上限に従う。
      assert.equal(captureCarriedFleet(ships, FACILITY_IDS, 0).length, MAX_CARRIED_SHIPS);
    } finally {
      restoreCanvas();
    }
  });
}
