// OrbitGuideView(render/celestial/orbit-guide/)が当たり判定へ渡す点列の回帰テスト。同じ宣言
// なら同じ点列を返すこと、曲線の形が変わらない限り点列を引き直さないこと、宣言が空なら何も
// 返さないことを見る。期待値の正本は決定論性と、形を鍵にした引き直しという不変条件で、色・
// 不透明度・描画順といった調整値は固定しない。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { CameraView } from '../../src/render/camera/camera-view';
import { OrbitGuideView, type GuideLineDisplay } from '../../src/render/celestial/orbit-guide/orbit-guide-view';
import { LINE_RENDER_ORDER } from '../../src/render/line-style';
import { len, sub, v3 } from '../../src/math/vec3';
import type { LineStyle } from '../../src/render/line-style';
import type { CameraFrame } from '../../src/render/camera/camera-frame';
import type { Viewport } from '../../src/render/viewport';
import type { Viewpoint } from '../../src/math/projection';
import type { Vec3 } from '../../src/math/vec3';

const VIEWPORT: Viewport = { width: 1600, height: 900, pixelRatio: 1 };

// 見た目は点列に効かないので、線ごとに変えたいとき以外はこの1つを使い回す。
const STYLE: LineStyle = { color: 0xffffff, opacity: 0.4, renderOrder: LINE_RENDER_ORDER.reference };

// 当たり判定が要求しうる分割数。
const SAMPLES = 64;

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

// center を中心に xy 面を回る半径 radius の円を、閉じた解析曲線として宣言する。
function circleLine(key: string, center: Vec3, radius: number, style: LineStyle): GuideLineDisplay {
  const origin = v3(center.x + radius, center.y, center.z);
  return {
    key, familyId: 'circle', system: null, point: null,
    origin,
    shape: {
      kind: 'analytic',
      sample: (t, out) => {
        const angle = t * Math.PI * 2;
        out.set(
          center.x + radius * Math.cos(angle) - origin.x,
          center.y + radius * Math.sin(angle) - origin.y,
          center.z - origin.z,
        );
      },
    },
    style,
    direction: 'none', animate: false, markerColor: 0xffffff, revolutions: 1,
  };
}

// origin から span だけ伸びる線分を、節点列として宣言する。
function segmentLine(key: string, origin: Vec3, span: Vec3, style: LineStyle): GuideLineDisplay {
  return {
    key, familyId: 'segment', system: null, point: null,
    origin,
    shape: {
      kind: 'hermite',
      knots: {
        ts: [0, 1],
        positions: [0, 0, 0, span.x, span.y, span.z],
        // 両端の接線を弦そのものにすると、3次エルミートが弦と一致する直線に落ちる。
        tangents: [span.x, span.y, span.z, span.x, span.y, span.z],
      },
    },
    style,
    direction: 'none', animate: false, markerColor: 0xffffff, revolutions: 1,
  };
}

// 解析曲線と節点列の2本ぶんの宣言。
function twoLines(radius: number, style: LineStyle): readonly GuideLineDisplay[] {
  return [
    circleLine('circle:0', v3(0, 0, 0), radius, style),
    segmentLine('segment:0', v3(1.0e7, 0, 0), v3(0, 2.0e6, 0), style),
  ];
}

// 曲線の形(shape)と基準点は据え置いたまま、見た目だけ差し替えた宣言。
function restyled(displays: readonly GuideLineDisplay[], style: LineStyle): readonly GuideLineDisplay[] {
  return displays.map((display) => ({ ...display, style }));
}

export function register(): void {
  test('orbit-guide-view: 同じ宣言で2回同期しても同じ点列を返す', () => {
    const camera = cameraFrame();
    const view = new OrbitGuideView(new THREE.Scene());
    const displays = twoLines(7.0e6, STYLE);
    view.sync(displays, camera, 0);
    const first = view.visibleLines(SAMPLES).map((line) => ({ key: line.key, points: [...line.points] }));
    assert.equal(first.length, displays.length, '宣言した本数ぶんの線が返らない');
    for (const line of first) assert.equal(line.points.length, SAMPLES + 1, '点数が分割数に対応しない');
    view.sync(displays, camera, 0);
    const second = view.visibleLines(SAMPLES).map((line) => ({ key: line.key, points: [...line.points] }));
    assert.deepEqual(second, first, '同じ宣言で点列が変わる');
    view.dispose();
  });

  test('orbit-guide-view: 曲線の形が変わったときだけ点列を引き直す', () => {
    const camera = cameraFrame();
    const view = new OrbitGuideView(new THREE.Scene());
    const radius = 7.0e6;
    const displays = twoLines(radius, STYLE);
    view.sync(displays, camera, 0);
    const first = view.visibleLines(SAMPLES);

    // 形は据え置いたまま見た目だけ差し替えたフレームでは、同じ点列の配列がそのまま返る。
    view.sync(restyled(displays, { ...STYLE, opacity: 1 }), camera, 0);
    const kept = view.visibleLines(SAMPLES);
    for (const [i, line] of kept.entries()) {
      assert.equal(line.points, first[i]!.points, `形が同じなのに点列を引き直している (${line.key})`);
    }

    // 形が変われば引き直す。円の半径を変えたので、点も新しい円の上に載る。
    const grownRadius = radius * 2;
    view.sync(twoLines(grownRadius, STYLE), camera, 0);
    const grown = view.visibleLines(SAMPLES);
    assert.notEqual(grown[0]!.points, first[0]!.points, '形を変えても点列が引き直されない');
    for (const point of grown[0]!.points) {
      assert.ok(Math.abs(len(sub(point, v3(0, 0, 0))) - grownRadius) < grownRadius * 1e-9, '点が新しい円から外れている');
    }
    view.dispose();
  });

  test('orbit-guide-view: 宣言が空なら表示中の線も空になる', () => {
    const camera = cameraFrame();
    const view = new OrbitGuideView(new THREE.Scene());
    view.sync(twoLines(7.0e6, STYLE), camera, 0);
    assert.ok(view.visibleLines(SAMPLES).length > 0, '宣言を渡しても線が返らない');
    view.sync([], camera, 0);
    assert.deepEqual(view.visibleLines(SAMPLES), [], '宣言を空にしても線が残っている');
    view.dispose();
  });
}
