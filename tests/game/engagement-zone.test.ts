// 交戦圏(game/dynamic/engagement-zone.ts)の回帰テスト。SPEC/COMBAT.md「交戦圏」が定める
// 「自機と基地のそれぞれを中心とする半径 30 km の球で、重なるものは1つの交戦圏」を固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/math/vec3';
import {
  ENGAGEMENT_RANGE, EngagementZoneBuilder, engagementZones, type EngagementParticipant,
} from '../../src/game/dynamic/engagement-zone';

// x 軸上の x [m] にいる個体。prevX を渡すと区間 [prevX, x] を渡った個体になる。
function at(
  x: number, engagementAnchor: boolean, prevX = x, alive = true,
): EngagementParticipant {
  return {
    alive,
    engagementAnchor,
    prevState: kinematicState<'eci'>(0, v3(prevX, 0, 0), v3()),
    state: kinematicState<'eci'>(1, v3(x, 0, 0), v3()),
  };
}

export function register(): void {
  test('engagement-zone: 中心になる個体が無ければ交戦圏は無い', () => {
    assert.equal(engagementZones([at(0, false), at(1e3, false)], true).length, 0);
  });

  test('engagement-zone: 交戦できる倍率でなければ中心がいても交戦圏は無い', () => {
    assert.equal(engagementZones([at(0, true)], false).length, 0);
  });

  test('engagement-zone: 球が重なる中心は1つ、離れた中心は別々の交戦圏になる', () => {
    const overlapping = engagementZones([at(0, true), at(50e3, true)], true);
    assert.equal(overlapping.length, 1);
    assert.equal(overlapping[0]!.anchors.length, 2);
    const apart = engagementZones([at(0, true), at(70e3, true)], true);
    assert.equal(apart.length, 2);
    assert.equal(apart[0]!.anchors.length, 1);
    assert.equal(apart[1]!.anchors.length, 1);
  });

  test('engagement-zone: 鎖状に連なる3中心は1つの交戦圏になる', () => {
    const zones = engagementZones([at(0, true), at(50e3, true), at(100e3, true)], true);
    assert.equal(zones.length, 1);
    assert.equal(zones[0]!.anchors.length, 3);
  });

  test('engagement-zone: contains は先頭でない中心の半径以内でも真', () => {
    const zone = engagementZones([at(0, true), at(50e3, true)], true)[0]!;
    assert.equal(zone.contains(v3(75e3, 0, 0)), true);
    assert.equal(zone.contains(v3(ENGAGEMENT_RANGE - 1, 0, 0)), true);
    assert.equal(zone.contains(v3(85e3, 0, 0)), false);
  });

  test('engagement-zone: 死んだ中心は数えない', () => {
    const zones = engagementZones([at(0, true, 0, false), at(70e3, true)], true);
    assert.equal(zones.length, 1);
    assert.deepEqual(zones[0]!.anchors[0]!.state.r, v3(70e3, 0, 0));
    assert.equal(engagementZones([at(0, true, 0, false)], true).length, 0);
  });

  test('engagement-zone: builder は返り値・zone・anchors の器を再利用する', () => {
    const builder = new EngagementZoneBuilder<EngagementParticipant>();
    const zones = builder.build([at(0, true), at(50e3, true)], true);
    const zone = zones[0]!;
    const anchors = zone.anchors;
    assert.equal(zones.length, 1);
    assert.equal(anchors.length, 2);

    const rebuilt = builder.build([at(0, true), at(70e3, true)], true);
    assert.equal(rebuilt, zones, 'active zone 配列を使い回す');
    assert.equal(rebuilt[0], zone, 'zone 実体を使い回す');
    assert.equal(rebuilt[0]!.anchors, anchors, 'anchors 配列を使い回す');
    assert.equal(rebuilt.length, 2);
    assert.deepEqual(rebuilt[0]!.anchors[0]!.state.r, v3(0, 0, 0));
    assert.deepEqual(rebuilt[1]!.anchors[0]!.state.r, v3(70e3, 0, 0));

    assert.equal(builder.build([at(0, true)], false), zones, '無効時も返り値の器は同じ');
    assert.equal(zones.length, 0);
  });
}
