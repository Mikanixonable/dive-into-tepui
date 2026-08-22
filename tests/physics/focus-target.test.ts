// focus-target.ts の回帰テスト。振動バグの本体は「機体 id は候補配列ではなく
// frameAnchors.stateOf を返す」ケース(resolveFocusTarget は候補配列を先に見ると壊れる)。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { FocusCandidate, FocusResolveState, resolveFocusTarget } from '../../src/game/camera/focus-target';
import { Ephemeris } from '../../src/physics/ephemeris';
import { SOLAR_SYSTEM } from '../../src/physics/solar-system';
import { FrameAnchorSource } from '../../src/physics/frame';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/physics/vec3';

const ORIGIN_STATE: FocusResolveState = { missingFocusFrames: 0, lastResolvedFocus: v3(1, 2, 3) };

function stubAnchors(states: Partial<Record<string, KinematicState>>): FrameAnchorSource {
  return { bodies: [], stateOf: (id) => states[id] ?? null, attractorOf: () => null };
}

export function register(): void {
  const eph = new Ephemeris(SOLAR_SYSTEM, 'earth');

  test('focus-target: 天体 id は ephemeris.positionOf を返す', () => {
    const anchors = stubAnchors({});
    const result = resolveFocusTarget({ kind: 'object', id: 'moon' }, [], 0, anchors, eph, ORIGIN_STATE);
    assert.deepEqual(result.pos, eph.positionOf('moon', 0));
    assert.equal(result.missingFocusFrames, 0);
  });

  test('focus-target: 役割トークンは frameAnchors.stateOf の戻り値を返す', () => {
    const shipState = kinematicState(0, v3(7e6, 0, 0), v3(0, 7500, 0));
    const anchors = stubAnchors({ '@activeShip': shipState });
    const result = resolveFocusTarget({ kind: 'object', id: '@activeShip' }, [], 0, anchors, eph, ORIGIN_STATE);
    assert.equal(result.pos, shipState.r);
  });

  test('focus-target: 機体 id は候補配列の古い位置ではなく frameAnchors.stateOf の値を返す(振動バグ回帰)', () => {
    const freshState = kinematicState(0, v3(1e7, 2e7, 3e7), v3());
    const staleCandidates: readonly FocusCandidate[] = [{ id: 'Ship-1', pos: v3(1, 1, 1) }];
    const anchors = stubAnchors({ 'Ship-1': freshState });
    const result = resolveFocusTarget({ kind: 'object', id: 'Ship-1' }, staleCandidates, 0, anchors, eph, ORIGIN_STATE);
    assert.deepEqual(result.pos, freshState.r);
    assert.notDeepEqual(result.pos, v3(1, 1, 1));
  });

  test('focus-target: 機体でも天体でも役割トークンでもない id は候補配列の位置を返す(ラグランジュ点等)', () => {
    const candidates: readonly FocusCandidate[] = [{ id: 'apsis-1', pos: v3(9, 8, 7) }];
    const anchors = stubAnchors({});
    const result = resolveFocusTarget({ kind: 'object', id: 'apsis-1' }, candidates, 0, anchors, eph, ORIGIN_STATE);
    assert.deepEqual(result.pos, v3(9, 8, 7));
    assert.equal(result.missingFocusFrames, 0);
  });

  test('focus-target: 2フレーム連続で全経路が null なら fallToOrigin', () => {
    const anchors = stubAnchors({});
    const first = resolveFocusTarget({ kind: 'object', id: 'nowhere' }, [], 0, anchors, eph, ORIGIN_STATE);
    assert.equal(first.fallToOrigin, false);
    assert.equal(first.missingFocusFrames, 1);
    const second = resolveFocusTarget({ kind: 'object', id: 'nowhere' }, [], 0, anchors, eph, first);
    assert.equal(second.fallToOrigin, true);
    assert.equal(second.missingFocusFrames, 2);
  });

  test('focus-target: 1フレームだけ解決失敗なら lastResolvedFocus を保ち fallToOrigin にならない', () => {
    const anchors = stubAnchors({});
    const result = resolveFocusTarget({ kind: 'object', id: 'nowhere' }, [], 0, anchors, eph, ORIGIN_STATE);
    assert.equal(result.fallToOrigin, false);
    assert.deepEqual(result.pos, ORIGIN_STATE.lastResolvedFocus);
    assert.deepEqual(result.lastResolvedFocus, ORIGIN_STATE.lastResolvedFocus);
  });
}
