// 描画テスト環境が描くケースの表。ゲーム本体と同じ球・艦・線を組んでカメラと一緒に返すだけで、
// シーンへ足すのもチャンネルを振るのも呼び出し側の仕事。ケースを増やすのはこの表への追記で済む。
import * as THREE from 'three/webgpu';
import { CelestialSurface } from '../../src/render/celestial-surface';
import { Curve } from '../../src/render/curve';
import { buildPlayerShip } from '../../src/render/ships';
import { markLitOpaque } from '../../src/render/pipeline/lit-layer';
import type { Occluder, RingBand } from '../../src/render/pipeline/occlusion';
import type { LineStyle } from '../../src/render/line-style';
import { LINE_RENDER_ORDER } from '../../src/game/const';

// 描画は 960×540 固定(撮影した PNG の大きさを決め打ちにするため)。
export const VIEW_WIDTH = 960;
export const VIEW_HEIGHT = 540;
const FOV_DEG = 50;

// 全ケース共通の恒星方向。球の陰影と、呼び出し側が置く光源が同じ向きを使う。
export const SUN_DIR = new THREE.Vector3(1, 0.35, 0.5).normalize();

// カメラは常に原点から -Z を見る。near はゲーム本体と同じ 2 m(深度分解能の導出がこの値に乗る)。
const EYE = new THREE.Vector3(0, 0, 0);
const AHEAD = new THREE.Vector3(0, 0, -1);
const NEAR = 2;

export type LabCase = {
  readonly objects: readonly THREE.Object3D[];
  readonly camera: THREE.PerspectiveCamera;
  // 遮蔽パスへ渡す球。フォワード経路は遮蔽を持たないので、影は 2 経路の差としても出る。
  readonly occluders?: readonly Occluder[];
  // 遮蔽パスへ渡す環。中心と法線軸は描画座標。
  readonly rings?: { readonly center: THREE.Vector3; readonly axis: THREE.Vector3; readonly bands: readonly RingBand[] };
};

function labCamera(far: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(FOV_DEG, VIEW_WIDTH / VIEW_HEIGHT, NEAR, far);
  camera.position.copy(EYE);
  camera.lookAt(AHEAD);
  camera.updateMatrixWorld();
  return camera;
}

function sphere(color: number, radius: number, center: THREE.Vector3): THREE.Object3D {
  const surface = CelestialSurface.solid(color, 64, 48);
  surface.mesh.position.copy(center);
  surface.mesh.scale.setScalar(radius);
  return surface.mesh;
}

// 中心 center、半径 radius、平面 (u, v) の円を1本。分割はカメラで決まるので、カメラを作った
// あとに呼ぶ。revision は焼き直しの鍵で、ケースの間は変えない(毎フレーム変えると線がちらつく)。
function circle(
  center: THREE.Vector3, radius: number, u: THREE.Vector3, v: THREE.Vector3,
  style: LineStyle, camera: THREE.Camera,
): THREE.Object3D {
  const curve = new Curve({ style, maxVertices: 2048 });
  curve.setCurve((t, out) => {
    const theta = 2 * Math.PI * t;
    out.copy(center)
      .addScaledVector(u, radius * Math.cos(theta))
      .addScaledVector(v, radius * Math.sin(theta));
  }, { revision: 'lab', camera });
  return curve.object;
}

// 自機メッシュ。buildPlayerShip() は内部で markLitOpaque() を呼ぶので、フォワード経路へ
// 回す側はチャンネル 0 へ戻し直す必要がある。
function ship(z: number): THREE.Object3D {
  const group = buildPlayerShip();
  group.position.set(0, -1, z);
  return group;
}

// 地球低軌道: 艦・地球・自機の円軌道。線が艦と球に正しく隠れるかと、艦の陰影を見る。
function leo(): LabCase {
  const camera = labCamera(6e7);
  const orbitRadius = 6.791e6;
  // 地球は真下。視線は軌道の接線方向なので、地平線と、そこへ伸びていく自分の軌道が入る
  // (真下を向けると地球が全画面を覆い、線も地平線も見えない)。
  const center = new THREE.Vector3(0, -orbitRadius, 0);
  const u = new THREE.Vector3(0, 1, 0);
  const v = new THREE.Vector3(0, 0, -1);
  const style: LineStyle = { color: 0x6fd3ff, opacity: 0.9, renderOrder: LINE_RENDER_ORDER.shipOrbit };
  return {
    objects: [
      sphere(0x2b6cb0, 6.371e6, center),
      circle(center, orbitRadius, u, v, style, camera),
      ship(-10),
    ],
    camera,
  };
}

// 描画順: 同じ深度に置いた 5 本の円が LINE_RENDER_ORDER の順に重なるか。
// 交差点でどちらが上に出るかがそのまま答えになる。
const ORDER_COLORS = [0x5a6572, 0x4f8fd0, 0x59c3a5, 0xd8c24a, 0xff6a00] as const;

function order(): LabCase {
  const camera = labCamera(6e7);
  const depth = 1e4;
  const radius = 3e3;
  const u = new THREE.Vector3(1, 0, 0);
  const v = new THREE.Vector3(0, 1, 0);
  const objects: THREE.Object3D[] = [backdrop(5e4)];
  for (const [i, renderOrder] of Object.values(LINE_RENDER_ORDER).entries()) {
    const center = new THREE.Vector3((i - 2) * radius * 0.06, 0, -depth);
    const style: LineStyle = { color: ORDER_COLORS[i]!, opacity: 1, renderOrder };
    objects.push(circle(center, radius, u, v, style, camera));
  }
  return { objects, camera };
}

// 星殻の代わりの背景板。深度を書かず、どの不透明物より先に描かれる。
function backdrop(depth: number): THREE.Object3D {
  const halfHeight = Math.tan((FOV_DEG / 2) * Math.PI / 180) * depth;
  const geometry = new THREE.PlaneGeometry(halfHeight * 2 * (VIEW_WIDTH / VIEW_HEIGHT) * 1.2, halfHeight * 2 * 1.2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x0d1219, depthTest: false }));
  mesh.position.set(0, 0, -depth);
  mesh.renderOrder = -10;
  return mesh;
}

// 深度プローブ: 距離 z に半径 z/10 の球を2個、視線方向へ δ = z·ε だけずらして重ねる。
// 深度分解能が δ を下回る組だけが斑になる。見かけの大きさは z に依らない。
const PROBE_EPSILONS = [1e-3, 1e-4, 1e-5, 1e-6, 1e-7] as const;

function depthProbe(z: number, far: number): LabCase {
  const camera = labCamera(far);
  const objects: THREE.Object3D[] = [];
  for (const [i, epsilon] of PROBE_EPSILONS.entries()) {
    const x = (i - 2) * 0.3 * z;
    objects.push(sphere(0xff5544, z / 10, new THREE.Vector3(x, 0, -z)));
    objects.push(sphere(0x4488ff, z / 10, new THREE.Vector3(x, 0, -z * (1 + epsilon))));
  }
  return { objects, camera };
}

// 日食: 光を受ける球へ、太陽とほぼ同じ視半径の球と、その球を巡る環の帯が落とす影。
// 視半径がほぼ等しいので本影は点に近く、面の大半が半影の階調になる — 影の縁がぼけて
// 見えることが円盤の重なり面積を解いている証拠で、環の縞はそれとは別の経路の証拠になる。
function eclipse(): LabCase {
  const camera = labCamera(6e7);
  const center = new THREE.Vector3(0, 0, -1000);
  const receiver = new THREE.Mesh(
    new THREE.SphereGeometry(300, 64, 48),
    new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.9, metalness: 0 }),
  );
  receiver.position.copy(center);
  markLitOpaque(receiver);
  const occluderCenter = center.clone().addScaledVector(SUN_DIR, 1e4);
  return {
    objects: [receiver],
    camera,
    occluders: [{ center: occluderCenter, radius: 50 }],
    rings: {
      center: occluderCenter,
      axis: SUN_DIR.clone().add(new THREE.Vector3(0, 0.7, 0)).normalize(),
      bands: [
        { innerRadius: 110, outerRadius: 170, normalOpticalDepth: 0.4 },
        { innerRadius: 210, outerRadius: 320, normalOpticalDepth: 1.6 },
      ],
    },
  };
}

// 遠距離: 月と海王星の距離に球を置く。far=1e13 の外へ落ちないか、潰れたり消えたりしないか。
// 半径は深度プローブと同じ z/10 — 実半径だと海王星の距離では 1px を大きく下回り、
// 「出ているかどうか」自体が判定できない。
function far(): LabCase {
  const camera = labCamera(1e13);
  const moon = 3.8e8;
  const neptune = 4.5e12;
  return {
    objects: [
      sphere(0xbfb8ad, moon / 10, new THREE.Vector3(-0.4 * moon, 0, -moon)),
      sphere(0x4f7fd0, neptune / 10, new THREE.Vector3(0.4 * neptune, 0, -neptune)),
    ],
    camera,
  };
}

export const CASES = {
  'leo': leo,
  'order': order,
  'depth-1e4': () => depthProbe(1e4, 6e7),
  'depth-1e6': () => depthProbe(1e6, 6e7),
  'depth-1e8': () => depthProbe(1e8, 1e13),
  'depth-1e11': () => depthProbe(1e11, 1e13),
  'eclipse': eclipse,
  'far': far,
} as const satisfies Record<string, () => LabCase>;

export type CaseName = keyof typeof CASES;
export const CASE_NAMES = Object.keys(CASES) as readonly CaseName[];
