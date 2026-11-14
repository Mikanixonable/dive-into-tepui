import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { qFromAxisAngle } from '../../src/math/quat';
import { len, sub, v3 } from '../../src/math/vec3';
import type { CelestialBody } from '../../src/physics/celestial-body';
import { kinematicState } from '../../src/physics/kinematic-state';
import type { EntityRegistry } from '../../src/game/dynamic/entity-registry';
import { EntityIdAllocators } from '../../src/game/dynamic/dynamic-entity/entity-id';
import { RunEventLog } from '../../src/game/run-events';
import { AnchoredShipMotion } from '../../src/game/ship/anchored-ship-motion';
import { ModularShip } from '../../src/game/ship/modular-ship';
import { ShipConstructionEdits, type ConstructionShip } from '../../src/game/ship/ship-construction-edits';
import { ShipDockState } from '../../src/game/ship/ship-dock-state';
import { shipPhysicsShape } from '../../src/game/ship/ship-physics-shape';
import {
  assemblyOriginHeight, surfaceAnchorAtLatLon, surfaceAnchorPose,
} from '../../src/game/ship/surface-anchor';
import {
  buildStoryLunarBaseAssembly, buildStoryLunarDebrisAssembly, isInOrbitAround,
  storyLunarDebrisState, STORY_LUNAR_BASE_ID,
} from '../../src/game/stages/stage-story-lunar';
import { test } from '../harness';

// 位置が固定で z 軸まわりに一定速度で自転する、テスト用の月。
const MOON_POSITION = v3(1e8, 2e8, 0);
const MOON_VELOCITY = v3(0, 1e3, 0);
const RADIUS = 1.7374e6;
const SPIN_RATE = 2.7e-6;

function fakeMoon(): CelestialBody {
  return {
    id: 'moon',
    kind: 'satellite',
    def: { id: 'moon', mu: 4.905e12, radius: RADIUS },
    primary: null,
    stateAt: (pivot) => kinematicState<'eci'>(pivot, MOON_POSITION, MOON_VELOCITY),
    positionAt: () => MOON_POSITION,
    atmosphereAt: () => null,
    degree2At: () => null,
    orientationAt: (t) => ({ axis: v3(0, 0, 1), spinAngle: SPIN_RATE * t }),
    spinRotationAt: (t) => ({
      q: qFromAxisAngle(v3(0, 0, 1), SPIN_RATE * t),
      omega: v3(0, 0, SPIN_RATE),
    }),
    spinRate: SPIN_RATE,
  };
}

// ModularShip の生成は見た目(発光ビルボードの canvas)を伴う。node には DOM が無いので、
// テスト中だけ、その生成が読む面だけを立てる(render テスト群と同じ代役)。
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

export function register(): void {
  test('story lunar: 開始状態のロケットは推進器だけが欠け、建造予約が途中まで進んでいる', () => {
    const { assembly, dockState } = buildStoryLunarBaseAssembly();
    assert.equal(dockState.length, 1);
    assert.equal(dockState[0]?.dockId, 'dock-left');
    assert.deepEqual(dockState[0]?.addedIds, [
      'rocket-cockpit', 'rocket-main-tank', 'rocket-rcs-tank', 'rocket-rcs',
      'rocket-solar-left', 'rocket-solar-right', 'rocket-radiator', 'rocket-docking-port',
    ]);
    assert.equal(dockState[0]?.axialTailId, 'rocket-rcs');
    assert.ok(dockState[0]?.firstConnectionId !== null);
    // 推進器はまだ付いていない — 完成はプレイヤーの建造に委ねられる。
    const hasThruster = assembly.moduleIds.some(
      (id) => assembly.definition(id)?.id === 'thruster-standard',
    );
    assert.equal(hasThruster, false);
  });

  test('story lunar: 予約を続行して推進器を付けると完成し、根の接続が分離可能になる', () => {
    const { assembly, dockState } = buildStoryLunarBaseAssembly();
    const docks = new ShipDockState(dockState);
    const facade: ConstructionShip = {
      id: 'test-base',
      assembly,
      docks,
      capabilities: { controllable: true },
      motion: { alive: true },
      synchronizeAssemblyState: () => undefined,
    };
    const edits = new ShipConstructionEdits(facade, 'dock-left');
    edits.begin();
    edits.place('thruster-standard', 'axial', 'rocket-thruster');
    edits.finish();
    assert.equal(docks.constructionDraft('dock-left'), null);
    const rootEdge = assembly.graph.find((edge) => edge.childId === 'rocket-cockpit');
    assert.equal(rootEdge?.kind, 'construction');
  });

  test('story lunar: 基地は地表固定の運動で作られ、記録の往復でも錨と建造予約が保たれる', () => {
    const restoreDocument = installCanvasStub();
    try {
      const moon = fakeMoon();
      const { assembly, dockState } = buildStoryLunarBaseAssembly();
      const anchor = surfaceAnchorAtLatLon(
        'moon', RADIUS, 0, 0, assemblyOriginHeight(assembly),
      );
      const shape = shipPhysicsShape(assembly);
      assert.ok(shape !== null);
      const pose = surfaceAnchorPose(anchor, moon, 0, shape.centerOffset);
      const registry = stubRegistry();
      const base = ModularShip.create(
        {
          name: '月面基地',
          id: STORY_LUNAR_BASE_ID,
          assembly,
          dockState,
          state: pose.state,
          att: { q: pose.q, w: pose.w, inertia: v3(1, 1, 1) },
          surfaceAnchor: anchor,
        },
        registry,
        new THREE.Scene(),
      );
      assert.equal(base.id, STORY_LUNAR_BASE_ID);
      assert.ok(base.motion instanceof AnchoredShipMotion);

      const restored = ModularShip.deserialize(base.serialize(), registry, new THREE.Scene());
      assert.ok(restored.motion instanceof AnchoredShipMotion);
      assert.deepEqual(
        restored.docks.constructionDraft('dock-left')?.addedIds,
        dockState[0]?.addedIds,
      );
      assert.deepEqual(restored.serialize().surfaceAnchor, anchor);
    } finally {
      restoreDocument();
    }
  });

  test('story lunar: デブリは高度100kmの円軌道にあり、軌道投入の判定が落下と脱出を除く', () => {
    const moon = fakeMoon();
    const debrisState = storyLunarDebrisState(moon, 0);
    assert.ok(
      Math.abs(len(sub(debrisState.r, MOON_POSITION)) - (RADIUS + 100_000)) < 1e-6,
    );
    assert.equal(isInOrbitAround(debrisState, moon), true);
    // 相対速度ゼロの落下は軌道ではない。
    const falling = kinematicState<'eci'>(0, v3(MOON_POSITION.x + RADIUS + 50_000, MOON_POSITION.y, 0), MOON_VELOCITY);
    assert.equal(isInOrbitAround(falling, moon), false);
    // 脱出速度を超える通過も軌道投入ではない。
    const escaping = kinematicState<'eci'>(
      0,
      v3(MOON_POSITION.x + RADIUS + 100_000, MOON_POSITION.y, 0),
      v3(0, MOON_VELOCITY.y + 5000, 0),
    );
    assert.equal(isInOrbitAround(escaping, moon), false);
  });

  test('story lunar: デブリの assembly はコックピットを持たず、ドッキング口を持つ', () => {
    const assembly = buildStoryLunarDebrisAssembly();
    assert.equal(assembly.playerOwned, false);
    assert.ok(assembly.module('debris-tank') !== null);
    assert.equal(assembly.definition('debris-docking-port')?.id, 'docking-port-standard');
    const hasCockpit = assembly.moduleIds.some(
      (id) => assembly.definition(id)?.kind === 'cockpit',
    );
    assert.equal(hasCockpit, false);
  });
}
