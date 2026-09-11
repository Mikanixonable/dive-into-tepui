// 軌道線(render/lines/)が当たり判定へ渡すサンプル点列の回帰テスト。同じ入力なら同じ点列を
// 返すこと、線が消えたあとは何も返さないこと、点数が要求した分割数に対応すること、そして点が
// 実際に描いている図形(楕円・線分)の上に載ることを見る。期待値の正本は楕円と線分の定義から
// 導ける不変量と決定論性で、色・不透明度・描画順といった調整値は固定しない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { solarSystemParts } from '../physics/test-helpers';
import { CameraView } from '../../src/render/camera/camera-view';
import { EllipseLine } from '../../src/render/lines/ellipse-line';
import { TargetRelativeLine } from '../../src/render/lines/target-relative-line';
import { TrajectoryLine } from '../../src/render/lines/trajectory-line';
import { LINE_RENDER_ORDER } from '../../src/render/line-style';
import { orbitalElementsFromClassical } from '../../src/physics/elements';
import { DynamicTrajectory } from '../../src/physics/dynamic-trajectory';
import { bodyAnchorSource } from '../../src/physics/attractor';
import { kinematicState } from '../../src/physics/kinematic-state';
import { dot, len, sub, v3 } from '../../src/math/vec3';
import type { LineStyle } from '../../src/render/line-style';
import type { CameraFrame } from '../../src/render/camera/camera-frame';
import type { Viewport } from '../../src/render/viewport';
import type { Viewpoint } from '../../src/math/projection';
import type { OrbitalElements } from '../../src/physics/elements';
import type { Vec3 } from '../../src/math/vec3';

const VIEWPORT: Viewport = { width: 1600, height: 900, pixelRatio: 1 };

// 見た目は結果に効かないので、3種の線で同じ1つを使い回す。
const STYLE: LineStyle = { color: 0xffffff, opacity: 1, renderOrder: LINE_RENDER_ORDER.shipOrbit };

// 当たり判定が要求しうる分割数の幅。点数はこれに対して一貫していなければならない。
const COUNTS = [4, 16, 128];

// 地球原点の現実の太陽系。中心天体・座標系・積分の重力源をここから引く。
const PARTS = solarSystemParts();
const MOON = PARTS.system.motionOf('moon');
const EARTH = PARTS.system.motionOf('earth');
const FRAME = PARTS.referenceFrames.inertialFrame;
const ANCHORS = bodyAnchorSource(PARTS.system.celestialMotions, 0);

// 月まわりの傾いた楕円。中心天体が原点から離れているので、点列が ECI 絶対座標へ戻っている
// かどうかもこれで見える。
const ELEMENTS: OrbitalElements =
  orbitalElementsFromClassical(5.0e6, 0.3, 28, 40, 60, MOON, MOON.stateAt(0));

// 地球を見下ろす視点から作る、1フレームぶんのカメラ。
function cameraFrame(): CameraFrame {
  const viewpoint: Viewpoint = {
    position: v3(4.0e7, 1.0e7, 0),
    lookTarget: v3(),
    up: v3(0, 1, 0),
    fovDeg: 50,
    aspect: VIEWPORT.width / VIEWPORT.height,
    projection: 'perspective',
  };
  return new CameraView().sync(viewpoint, 50, 4.0e7, VIEWPORT, 'map', false, v3());
}

// 地球中心の円軌道を 10 分ぶん積分した軌跡。
function orbitTrajectory(): DynamicTrajectory {
  const radius = 7.0e6;
  const speed = Math.sqrt(EARTH.def.mu / radius);
  const trajectory = new DynamicTrajectory(kinematicState<'eci'>(0, v3(radius, 0, 0), v3(0, 0, -speed)));
  for (let i = 0; i < 60; i++) trajectory.step(10, [EARTH], [], null, 0, 0, 0, null, 10, 1200);
  return trajectory;
}

// 全点が軌道要素の楕円上に載っているか。中心天体相対を軌道面基底へ射影すると、長半径 a と
// 短半径 b から (cos E)² + (sin E)² = 1 が復元できる。
function assertOnEllipse(points: readonly Vec3[], el: OrbitalElements): void {
  const b = el.a * Math.sqrt(1 - el.e * el.e);
  for (const p of points) {
    const rel = sub(p, el.centerState.r);
    const unit = ((dot(rel, el.pHat) + el.a * el.e) / el.a) ** 2 + (dot(rel, el.qHat) / b) ** 2;
    assert.ok(Math.abs(unit - 1) < 1e-9, `点が楕円から外れている (${unit})`);
    assert.ok(Math.abs(dot(rel, el.hHat)) < el.a * 1e-9, '点が軌道面から外れている');
  }
}

export function register(): void {
  test('line-samples: 楕円線は同じ入力なら同じ点列を返す', () => {
    const camera = cameraFrame();
    const line = new EllipseLine(STYLE);
    line.sync(ELEMENTS, STYLE, camera);
    const first = line.samplePoints(64);
    line.sync(ELEMENTS, STYLE, camera);
    assert.deepEqual(line.samplePoints(64), first, '同じ入力で点列が変わる');
    line.dispose();
  });

  test('line-samples: 楕円線の点数は分割数に対応し、点は楕円上に載る', () => {
    const camera = cameraFrame();
    const line = new EllipseLine(STYLE);
    line.sync(ELEMENTS, STYLE, camera);
    for (const count of COUNTS) {
      const points = line.samplePoints(count);
      assert.equal(points.length, count + 1, `分割数 ${count} に対する点数が合わない`);
      assertOnEllipse(points, ELEMENTS);
    }
    line.dispose();
  });

  test('line-samples: 楕円線は要素を失うと点列も空になる', () => {
    const camera = cameraFrame();
    const line = new EllipseLine(STYLE);
    line.sync(ELEMENTS, STYLE, camera);
    assert.ok(line.samplePoints(16).length > 0, '楕円を渡しても点列が空');
    line.sync(null, STYLE, camera);
    assert.deepEqual(line.samplePoints(16), [], '線を消しても点列が残っている');
    line.dispose();
  });

  test('line-samples: 対象相対線の点数は分割数に対応し、両端は結んだ2点に一致する', () => {
    const camera = cameraFrame();
    const selfPos = v3(7.2e6, 1.0e6, -3.0e5);
    const targetPos = v3(7.0e6, 0, 0);
    const line = new TargetRelativeLine(STYLE);
    line.sync(selfPos, targetPos, STYLE, camera);
    const first = line.samplePoints(64);
    line.sync(selfPos, targetPos, STYLE, camera);
    assert.deepEqual(line.samplePoints(64), first, '同じ入力で点列が変わる');
    for (const count of COUNTS) {
      const points = line.samplePoints(count);
      assert.equal(points.length, count + 1, `分割数 ${count} に対する点数が合わない`);
      const span = len(sub(selfPos, targetPos));
      assert.ok(len(sub(points[0]!, targetPos)) < span * 1e-12, '始点が対象の位置に無い');
      assert.ok(len(sub(points[count]!, selfPos)) < span * 1e-12, '終点が自分の位置に無い');
    }
    line.dispose();
  });

  test('line-samples: 軌跡線は同じ入力なら同じ点列を返し、点数は分割数に対応する', () => {
    const camera = cameraFrame();
    const trajectory = orbitTrajectory();
    const line = new TrajectoryLine(STYLE);
    line.sync(trajectory, 0, 600, FRAME, 0, PARTS.system, ANCHORS, STYLE, camera);
    const first = line.samplePoints(64);
    assert.ok(first.length > 0, '軌跡を渡しても点列が空');
    // 2回目は再 bake が抑制される経路を通る。抑制されても点列は変わらない。
    line.sync(trajectory, 0, 600, FRAME, 0, PARTS.system, ANCHORS, STYLE, camera);
    assert.deepEqual(line.samplePoints(64), first, '同じ入力で点列が変わる');
    for (const count of COUNTS) {
      const points = line.samplePoints(count);
      assert.equal(points.length, count + 1, `分割数 ${count} に対する点数が合わない`);
    }
    line.dispose();
  });

  test('line-samples: 軌跡線は軌跡を失うと点列も空になる', () => {
    const camera = cameraFrame();
    const line = new TrajectoryLine(STYLE);
    line.sync(orbitTrajectory(), 0, 600, FRAME, 0, PARTS.system, ANCHORS, STYLE, camera);
    assert.ok(line.samplePoints(16).length > 0, '軌跡を渡しても点列が空');
    line.sync(null, null, null, FRAME, 0, PARTS.system, ANCHORS, STYLE, camera);
    assert.deepEqual(
      line.samplePoints(16), [], '線を消しても点列が残っている');
    line.dispose();
  });
}
