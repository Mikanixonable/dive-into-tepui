// dynamic view が受け取る1体ぶんの表示入力(DynamicRenderSource)の回帰テスト。View が本体の
// 位置をその狭い時刻 query から引くこと、生存と可視の宣言がそのまま本体の表示可否になること、
// そして噴射エフェクトの揺らぎが表示時刻だけで決まる(同じ時刻に何度同期しても同じ絵になる)
// ことを見る。色・大きさ・振幅といった調整値は固定しない。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { CameraView } from '../../src/render/camera/camera-view';
import { DynamicView, type DynamicRenderSource, type DynamicViewFrame } from '../../src/render/dynamic/dynamic-view';
import { InstancedPools } from '../../src/render/dynamic/instanced-pools';
import { ThrustEffects } from '../../src/render/dynamic/player/thrust-effects';
import { RcsEffects } from '../../src/render/dynamic/player/rcs-effects';
import { DEFAULT_PROTEIN_DISPLAY } from '../../src/render/protein/protein-display';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import { Q_IDENTITY } from '../../src/math/quat';
import { add, len, sub, v3, type Vec3 } from '../../src/math/vec3';
import type { CameraFrame } from '../../src/render/camera/camera-frame';
import type { Viewpoint } from '../../src/math/projection';
import type { Viewport } from '../../src/render/viewport';

const VIEWPORT: Viewport = { width: 1600, height: 900, pixelRatio: 1 };

// 種別ごとの見た目を足さず、全個体に共通する同期だけを行う View。
class BareView extends DynamicView {}

// 表示時刻。噴射の揺らぎはこの値だけで決まるので、複数回の同期で同じ値を使う。
const DISPLAY_TIME = 1234.5;
// 揺らぎが表示時刻で動くことを見るための、互いに異なる表示時刻。
const OTHER_DISPLAY_TIMES = [DISPLAY_TIME + 0.05, DISPLAY_TIME + 0.1, DISPLAY_TIME + 0.15];

// 発光ビルボードが共有するグローテクスチャは canvas から作られる。node には DOM が無いので、
// その生成が読む面だけを立てる。
function installCanvasStub(): void {
  const context = {
    createRadialGradient: () => ({ addColorStop: () => {} }),
    fillStyle: '' as unknown,
    fillRect: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
    }),
  };
  const document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
  (globalThis as unknown as Record<string, unknown>).document = document;
}

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
  return new CameraView().sync(viewpoint, 50, 4.0e7, VIEWPORT, false, v3());
}

// 表示時刻とカメラだけを持つ、そのフレームの共通入力。
function viewFrame(camera: CameraFrame, pools: InstancedPools): DynamicViewFrame {
  return {
    displayTime: DISPLAY_TIME,
    camera,
    style: 'realistic',
    visual: { proteinVibration: false },
    proteinDisplay: DEFAULT_PROTEIN_DISPLAY,
    pools,
  };
}

// 1体ぶんの表示入力。stateAt は表示時刻に対する応答で、null なら状態を引けないフレーム。
function renderSource(
  alive: boolean, stateAt: (t: number) => KinematicState | null,
): DynamicRenderSource {
  return {
    id: 'entity-0',
    name: 'entity-0',
    alive,
    stateAt,
    attitude: Q_IDENTITY,
    thermal: null,
  };
}

// 表示時刻に position を返す状態と、問い合わせを受けた時刻の記録。
function stateSource(position: Vec3, asked: number[]): (t: number) => KinematicState | null {
  return (t) => {
    asked.push(t);
    return kinematicState<'eci'>(t, position, v3());
  };
}

// scene 直下のビルボードの見え方を、比較できる素の値へ落とす。
function billboardStates(scene: THREE.Scene): unknown[] {
  return scene.children.map((child) => {
    const mesh = child as THREE.Mesh;
    const material = mesh.material as THREE.MeshBasicMaterial;
    return [
      mesh.visible,
      mesh.position.toArray(),
      mesh.scale.toArray(),
      material.color.toArray(),
    ];
  });
}

// 同じ入力を表示時刻だけ変えて同期し、そのたびのビルボードの見え方を文字列で集める。
function statesOverTimes(
  scene: THREE.Scene, times: readonly number[], syncAt: (displayTime: number) => void,
): Set<string> {
  const seen = new Set<string>();
  for (const time of times) {
    syncAt(time);
    seen.add(JSON.stringify(billboardStates(scene)));
  }
  return seen;
}

export function register(): void {
  installCanvasStub();

  test('dynamic view source: 本体は表示入力の時刻 query が返した状態へ置かれる', () => {
    const camera = cameraFrame();
    const pools = new InstancedPools([]);
    const view = new BareView(new THREE.Object3D());
    const asked: number[] = [];
    const position = v3(7.0e6, 1.0e6, -2.0e6);

    view.sync(renderSource(true, stateSource(position, asked)), viewFrame(camera, pools));

    assert.deepEqual(asked, [DISPLAY_TIME], '表示時刻以外の時刻を引いている');
    assert.ok(view.object.visible, '状態を引けたのに本体が出ていない');
    // 描画原点を足し戻せば、時刻 query が返した ECI 位置に一致する。
    const drawn = view.object.position;
    const eci = add(v3(drawn.x, drawn.y, drawn.z), camera.floatingOrigin.r);
    assert.ok(len(sub(eci, position)) < 1e-6, '本体が時刻 query の位置に置かれていない');
  });

  test('dynamic view source: alive が false のフレームは本体を出さない', () => {
    const camera = cameraFrame();
    const pools = new InstancedPools([]);
    const view = new BareView(new THREE.Object3D());
    const asked: number[] = [];
    const source = renderSource(false, stateSource(v3(7.0e6, 0, 0), asked));

    view.sync(source, viewFrame(camera, pools));

    assert.equal(view.object.visible, false, '死んだ個体の本体が出ている');
    assert.deepEqual(asked, [], '死んだ個体の状態を引いている');
  });

  test('dynamic view source: 状態を引けないフレームは本体を出さない', () => {
    const camera = cameraFrame();
    const pools = new InstancedPools([]);
    const view = new BareView(new THREE.Object3D());

    view.sync(renderSource(true, () => null), viewFrame(camera, pools));

    assert.equal(view.object.visible, false, '状態を引けないのに本体が出ている');
  });

  test('dynamic view source: マニューバ噴射の揺らぎは表示時刻だけで決まる', () => {
    const scene = new THREE.Scene();
    const effects = new ThrustEffects(scene, 'entity-0');
    const anchor = new THREE.Object3D();
    anchor.updateWorldMatrix(true, false);
    const syncAt = (displayTime: number): void => effects.syncFromAnchor(
      anchor, 0.6, true, new THREE.Quaternion(), false, 'realistic', displayTime,
    );

    syncAt(DISPLAY_TIME);
    const first = billboardStates(scene);
    syncAt(DISPLAY_TIME);
    assert.deepEqual(billboardStates(scene), first, '同じ表示時刻で再同期すると絵が変わる');

    const varied = statesOverTimes(scene, OTHER_DISPLAY_TIMES, syncAt);
    assert.ok(varied.size > 1, '表示時刻を変えても揺らぎが動かない');
  });

  test('dynamic view source: module thrust anchor の出口から排気方向へプルームを置く', () => {
    const scene = new THREE.Scene();
    const effects = new ThrustEffects(scene, 'entity-anchor');
    const anchor = new THREE.Object3D();
    anchor.position.set(4, 5, 6);
    anchor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1));
    anchor.updateWorldMatrix(true, false);
    effects.syncFromAnchor(anchor, 0.5, true, new THREE.Quaternion(), false, 'realistic', DISPLAY_TIME);
    const core = scene.children[0];
    assert.ok(core !== undefined);
    assert.ok(core.position.x === 4 && core.position.y === 5 && core.position.z < 6);
    effects.syncFromAnchor(anchor, 0, true, new THREE.Quaternion(), false, 'realistic', DISPLAY_TIME);
    assert.equal(core.visible, false);
    effects.dispose(scene);
  });

  test('dynamic view source: RCS パフの揺らぎは表示時刻だけで決まる', () => {
    const scene = new THREE.Scene();
    const effects = new RcsEffects(scene, 'entity-0');
    const root = new THREE.Object3D();
    const anchor = new THREE.Object3D();
    anchor.position.set(2, 0, 0);
    anchor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
    root.add(anchor);
    root.updateWorldMatrix(true, true);
    const syncAt = (displayTime: number): void => effects.syncFromAnchors(
      root, [anchor], v3(0, 0, -1), true, new THREE.Quaternion(), false, displayTime,
    );

    syncAt(DISPLAY_TIME);
    const first = billboardStates(scene);
    assert.ok(
      scene.children.some((child) => child.visible), '寄与するノズルが1つも噴いていない');
    syncAt(DISPLAY_TIME);
    assert.deepEqual(billboardStates(scene), first, '同じ表示時刻で再同期すると絵が変わる');

    const varied = statesOverTimes(scene, OTHER_DISPLAY_TIMES, syncAt);
    assert.ok(varied.size > 1, '表示時刻を変えても揺らぎが動かない');
  });

  test('dynamic view source: module RCS anchor の位置と向きから噴射を選ぶ', () => {
    const scene = new THREE.Scene();
    const effects = new RcsEffects(scene, 'entity-anchor');
    const root = new THREE.Object3D();
    root.position.set(10, 20, 30);
    const anchor = new THREE.Object3D();
    anchor.position.set(2, 0, 0);
    // anchor +Z を +Y の排気方向へ向ける。反力は -Y なので -Z torque を生む。
    anchor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
    root.add(anchor);
    root.updateWorldMatrix(true, true);

    effects.syncFromAnchors(
      root, [anchor], v3(0, 0, -1), true, new THREE.Quaternion(), false, DISPLAY_TIME,
    );

    const child = scene.children[0];
    assert.ok(child !== undefined);
    assert.equal(child.visible, true);
    assert.deepEqual(child.position.toArray(), [12, 20.55, 30]);
    effects.dispose(scene);
  });
}
