// 素材サルベージの回収判定が、GAME.md 11.4 の規則どおりであることを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { v3, type Vec3 } from '../../src/math/vec3';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import { Salvage, buildSalvageAssembly, SALVAGE_ROOT_MODULE_ID } from '../../src/game/stages/stage-utils/salvage';
import type { ModularShip } from '../../src/game/ship/modular-ship';

interface FakeShipSpec {
  readonly playerOwned?: boolean;
  readonly role?: string;
  readonly moduleIds?: readonly string[];
  readonly alive?: boolean;
  readonly position?: Vec3;
  readonly velocity?: Vec3;
}

// 回収判定が読む面だけを持つ船体の代役。kill は呼び出しを記録する。
function fakeShip(id: string, spec: FakeShipSpec, killed: string[]): ModularShip {
  const state: KinematicState = kinematicState<'eci'>(
    0, spec.position ?? v3(7_000_000, 0, 0), spec.velocity ?? v3(0, 7_500, 0),
  );
  return {
    id,
    assembly: {
      playerOwned: spec.playerOwned ?? false,
      role: spec.role ?? 'ship',
      moduleIds: spec.moduleIds ?? [],
    },
    motion: {
      alive: spec.alive ?? true,
      state,
      kill: () => { killed.push(id); },
    },
  } as unknown as ModularShip;
}

export function register(): void {
  test('salvage: サルベージの船体はタンクとドッキング口を持ち、コックピットを持たない', () => {
    const assembly = buildSalvageAssembly();
    assert.equal(assembly.playerOwned, false);
    assert.equal(assembly.role, 'material');
    assert.ok(assembly.module(SALVAGE_ROOT_MODULE_ID) !== null);
    assert.equal(assembly.definition('salvage-docking-port')?.id, 'docking-port-standard');
  });

  test('salvage: 接近して相対速度を落とした船が回収し、素材は最寄りの基地へ入る', () => {
    const killed: string[] = [];
    const salvage = new Salvage({ 'salvage-1': 40 });
    const ships = [
      fakeShip('salvage-1', {}, killed),
      fakeShip('player-1', {
        playerOwned: true, position: v3(7_000_100, 0, 0),
      }, killed),
      fakeShip('base-far', {
        playerOwned: true, role: 'base', position: v3(7_100_000, 0, 0),
      }, killed),
      fakeShip('base-near', {
        playerOwned: true, role: 'base', position: v3(6_999_000, 0, 0),
      }, killed),
    ];
    const recovered = salvage.update(ships, 'fallback-base');
    assert.deepEqual(recovered, [{ baseId: 'base-near', materials: 40 }]);
    assert.deepEqual(killed, ['salvage-1']);
    assert.equal(salvage.trackedCount, 0);
  });

  test('salvage: 距離が遠い・相対速度が大きいときは回収しない', () => {
    const killed: string[] = [];
    const salvage = new Salvage({ 'salvage-1': 40 });
    const far = [
      fakeShip('salvage-1', {}, killed),
      fakeShip('player-1', { playerOwned: true, position: v3(7_001_000, 0, 0) }, killed),
    ];
    assert.deepEqual(salvage.update(far, 'fallback-base'), []);
    const fast = [
      fakeShip('salvage-1', {}, killed),
      fakeShip('player-1', {
        playerOwned: true, position: v3(7_000_100, 0, 0), velocity: v3(0, 7_600, 0),
      }, killed),
    ];
    assert.deepEqual(salvage.update(fast, 'fallback-base'), []);
    assert.equal(salvage.trackedCount, 1);
    assert.deepEqual(killed, []);
  });

  test('salvage: ドッキングで取り込まれた場合は船体が消えていても回収になり、喪失は回収にならない', () => {
    const killed: string[] = [];
    const docked = new Salvage({ 'salvage-1': 25 });
    const holder = fakeShip('player-1', {
      playerOwned: true, moduleIds: [SALVAGE_ROOT_MODULE_ID],
    }, killed);
    assert.deepEqual(docked.update([holder], 'fallback-base'), [
      { baseId: 'fallback-base', materials: 25 },
    ]);
    assert.equal(docked.trackedCount, 0);

    const lost = new Salvage({ 'salvage-1': 25 });
    assert.deepEqual(lost.update([holder === null ? holder : fakeShip('player-2', { playerOwned: true }, killed)], 'fallback-base'), []);
    assert.equal(lost.trackedCount, 0);
  });

  test('salvage: 台帳は直列化の往復で保たれる', () => {
    const salvage = new Salvage({ 'a': 10, 'b': 20 });
    const restored = Salvage.deserialize(salvage.serialize());
    assert.deepEqual(restored.serialize(), salvage.serialize());
    assert.deepEqual(Salvage.deserialize(null).serialize(), { amounts: {} });
  });
}
