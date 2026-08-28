// frame-anchors.ts の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { FrameAnchors } from '../../src/game/frame-anchors';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/math/vec3';

export function register(): void {
  const shipState = kinematicState(0, v3(7e6, 0, 0), v3(0, 7500, 0));
  // t に応じて違う状態を返す(円軌道ふうに x を t だけ進める)。stateOf(id, t) が実際に
  // 渡された t の状態を返しているかを、固定値を返すスタブでは見逃してしまうため。
  const shipStateAt = (t: number): KinematicState => t === 0 ? shipState : kinematicState(t, v3(7e6 + t, 0, 0), v3(0, 7500, 0));

  function anchorsWithShip(): { anchors: FrameAnchors; setShip: (s: KinematicState | null) => void } {
    let ship: ((t: number) => KinematicState) | null = shipStateAt;
    const anchors = new FrameAnchors({
      entityState: () => null,
      activeShipState: (t) => ship?.(t) ?? null,
      navTargetState: () => null,
    });
    anchors.update([]);
    return { anchors, setShip: (s) => { ship = s === null ? null : () => s; } };
  }

  test('frame-anchors: 役割トークンは解決できる間はその状態を返す', () => {
    const { anchors } = anchorsWithShip();
    assert.equal(anchors.stateOf('@activeShip', 0), shipState);
  });

  test('frame-anchors: stateOf(id, t) は渡された t の状態を返す', () => {
    const { anchors } = anchorsWithShip();
    assert.deepEqual(anchors.stateOf('@activeShip', 500), shipStateAt(500));
    assert.deepEqual(anchors.stateOf('@activeShip', 1000), shipStateAt(1000));
  });

  // 猶予は「フレーム」で数える。呼び出し回数で数えると、1フレームのうちにカメラ・軌道フレーム・
  // attractorOf が重ねて問うだけで猶予を使い切り、乗り換えの瞬間に原点が ECI へ飛ぶ。
  test('frame-anchors: 同じフレーム内で何度問われても猶予を使い切らない', () => {
    const { anchors, setShip } = anchorsWithShip();
    anchors.stateOf('@activeShip', 0);
    setShip(null);
    for (let i = 0; i < 5; i++) {
      assert.equal(anchors.stateOf('@activeShip', 0), shipState, `${i} 回目で直前の状態を失った`);
    }
  });

  test('frame-anchors: 2フレーム連続で解決できなければ null になる', () => {
    const { anchors, setShip } = anchorsWithShip();
    anchors.stateOf('@activeShip', 0);
    setShip(null);
    assert.equal(anchors.stateOf('@activeShip', 0), shipState);
    anchors.update([]);
    assert.equal(anchors.stateOf('@activeShip', 0), null);
  });

  test('frame-anchors: 解決が戻れば猶予も戻る', () => {
    const { anchors, setShip } = anchorsWithShip();
    anchors.stateOf('@activeShip', 0);
    setShip(null);
    anchors.stateOf('@activeShip', 0);
    anchors.update([]);
    setShip(shipState);
    assert.equal(anchors.stateOf('@activeShip', 0), shipState);
    setShip(null);
    anchors.update([]);
    assert.equal(anchors.stateOf('@activeShip', 0), shipState, '猶予が戻っていない');
  });
}
