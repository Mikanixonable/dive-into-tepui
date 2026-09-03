// 回転追従の選択肢の導出テスト。期待値の正本は「フォーカス対象から選べるものだけを出す」という
// 仕様(SPEC/CAMERA.md「視点の回転の固定先」)で、コードの現状ではない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  availableRotationFollows, rotationFollowKey, rotationFollowFromSaveData,
  type CameraRotationFollow, type CelestialRegistry,
} from '../../src/game/camera/rotation-follow';
import type { FocusTarget } from '../../src/game/camera/focus-target';
import type { CelestialMotion } from '../../src/physics/celestial-motion';
import type { FrameAnchorSource } from '../../src/physics/frame';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';

// 導出が読むのは id・primary・spinRotationAt の3つだけなので、そこだけを持つ天体を組む。
function motion(id: string, primaryId: string | null, spins: boolean): CelestialMotion {
  return {
    id,
    primary: primaryId === null ? null : { id: primaryId },
    spinRotationAt: () => (spins ? { q: Q_IDENTITY, omega: v3() } : null),
  } as unknown as CelestialMotion;
}

// 恒星 sun ─ 惑星 earth(自転あり)─ 衛星 moon(自転あり)。
const SUN = motion('sun', null, false);
const EARTH = motion('earth', 'sun', true);
const MOON = motion('moon', 'earth', true);
const REGISTRY: CelestialRegistry = {
  celestialMotions: [SUN, EARTH, MOON],
  find: (id) => [SUN, EARTH, MOON].filter((m) => m.id === id).map((m) => ({ motion: m }))[0] ?? null,
};

// 登録天体でない id(機体・役割)の解決。orbiting なら主天体を答える。
function anchors(orbiting: boolean): FrameAnchorSource {
  return {
    bodies: [], bodiesPivot: 0,
    stateOf: () => null,
    attractorOf: () => (orbiting ? 'earth' : null),
  };
}

const object = (id: string): FocusTarget => ({ kind: 'object', id });
const keys = (follows: readonly CameraRotationFollow[]): string[] => follows.map(rotationFollowKey);

export function register(): void {
  test('rotation-follow: 天体は自分の公転・子の公転・自分の自転を選べる', () => {
    const got = availableRotationFollows(object('earth'), REGISTRY, anchors(false), () => null, 0);
    assert.deepEqual(keys(got), ['earth', 'moon', 'spin:earth']);
  });

  test('rotation-follow: 恒星には公転が出ず、自転モデルが無ければ自転も出ない', () => {
    const got = availableRotationFollows(object('sun'), REGISTRY, anchors(false), () => null, 0);
    assert.deepEqual(keys(got), ['earth']);
  });

  test('rotation-follow: 周回中の機体は公転と姿勢、周回していなければ姿勢だけ', () => {
    const orbiting = availableRotationFollows(object('ship'), REGISTRY, anchors(true), () => Q_IDENTITY, 0);
    assert.deepEqual(keys(orbiting), ['ship', 'attitude']);
    const drifting = availableRotationFollows(object('ship'), REGISTRY, anchors(false), () => Q_IDENTITY, 0);
    assert.deepEqual(keys(drifting), ['attitude']);
  });

  test('rotation-follow: 姿勢が引けない機体は姿勢を選べない', () => {
    const got = availableRotationFollows(object('ship'), REGISTRY, anchors(true), () => null, 0);
    assert.deepEqual(keys(got), ['ship']);
  });

  test('rotation-follow: 固定点フォーカスでは慣性系しか選べない', () => {
    const point = { kind: 'point' } as unknown as FocusTarget;
    assert.deepEqual(availableRotationFollows(point, REGISTRY, anchors(true), () => Q_IDENTITY, 0), []);
  });

  test('rotation-follow: 旧セーブの文字列は公転として読む', () => {
    assert.deepEqual(rotationFollowFromSaveData('moon'), { kind: 'revolution', id: 'moon' });
    assert.deepEqual(rotationFollowFromSaveData(null), null);
    assert.deepEqual(rotationFollowFromSaveData({ kind: 'spin', id: 'earth' }), { kind: 'spin', id: 'earth' });
    assert.deepEqual(rotationFollowFromSaveData({ kind: 'attitude' }), { kind: 'attitude' });
  });
}
