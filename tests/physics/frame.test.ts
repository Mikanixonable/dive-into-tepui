// frame.ts の回帰テスト: 座標系(原点天体 × 回転)の点・KinematicState 順逆変換
// （恒等・往復・既知回転角・速度の有限差分検証・bake+un-bake 合成・原点が動く系）。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { Ephemeris } from '../../src/physics/ephemeris';
import { AttractorId } from '../../src/physics/attractor';
import { FRAMES, ReferenceFrame, toFramePoint, toFrameState, toInertialPoint, toInertialState } from '../../src/physics/frame';
import { qRotate } from '../../src/physics/attitude';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { Vec3, add, addScaled, dot, len, norm, scale, sub, v3 } from '../../src/physics/vec3';

const YEAR = 365.25636 * 86400;

function close(a: Vec3, b: Vec3, tol = 1e-6): boolean {
  return len(sub(a, b)) <= tol * Math.max(1, len(b));
}
function closeState(a: KinematicState, b: KinematicState, tol = 1e-6): boolean {
  return close(a.r, b.r, tol) && close(a.v, b.v, tol);
}

function findFrame(center: AttractorId, rotatingWith: AttractorId | null): ReferenceFrame {
  const f = FRAMES.find((f) => f.center === center && f.rotatingWith === rotatingWith);
  if (!f) throw new Error(`frame not found: ${center}/${rotatingWith}`);
  return f;
}

const EARTH_INERTIAL = findFrame('earth', null);
const SUN_EARTH_ROTATING = findFrame('earth', 'earth');
const MOON_ROTATING = findFrame('earth', 'moon');
const SUN_INERTIAL = findFrame('sun', null);
const MOON_INERTIAL = findFrame('moon', null);

export function register(): void {
  const eph = new Ephemeris({ moon: 0.4 }); // 太陽・月とも初期位相を固定して決定的にする
  // bake 時刻は state 自身のエポック(t)なので、時刻はここで与える。
  const stateAt = (t: number): KinematicState => kinematicState(t, v3(6.8e6, 5e5, 3e6), v3(-1200, 300, 7400));

  test('frame: 地球中心慣性系は順逆とも恒等（state）', () => {
    const t = 12345;
    const s = stateAt(t);
    const tf = eph.frameTransformAt(EARTH_INERTIAL, t);
    assert.ok(closeState(toInertialState(tf, t, toFrameState(tf, s)), s));
  });

  test('frame: 太陽-地球回転系の往復は元に戻る（state・同一時刻）', () => {
    const t = YEAR / 4; // sunAz != 0
    const s = stateAt(t);
    const tf = eph.frameTransformAt(SUN_EARTH_ROTATING, t);
    const back = toInertialState(tf, t, toFrameState(tf, s));
    assert.ok(closeState(back, s), `round trip: ${JSON.stringify(back)} vs ${JSON.stringify(s)}`);
  });

  test('frame: 太陽-地球回転系では太陽がほぼ -X 軸上に静止する(x̂ = 太陽→地球)', () => {
    // 太陽-地球回転系の基底は orbitFrameRotationAt('earth', t)(x̂ = 太陽→地球-月重心の解析方向)。
    // 太陽の実際の地心方向は重心補正(4,673km 級)ぶんだけこの軸からずれるので、
    // 1AU に対して 1e-4 程度の緩い許容にする(軸そのものからのずれは物理的に正しい)。
    for (const t of [0, YEAR / 3, YEAR * 2.7]) {
      const tf = eph.frameTransformAt(SUN_EARTH_ROTATING, t);
      const p = toFramePoint(tf, eph.positionOf('sun', t));
      const dist = len(v3(p.x, p.y, p.z));
      assert.ok(close(v3(p.x, p.y, p.z), v3(-dist, 0, 0), 1e-4), `太陽の位置 (t=${t}): ${JSON.stringify(p)}`);
    }
  });

  test('frame: state 変換と point 変換は同じ位置を返す（太陽-地球回転系）', () => {
    const t = YEAR / 3;
    const s = stateAt(t);
    const tf = eph.frameTransformAt(SUN_EARTH_ROTATING, t);
    const p = toFramePoint(tf, s.r);
    assert.ok(close(toFrameState(tf, s).r, v3(p.x, p.y, p.z)));
  });

  test('frame: point 変換の往復は元に戻る（太陽-地球回転系・同一時刻）', () => {
    const t = YEAR / 6;
    const s = stateAt(t);
    const tf = eph.frameTransformAt(SUN_EARTH_ROTATING, t);
    const back = toInertialPoint(tf, toFramePoint(tf, s.r));
    assert.ok(close(back, s.r));
  });

  test('frame: 回転系速度は回転系位置の時間微分に一致（有限差分, ω×r 項の検証）', () => {
    const t0 = YEAR / 4;
    const s = stateAt(t0);
    const dt = 1;
    // 慣性系で等速直線運動する点の、回転系位置を中心差分して速度を近似する。回転系自体が
    // 時刻とともに向きを変えるので、各時刻ごとにその時刻の座標系変換で bake する。
    const rRelAt = (t: number): Vec3 =>
      toFrameState(eph.frameTransformAt(SUN_EARTH_ROTATING, t), kinematicState(t, addScaled(s.r, s.v, t - t0), s.v)).r;
    const vFd = scale(sub(rRelAt(t0 + dt), rRelAt(t0 - dt)), 1 / (2 * dt));
    const vAnalytic = toFrameState(eph.frameTransformAt(SUN_EARTH_ROTATING, t0), s).v;
    // ω×r 項(~1.4 m/s)を落とすと数 m/s ずれる。有限差分自体は 1e-3 m/s より高精度。
    assert.ok(len(sub(vFd, vAnalytic)) < 1e-2, `v mismatch: ${JSON.stringify(vFd)} vs ${JSON.stringify(vAnalytic)}`);
  });

  test('frame: 地球中心慣性系の un-bake クォータニオンは恒等', () => {
    const tf = eph.frameTransformAt(EARTH_INERTIAL, 12345);
    assert.deepEqual(tf.q, { x: 0, y: 0, z: 0, w: 1 });
  });

  test('frame: un-bake クォータニオン回転は toInertialPoint と一致（メッシュ剛体 un-bake ≡ ピッキング）', () => {
    // 描画: 頂点は toFramePoint で bake → メッシュ全体を tf.q で剛体回転 + tf.origin だけ平行移動。
    // ピッキング: toInertialPoint が点単位で un-bake。両者が一致しないと描画とクリック判定がずれる。
    const tSample = YEAR / 5;
    const tNow = YEAR / 4;
    const s = stateAt(tSample);
    const tfSample = eph.frameTransformAt(SUN_EARTH_ROTATING, tSample);
    const tfNow = eph.frameTransformAt(SUN_EARTH_ROTATING, tNow);
    const baked = toFramePoint(tfSample, s.r);
    const viaQuat = add(qRotate(tfNow.q, v3(baked.x, baked.y, baked.z)), tfNow.origin);
    const viaPoint = toInertialPoint(tfNow, baked);
    assert.ok(close(viaQuat, viaPoint), `quat: ${JSON.stringify(viaQuat)} vs point: ${JSON.stringify(viaPoint)}`);
  });

  test('frame: bake(t) + un-bake(T) は基準天体に対する相対配置を保つ剛体回転', () => {
    // 回転系で軌跡を描く意味そのもの: 時刻 t の点を時刻 T へ un-bake すると、基準天体
    // (太陽・月)から見た方向と距離が bake 時のまま保たれる。
    const tSample = YEAR / 5;
    const tNow = YEAR / 4;
    const s = stateAt(tSample);
    const cases = [
      [SUN_EARTH_ROTATING, '太陽-地球回転系', (t: number) => eph.positionOf('sun', t)],
      [MOON_ROTATING, '地球-月回転系', (t: number) => eph.positionOf('moon', t)],
    ] as const;
    for (const [frame, label, bodyPos] of cases) {
      const tfSample = eph.frameTransformAt(frame, tSample);
      const tfNow = eph.frameTransformAt(frame, tNow);
      const net = toInertialState(tfNow, tNow, toFrameState(tfSample, s));
      assert.ok(Math.abs(len(net.r) - len(s.r)) < 1e-6 * len(s.r), `${label}: 距離が変わった`);
      const before = dot(norm(s.r), norm(bodyPos(tSample)));
      const after = dot(norm(net.r), norm(bodyPos(tNow)));
      // 太陽-地球回転系は解析的な地球-月重心方向を軸に取るため、太陽の実方向(月による
      // 重心補正ぶん、~3e-5 rad 級で揺れる)からわずかにずれる。月回転系の軸は
      // 月の平均要素(二体部分)のみで組まれ、月の実位置は太陽摂動の周期項ぶん
      // そこから最大 2.5° ほどずれる(satellite-orbit.ts 参照)。
      const tol = label === '太陽-地球回転系' ? 1e-4 : 3e-2;
      assert.ok(Math.abs(before - after) < tol, `${label}: 天体との相対角が変わった (${before} vs ${after})`);
      // un-bake 後のエポックは描画時刻 tNow(bake 時刻ではない)。
      assert.equal(net.t, tNow);
    }
  });

  test('frame: 月回転系の往復は元に戻る（state・同一時刻）', () => {
    const t = 1.3e6;
    const s = stateAt(t);
    const tf = eph.frameTransformAt(MOON_ROTATING, t);
    const back = toInertialState(tf, t, toFrameState(tf, s));
    assert.ok(closeState(back, s), `round trip: ${JSON.stringify(back)} vs ${JSON.stringify(s)}`);
  });

  test('frame: 月回転系では月がほぼ +X 軸上にある(周期摂動ぶん最大2.5°ずれる)', () => {
    // 月回転系の基底(x̂ = 月方向)は二体部分(平均要素)のみで組まれるため、太陽摂動の
    // 周期項ぶん月の実位置は x̂ 軸から最大 2.5° ほどずれる(satellite-orbit.ts 参照)。
    for (const t of [0, 3e5, 2.4e6, 1e8]) {
      const tf = eph.frameTransformAt(MOON_ROTATING, t);
      const p = toFramePoint(tf, eph.positionOf('moon', t));
      const dist = len(v3(p.x, p.y, p.z));
      const angleFromXDeg = (Math.acos(p.x / dist) * 180) / Math.PI;
      assert.ok(angleFromXDeg < 2.5, `月の位置が x̂ から離れすぎる (t=${t}): ${angleFromXDeg}°`);
    }
  });

  test('frame: 月回転系の速度は回転系位置の時間微分に一致（有限差分, ω×r 項の検証）', () => {
    const t0 = 2.4e6;
    const s = stateAt(t0);
    const dt = 1;
    const rRelAt = (t: number): Vec3 =>
      toFrameState(eph.frameTransformAt(MOON_ROTATING, t), kinematicState(t, addScaled(s.r, s.v, t - t0), s.v)).r;
    const vFd = scale(sub(rRelAt(t0 + dt), rRelAt(t0 - dt)), 1 / (2 * dt));
    const vAnalytic = toFrameState(eph.frameTransformAt(MOON_ROTATING, t0), s).v;
    assert.ok(len(sub(vFd, vAnalytic)) < 1e-2, `v mismatch: ${JSON.stringify(vFd)} vs ${JSON.stringify(vAnalytic)}`);
  });

  test('frame: 月中心慣性系では月は常に原点にいる', () => {
    for (const t of [0, YEAR / 4, YEAR * 1.7]) {
      const tf = eph.frameTransformAt(MOON_INERTIAL, t);
      const p = toFramePoint(tf, eph.positionOf('moon', t));
      assert.ok(len(v3(p.x, p.y, p.z)) < 1e-6, `t=${t}: ${JSON.stringify(p)}`);
    }
  });

  test('frame: 太陽中心慣性系では太陽は常に原点にいる', () => {
    for (const t of [0, YEAR / 4, YEAR * 1.7]) {
      const tf = eph.frameTransformAt(SUN_INERTIAL, t);
      const p = toFramePoint(tf, eph.positionOf('sun', t));
      assert.ok(len(v3(p.x, p.y, p.z)) < 1e-6, `t=${t}: ${JSON.stringify(p)}`);
    }
  });
}
