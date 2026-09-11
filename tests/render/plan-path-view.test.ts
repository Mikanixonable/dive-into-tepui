// PlanPathView(render/plan/plan-path-view.ts)の回帰テスト。宣言した弧の本数だけが折れ線として
// 描かれること、宣言から外れた弧が点列から消えること、同じ宣言なら同じ点列を返すことを見る。
// 期待値の正本は宣言と描画の対応という不変条件と決定論性で、色・不透明度・破線の刻みは固定しない。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { solarSystemParts } from '../physics/test-helpers';
import { CameraView } from '../../src/render/camera/camera-view';
import { PlanPathView } from '../../src/render/plan/plan-path-view';
import { LINE_RENDER_ORDER } from '../../src/render/line-style';
import { DynamicTrajectory } from '../../src/physics/dynamic-trajectory';
import { bodyAnchorSource } from '../../src/physics/attractor';
import { kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/math/vec3';
import type { PlanArcLine } from '../../src/render/plan/plan-path-view';
import type { LineStyle } from '../../src/render/line-style';
import type { CameraFrame } from '../../src/render/camera/camera-frame';
import type { Viewport } from '../../src/render/viewport';
import type { Viewpoint } from '../../src/math/projection';

const VIEWPORT: Viewport = { width: 1600, height: 900, pixelRatio: 1 };

// 見た目は点列に効かないので、全区間で同じ1つを使い回す。
const STYLE: LineStyle = { color: 0xffffff, opacity: 1, renderOrder: LINE_RENDER_ORDER.plan };

// 当たり判定が要求しうる分割数。
const SAMPLE_COUNT = 64;

// 地球原点の現実の太陽系。座標系・積分の重力源をここから引く。
const PARTS = solarSystemParts();
const EARTH = PARTS.system.motionOf('earth');
const FRAME = PARTS.referenceFrames.inertialFrame;
const ANCHORS = bodyAnchorSource(PARTS.system.celestialMotions, 0);

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

// 地球中心の円軌道を 600 秒ぶん積分した軌跡。
function orbitTrajectory(): DynamicTrajectory {
  const radius = 7.0e6;
  const speed = Math.sqrt(EARTH.def.mu / radius);
  const trajectory = new DynamicTrajectory(kinematicState<'eci'>(0, v3(radius, 0, 0), v3(0, 0, -speed)));
  for (let i = 0; i < 60; i++) trajectory.step(10, [EARTH], [], null, 0, 0, 0, null, 10, 1200);
  return trajectory;
}

// 積分した軌跡を、時刻で3つに割った区間の宣言。計画のノード数が減ったときのように、
// 先頭から count 本だけを宣言できる。
function arcLines(trajectory: DynamicTrajectory, count: number): readonly PlanArcLine[] {
  const bounds = [0, 200, 400, 600];
  const all = [0, 1, 2].map((i) => ({
    trajectory, from: bounds[i]!, to: bounds[i + 1]!, frame: FRAME, style: STYLE,
  }));
  return all.slice(0, count);
}

// view が描いている点列。区間ごとに1本ずつ返る。
function lineSamples(view: PlanPathView): readonly (readonly unknown[])[] {
  return view.lineSamples(SAMPLE_COUNT);
}

export function register(): void {
  test('plan-path-view: 宣言した弧の本数だけ線が描かれ、宣言から外れた弧は消える', () => {
    const view = new PlanPathView(new THREE.Scene());
    const trajectory = orbitTrajectory();
    const camera = cameraFrame();

    view.sync(arcLines(trajectory, 3), 0, PARTS.system, ANCHORS, camera);
    const three = lineSamples(view);
    assert.equal(three.length, 3, '宣言した弧の本数と線の本数が合わない');
    for (const points of three) {
      assert.equal(points.length, SAMPLE_COUNT + 1, '分割数に対する点数が合わない');
    }

    // 区間が減ったフレームでは、残った弧だけが同じ点列を返す。
    view.sync(arcLines(trajectory, 1), 0, PARTS.system, ANCHORS, camera);
    const one = lineSamples(view);
    assert.equal(one.length, 1, '宣言から外れた弧の線が残っている');
    assert.deepEqual(one[0], three[0], '残った弧の点列が変わっている');

    view.dispose();
  });

  test('plan-path-view: 同じ宣言なら同じ点列を返す', () => {
    const view = new PlanPathView(new THREE.Scene());
    const trajectory = orbitTrajectory();
    const camera = cameraFrame();

    view.sync(arcLines(trajectory, 3), 0, PARTS.system, ANCHORS, camera);
    const first = lineSamples(view);
    // 2回目は再 bake が抑制される経路を通る。抑制されても点列は変わらない。
    view.sync(arcLines(trajectory, 3), 0, PARTS.system, ANCHORS, camera);
    assert.deepEqual(lineSamples(view), first, '同じ宣言で点列が変わる');

    view.dispose();
  });

  test('plan-path-view: 空の宣言で同期すると点列も空になる', () => {
    const view = new PlanPathView(new THREE.Scene());
    const trajectory = orbitTrajectory();
    const camera = cameraFrame();

    view.sync(arcLines(trajectory, 3), 0, PARTS.system, ANCHORS, camera);
    assert.ok(lineSamples(view).length > 0, '弧を宣言しても点列が空');
    view.sync([], 0, PARTS.system, ANCHORS, camera);
    assert.deepEqual(lineSamples(view), [], '線を消しても点列が残っている');

    view.dispose();
  });
}
