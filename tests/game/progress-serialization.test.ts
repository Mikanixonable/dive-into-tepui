// 表示物を持たずに組める進行の所有者について、直列化した記録から復元して直列化し直すと、元の記録へ
// 戻ることを1つの表で検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import rawProteinAsset from '../../src/assets/models/pdb5i4rProtein.json';
import { v3 } from '../../src/math/vec3';
import { kinematicState, type SerializedKinematicState } from '../../src/physics/kinematic-state';
import { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';
import { SimSpeedManager, type SerializedSimSpeedManager } from '../../src/game/dynamic/sim-speed-manager';
import { Plan, type SerializedPlan } from '../../src/game/plan/plan';
import { PlanNodeRules, type SerializedPlanNodeRules } from '../../src/game/plan/plan-node-rules';
import { MAG_ROUNDS } from '../../src/game/player/ammo-spec';
import { AltitudeAlarm, type SerializedAltitudeAlarm } from '../../src/game/player/altitude-alarm';
import { BeltController, type SerializedBeltController } from '../../src/game/player/belt';
import {
  DeployablePanelState, type SerializedDeployablePanelState,
} from '../../src/game/player/deployable-panel-state';
import { POWER_CAPACITY, PowerSystem, type SerializedPowerSystem } from '../../src/game/player/power';
import { RadiatorSystem, type SerializedRadiatorSystem } from '../../src/game/player/radiator';
import { THROTTLE_LEVELS, Throttle, type SerializedThrottle } from '../../src/game/player/throttle';
import { WeaponState, type SerializedWeaponState } from '../../src/game/player/weapon-state';
import {
  ProteinCombatState, type SerializedProteinCombatState,
} from '../../src/game/protein/protein-combat-state';
import { RunEventLog } from '../../src/game/run-events';
import {
  ScoreAttackTimer, type SerializedScoreAttackTimer,
} from '../../src/game/stages/stage-utils/score-attack-timer';
import { ScoreCounter, type SerializedScoreCounter } from '../../src/game/stages/stage-utils/score-counter';
import type { ProteinAssetDefinition } from '../../src/game/protein/protein-schema';

const proteinAsset = rawProteinAsset as unknown as ProteinAssetDefinition;

// 所有者1つぶんの往復。serialized はどの項目も新しく作ったときと違う値を持つ記録、reserialized は
// それを所有者の復元に通してから直列化し直したもの。
interface RoundTrip {
  readonly owner: string;
  readonly serialized: unknown;
  reserialized(): unknown;
}

// 記録 serialized を restore で組み直して直列化し直す往復を、所有者 owner の1行にする。
function roundTrip<T>(owner: string, serialized: T, restore: (serialized: T) => { serialize(): unknown }): RoundTrip {
  return { owner, serialized, reserialized: () => restore(serialized).serialize() };
}

// 時刻 t [s] の、地球を回る位置・速度の記録。
function serializedState(t: number): SerializedKinematicState {
  return { t, r: { x: 7e6 + t, y: 0, z: 0 }, v: { x: 0, y: 7.5e3, z: t } };
}

// 先頭の部位が半分まで削れ、構造全体も削れ、修飾がどれも既定と違う状態になり、撃つ部位の巡回が
// 1つ進んだ戦闘状態の記録。
function damagedProtein(): SerializedProteinCombatState {
  return {
    integrityHp: proteinAsset.integrity.maxHp * 0.8,
    sites: proteinAsset.sites.map((site, i) => ({ id: site.id, hp: i === 0 ? site.maxHp / 2 : site.maxHp })),
    modifications: Object.fromEntries(proteinAsset.modificationSlots.map((slot) => [
      slot.id, slot.states.find((state) => state !== slot.defaultState) ?? slot.defaultState,
    ])),
    attackSiteCursor: 1,
  };
}

// 往復を確かめる所有者の表。
function roundTrips(): readonly RoundTrip[] {
  const events = new RunEventLog();
  const hull = new DynamicMotion(kinematicState<'eci'>(0, v3(), v3()));
  const noContact = (): void => {};

  return [
    roundTrip<SerializedThrottle>(
      'Throttle',
      {
        throttleIdx: THROTTLE_LEVELS.length - 1,
        rcsDamp: false,
        progradeHold: false,
        rotationHoldTime: 1.5,
        latchedThrust: ['forward', 'up'],
      },
      (serialized) => Throttle.deserialize(serialized),
    ),
    roundTrip<SerializedPowerSystem>(
      'PowerSystem',
      {
        charge: POWER_CAPACITY / 2,
        up: { deployTarget: 0, deploy: 0.25 },
        down: { deployTarget: 1, deploy: 0.5 },
        panels: null,
      },
      (serialized) => PowerSystem.deserialize(serialized),
    ),
    roundTrip<SerializedRadiatorSystem>(
      'RadiatorSystem',
      { up: { deployTarget: 1, deploy: 0.5 }, down: { deployTarget: 0, deploy: 0.75 }, panels: null },
      (serialized) => new RadiatorSystem(
        hull,
        noContact,
        DeployablePanelState.deserialize(serialized.up) ?? undefined,
        DeployablePanelState.deserialize(serialized.down) ?? undefined,
      ),
    ),
    roundTrip<SerializedDeployablePanelState>(
      'DeployablePanelState',
      { deployTarget: 1, deploy: 0.3 },
      (serialized) => DeployablePanelState.deserialize(serialized) ?? new DeployablePanelState(0, 0),
    ),
    roundTrip<SerializedWeaponState>(
      'WeaponState',
      {
        mags: 5,
        rounds: MAG_ROUNDS - 3,
        cooldown: 0.2,
        muzzleIdx: 1,
        wasFiring: true,
        wasEmptyClick: true,
      },
      (serialized) => WeaponState.deserialize(serialized),
    ),
    roundTrip<SerializedProteinCombatState>(
      'ProteinCombatState',
      damagedProtein(),
      (serialized) => ProteinCombatState.deserialize(serialized, proteinAsset),
    ),
    roundTrip<SerializedPlan>(
      'Plan',
      { anchor: serializedState(0), nodes: [serializedState(600), serializedState(1200)] },
      (serialized) => Plan.deserialize(serialized),
    ),
    roundTrip<SerializedScoreCounter>(
      'ScoreCounter',
      { shots: 10, hits: 4, kills: 2, losses: 1, totalEnemiesSpawned: 6 },
      (serialized) => ScoreCounter.deserialize(serialized),
    ),
    roundTrip<SerializedScoreAttackTimer>(
      'ScoreAttackTimer',
      42,
      (serialized) => ScoreAttackTimer.deserialize(serialized),
    ),
    roundTrip<SerializedSimSpeedManager>(
      'SimSpeedManager',
      { levelIdx: 3, autoWarpUntil: 1e6 },
      (serialized) => SimSpeedManager.deserialize(serialized, events),
    ),
    roundTrip<SerializedAltitudeAlarm>(
      'AltitudeAlarm',
      { descendWarned: true, altEma: 95e3, altRateEma: -4, warnedThresholds: [120e3, 100e3] },
      (serialized) => AltitudeAlarm.deserialize(serialized, events),
    ),
    roundTrip<SerializedBeltController>(
      'BeltController',
      {
        feed: 0.4,
        physics: {
          positions: [{ x: 1, y: 0.1, z: 0 }, { x: 2, y: 0.3, z: -0.1 }],
          prevPositions: [{ x: 1, y: 0.05, z: 0 }, { x: 2, y: 0.2, z: -0.05 }],
          twists: [0.05, -0.1],
          prevShipW: { x: 0.01, y: 0.02, z: -0.03 },
          mountAnchor: { x: -1.19, y: 0, z: 0 },
          mountDirection: { x: 1, y: 0, z: 0 },
        },
      },
      (serialized) => BeltController.deserialize(serialized),
    ),
    roundTrip<SerializedPlanNodeRules>(
      'PlanNodeRules',
      { approachNotified: serializedState(600) },
      (serialized) => PlanNodeRules.deserialize(serialized, events),
    ),
  ];
}

export function register(): void {
  for (const { owner, serialized, reserialized } of roundTrips()) {
    test(`progress-serialization: ${owner} は直列化した記録から同じ状態へ戻る`, () => {
      // SAVE.md「保存される内容」: ゲームの進み具合を決める状態は保存され、読み込んだ記録は保存した瞬間の状態から続く
      assert.deepEqual(reserialized(), serialized);
    });
  }

  test('progress-serialization: 旧ベルト記録の最初の取付同期は節点位置を保つ', () => {
    const belt = BeltController.deserialize({
      feed: 0.4,
      physics: {
        positions: [{ x: 1, y: 0.1, z: 0 }, { x: 2, y: 0.3, z: -0.1 }],
        prevPositions: [{ x: 1, y: 0.05, z: 0 }, { x: 2, y: 0.2, z: -0.05 }],
        twists: [0.05, -0.1],
        prevShipW: { x: 0.01, y: 0.02, z: -0.03 },
      },
    });
    const savedPositions = belt.positions.map((position) => ({ ...position }));

    belt.setMount(v3(0.4, 2, -1), v3(0, 1, 0));

    assert.deepEqual(belt.positions, savedPositions);
    assert.deepEqual(belt.serialize().physics.mountAnchor, { x: 0.4, y: 2, z: -1 });
    assert.deepEqual(belt.serialize().physics.mountDirection, { x: 0, y: 1, z: 0 });
  });
}
