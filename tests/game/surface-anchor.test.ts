import * as assert from 'node:assert/strict';
import { qFromAxisAngle } from '../../src/math/quat';
import { len, sub, v3 } from '../../src/math/vec3';
import type { CelestialBody } from '../../src/physics/celestial-body';
import { kinematicState } from '../../src/physics/kinematic-state';
import type { CelestialBodies } from '../../src/game/celestial/celestial-bodies';
import { AnchoredShipMotion } from '../../src/game/ship/anchored-ship-motion';
import { createBasePreset } from '../../src/game/ship/ship-presets';
import {
  assemblyOriginHeight, surfaceAnchorAtLatLon, surfaceAnchorPose,
} from '../../src/game/ship/surface-anchor';
import { test } from '../harness';

// 位置が固定で z 軸まわりに一定速度で自転する、テスト用の天体。
const BODY_POSITION = v3(1e8, 2e8, 0);
const BODY_VELOCITY = v3(0, 1e3, 0);
const RADIUS = 1.7e6;
const SPIN_RATE = 2.7e-6;

function fakeBody(): CelestialBody {
  return {
    id: 'fake-body',
    kind: 'satellite',
    def: { id: 'fake-body', mu: 4.9e12, radius: RADIUS },
    primary: null,
    stateAt: (pivot) => kinematicState<'eci'>(pivot, BODY_POSITION, BODY_VELOCITY),
    positionAt: () => BODY_POSITION,
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

export function register(): void {
  test('surface anchor: 緯度経度 0 の地表に立ち、自転とともに回る', () => {
    const body = fakeBody();
    const height = 12;
    const anchor = surfaceAnchorAtLatLon('fake-body', RADIUS, 0, 0, height);
    const atZero = surfaceAnchorPose(anchor, body, 0, v3());
    // t=0 では自転位相 0 なので、地表点は天体中心から +x 方向にある。
    const offsetAtZero = sub(atZero.state.r, BODY_POSITION);
    assert.ok(Math.abs(offsetAtZero.x - (RADIUS + height)) < 1e-6);
    assert.ok(Math.abs(offsetAtZero.y) < 1e-6);
    assert.ok(Math.abs(offsetAtZero.z) < 1e-6);
    // 速度は天体の並進速度に、自転による周速度 ω×r が加わる。
    assert.ok(Math.abs(atZero.state.v.x) < 1e-9);
    assert.ok(Math.abs(atZero.state.v.y - (BODY_VELOCITY.y + SPIN_RATE * (RADIUS + height))) < 1e-6);
    // 自転が 1/4 回転進むと、地表点は +y 方向へ移る。
    const quarter = Math.PI / 2 / SPIN_RATE;
    const later = surfaceAnchorPose(anchor, body, quarter, v3());
    const offsetLater = sub(later.state.r, BODY_POSITION);
    assert.ok(Math.abs(offsetLater.x) < 1e-3);
    assert.ok(Math.abs(offsetLater.y - (RADIUS + height)) < 1e-3);
    assert.ok(Math.abs(len(offsetLater) - (RADIUS + height)) < 1e-3);
  });

  test('surface anchor: 重心オフセットは船体の向きに回して加わる', () => {
    const body = fakeBody();
    const anchor = surfaceAnchorAtLatLon('fake-body', RADIUS, 0, 0, 12);
    // 船体の +Z は地表の外向きを向くので、重心が原点から +Z に 5 m あれば外側へ 5 m ずれる。
    const pose = surfaceAnchorPose(anchor, body, 0, v3(0, 0, 5));
    assert.ok(Math.abs(len(sub(pose.state.r, BODY_POSITION)) - (RADIUS + 12 + 5)) < 1e-6);
  });

  test('surface anchor: 基地 preset の原点高さは縦列モジュールの合計と一致する', () => {
    const assembly = createBasePreset();
    const definition = (id: string) => assembly.definition(id)!;
    const expected = definition('cockpit').length / 2
      + definition('main-tank').length + definition('rcs-tank').length;
    assert.ok(Math.abs(assemblyOriginHeight(assembly) - expected) < 1e-6);
  });

  test('anchored motion: 歩を進めても錨の地表に留まり、未来状態も錨から答える', () => {
    const body = fakeBody();
    const assembly = createBasePreset();
    const anchor = surfaceAnchorAtLatLon(
      'fake-body', RADIUS, 0, 0, assemblyOriginHeight(assembly),
    );
    const probe = new AnchoredShipMotion(
      assembly, kinematicState<'eci'>(0, BODY_POSITION, BODY_VELOCITY),
      { q: { x: 0, y: 0, z: 0, w: 1 }, w: v3(), inertia: v3(1, 1, 1) }, {}, {}, anchor,
    );
    const initial = surfaceAnchorPose(anchor, body, 0, probe.centerOffset);
    const motion = new AnchoredShipMotion(
      assembly, initial.state, { q: initial.q, w: initial.w, inertia: v3(1, 1, 1) }, {}, {}, anchor,
    );
    motion.stepSimulation(3600, [body], [], null, null, 0, {} as never);
    assert.equal(motion.state.t, 3600);
    const expected = surfaceAnchorPose(anchor, body, 3600, motion.centerOffset);
    assert.ok(len(sub(motion.state.r, expected.state.r)) < 1e-6);
    assert.ok(len(sub(motion.state.v, expected.state.v)) < 1e-9);
    // 未来の問い合わせは、解決した天体を使って錨から答える。
    const bodies = { findMotion: (id: string) => (id === 'fake-body' ? body : null) } as unknown as CelestialBodies;
    const future = motion.stateAt(7200, bodies);
    assert.ok(future !== null);
    const expectedFuture = surfaceAnchorPose(anchor, body, 7200, motion.centerOffset);
    assert.ok(len(sub(future.r, expectedFuture.state.r)) < 1e-6);
    // 予測弧は作らない。
    assert.equal(motion.ensurePredictedArc([body]), null);
  });
}
