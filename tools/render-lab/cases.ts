// 描画テスト環境のケースの表。分野ごとのファイルのケースを名前で並べ、線の描画順・光路の積分・
// 土星のケースはここで組む。
import * as THREE from 'three/webgpu';
import { Fn, exp, float, max, select, uv, vec3 } from 'three/tsl';
import { ringShadowBands } from '../../src/render/pipeline/shadow/ring-shadow';
import { rayMarch, type MediumSample } from '../../src/render/ray-march';
import { RingView } from '../../src/render/celestial/ring-view';
import { SATURN, SATURN_TEXTURE } from '../../src/game/celestial/solar-system/saturn-system';
import { metersPerPixelAtDepth } from '../../src/math/projection';
import { v3 } from '../../src/math/vec3';
import { LINE_RENDER_ORDER, type LineStyle } from '../../src/render/line-style';
import { PROTEIN_CASES } from './protein-cases';
import { SHIP_CASES } from './ship-cases';
import { EARTH_CASES } from './earth-cases';
import { MATERIAL_CASES } from './material-cases';
import { SHADOW_CASES } from './shadow-cases';
import { CLOUD_OPTICAL_VOLUME_CASE } from './cloud-optical-volume-case';
import { CLOUD_EVENT_OPTICAL_VOLUME_CASE } from './cloud-event-optical-volume-case';
import {
  circle, CLOSE_UP_DIAMETER_PX, FOV_DEG, labCamera, texturedBody, VIEW_HEIGHT, VIEW_WIDTH,
  type CaseBuilder, type LabCase,
} from './lab-case';
import type { LabViewAngles } from './view-angles';
import type { RingMaterials } from '../../src/render/celestial/ring';
import type { FloatNode } from '../../src/render/tsl-types';
import type { RenderStyle } from '../../src/render/render-style';

// 土星の実データの環。
const SATURN_RINGS = (() => {
  if (SATURN.rings === undefined) throw new Error('saturn has no rings');
  return SATURN.rings;
})();

// 描画順ケースの円の識別色。LINE_RENDER_ORDER の並びと同じ順で当てる。
const ORDER_COLORS = [0x5a6572, 0x4f8fd0, 0x59c3a5, 0xd8c24a, 0xff6a00] as const;

// 描画順: 同じ深度に置いた円が LINE_RENDER_ORDER の順に重なるか。
// 交差点でどちらが上に出るかがそのまま答えになる。
function order(): LabCase {
  const camera = labCamera();
  const depth = 1e4;
  const radius = 3e3;
  const u = new THREE.Vector3(1, 0, 0);
  const v = new THREE.Vector3(0, 1, 0);
  // 円を横へ少しずつずらして重ね、交差点を作る。
  const objects: THREE.Object3D[] = [backdrop(5e4)];
  for (const [i, renderOrder] of Object.values(LINE_RENDER_ORDER).entries()) {
    const center = new THREE.Vector3((i - 2) * radius * 0.06, 0, -depth);
    const style: LineStyle = { color: ORDER_COLORS[i]!, opacity: 1, renderOrder };
    objects.push(circle(center, radius, u, v, style, camera));
  }
  return { objects, camera };
}

// 星殻の代わりの背景板。深度を比べず、どの不透明物より先に描かれる。
function backdrop(depth: number): THREE.Object3D {
  const halfHeight = Math.tan((FOV_DEG / 2) * Math.PI / 180) * depth;
  const geometry = new THREE.PlaneGeometry(halfHeight * 2 * (VIEW_WIDTH / VIEW_HEIGHT) * 1.2, halfHeight * 2 * 1.2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x0d1219, depthTest: false }));
  mesh.position.set(0, 0, -depth);
  mesh.renderOrder = -10;
  return mesh;
}

// 積分ヘルパの検証に使う板の距離と、画面いっぱいに広がる大きさ [m]。
const SLAB_PLANE_DISTANCE = 100;
const SLAB_PLANE_HEIGHT = 2 * SLAB_PLANE_DISTANCE * Math.tan(THREE.MathUtils.degToRad(FOV_DEG / 2));
const SLAB_PLANE_WIDTH = (SLAB_PLANE_HEIGHT * VIEW_WIDTH) / VIEW_HEIGHT;

// 積分ヘルパの検証に使う一様媒質の板。消散係数 × 基準の厚みで光学的厚み 1 になる。
const SLAB_EXTINCTION = 2e-4; // [1/m]
const SLAB_LENGTH = 5e3; // [m]
const SLAB_STEPS = 24;
// 板の見かけの誤差を読むための拡大率。1% の食い違いが中間の灰色として出る。
const SLAB_ERROR_GAIN = 100;

// 積分ヘルパ: 一様な媒質を、サンプル点の刻みを変えて2通りに積分し、解析解と並べて映す。
// 上から順に 解析解 / 等間隔の刻み / 前へ寄せた刻み / 解析解との差(拡大)の4帯。
// **上3帯が同じ濃さで、最下段が黒なら、刻みが不均等でも同じ答えが出ている。**
// 光学的厚みは画面の左から右へ 0.2 から 1.8 まで変える。
function marchSlab(): LabCase {
  const camera = labCamera();
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(SLAB_PLANE_WIDTH, SLAB_PLANE_HEIGHT),
    new THREE.MeshBasicNodeMaterial(),
  );
  plane.position.set(0, 0, -SLAB_PLANE_DISTANCE);
  const thickness = float(SLAB_LENGTH).mul(uv().x.mul(1.6).add(0.2));
  const medium = (): MediumSample => ({
    extinction: vec3(SLAB_EXTINCTION, SLAB_EXTINCTION, SLAB_EXTINCTION),
    source: vec3(0, 0, 0),
  });
  const analytic = exp(thickness.mul(-SLAB_EXTINCTION));
  // 積分は toVar と Loop を使うので、Fn の中で組む。
  const transmittanceOf = (warp: (fraction: FloatNode) => FloatNode): FloatNode =>
    Fn(() => rayMarch(float(SLAB_STEPS), warp, medium).transmittance.x)();
  const even = transmittanceOf((f) => thickness.mul(f));
  const bunched = transmittanceOf((f) => thickness.mul(f.mul(f)));
  const error = max(even.sub(analytic).abs(), bunched.sub(analytic).abs()).mul(SLAB_ERROR_GAIN);
  const band = uv().y.mul(4).floor();
  const value = select(
    band.lessThan(1), error,
    select(band.lessThan(2), bunched, select(band.lessThan(3), even, analytic)),
  );
  (plane.material as THREE.MeshBasicNodeMaterial).colorNode = vec3(value, value, value);
  return { objects: [plane], camera };
}

// 土星のケースで本体の中心を置く距離 [m]。本体へ寄った既定の距離と、環の全体が収まる遠景の距離。
const SATURN_NEAR_DISTANCE = 1.9e8;
const SATURN_FAR_DISTANCE = 1.2134e9;
// 本体の中心を環面(水平面)から持ち上げる角 [rad]。カメラは環面の 20° 下、**恒星とは反対側**から
// 本体を見上げる — 同じ側だと影が落ちる面は常に手前の環の腕に隠れ、真横だと環が線に潰れて、影が
// 環を横切る境界を読めない。
const SATURN_CAMERA_TILT = 0.35;

// 遠景の撮影の向き。環面の上から見下ろし、恒星を環軸まわりにカメラから回した方向に置く — 本体と
// 環の全体が並んで収まり、昼面どうしの明るさを見比べられる。
const SATURN_FAR_VIEW: Partial<LabViewAngles> = {
  cameraElevationDeg: 26.7,
  cameraDistanceLog: Math.log10(SATURN_FAR_DISTANCE / SATURN_NEAR_DISTANCE),
  sunAzimuthDeg: 75.4,
  sunElevationDeg: 41.4,
};

// 土星: 実写テクスチャの扁平な本体と実データの環を、環軸を真上(+Y)にして置く。本体を影を落とす
// 天体に、環の帯を影を落とす環に登録するので、**環が本体の影へ入る境界と、本体表面に落ちる環の影の
// 境界の両方**が同じ 1 つの関数から出る。恒星の放射照度は本体にも環にも同じだけ掛かる。
function saturn(style: RenderStyle, ringMaterials: RingMaterials): LabCase {
  const center = new THREE.Vector3(0, Math.sin(SATURN_CAMERA_TILT), -Math.cos(SATURN_CAMERA_TILT))
    .multiplyScalar(SATURN_NEAR_DISTANCE);
  // 視線は正面ではなく本体の中心へ向ける — 影が落ちるのは環面より南側の面なので、正面のままだと
  // 読みたい範囲が画面の下へ外れる。
  const camera = labCamera();
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  const body = texturedBody(SATURN_TEXTURE, SATURN, center, CLOSE_UP_DIAMETER_PX);
  const axis = v3(0, 1, 0);
  const view = new RingView(SATURN_RINGS, SATURN.radius, 1, ringMaterials);
  return {
    objects: [body.object, view.group],
    camera,
    viewTarget: center,
    shadowBodies: [{ center, axes: body.axes, bodyFromWorld: new THREE.Matrix4() }],
    rings: { center, axis: new THREE.Vector3(axis.x, axis.y, axis.z), bands: ringShadowBands(SATURN_RINGS.bands) },
    ready: body.ready,
    // 環の見え方(表示の有無・帯の見かけ幅の段)は設定とカメラの距離で変わるので、押し込みのたびに
    // そのフレームのカメラから同期する。
    sync: (graphics) => view.sync(
      center, axis, v3(center.x, center.y, center.z),
      () => metersPerPixelAtDepth(camera.fov, camera.position.distanceTo(center), VIEW_HEIGHT),
      graphics, style,
    ),
    shots: {
      // 影の境界。**環面へ浅い角度で恒星が差す姿勢**(恒星の仰角 17°)で本体へ寄り、本体表面に落ちる
      // 環の影(カッシーニの間隙が明るい帯として出て、その縁は半影ぶんぼける)と、環が本体の影へ入る
      // 境界(天体の半影ぶんぼける)を同じ絵の中で読む。
      'saturn-shadow': { view: {} },
      // 遠景。**環だけが本体より桁で明るくないか**を見る。本体は画面上 60 px ほどで、半影は読めない。
      'saturn': { view: SATURN_FAR_VIEW },
    },
  };
}

export const CASES = {
  ...EARTH_CASES,
  ...MATERIAL_CASES,
  'saturn': saturn,
  ...SHADOW_CASES,
  'order': order,
  'march-slab': marchSlab,
  'cloud-optical-volume': CLOUD_OPTICAL_VOLUME_CASE,
  'cloud-event-optical-volume': CLOUD_EVENT_OPTICAL_VOLUME_CASE,
  ...SHIP_CASES,
  ...PROTEIN_CASES,
} as const satisfies Record<string, CaseBuilder>;

export type CaseName = keyof typeof CASES;
export const CASE_NAMES = Object.keys(CASES) as readonly CaseName[];
