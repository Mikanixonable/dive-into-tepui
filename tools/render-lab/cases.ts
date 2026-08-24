// 描画テスト環境が描くケースの表。ゲーム本体と同じ球・艦・線を組んでカメラと一緒に返すだけで、
// シーンへ足すのもチャンネルを振るのも呼び出し側の仕事。ケースを増やすのはこの表への追記で済む。
import * as THREE from 'three/webgpu';
import { CelestialSurface } from '../../src/render/celestial-surface';
import { rec709Luminance, type Albedo } from '../../src/render/celestial-albedo';
import { createEarth } from '../../src/render/earth';
import { R_EARTH } from '../../src/physics/solar-system';
import { Curve } from '../../src/render/curve';
import { buildPlayerShip } from '../../src/render/ships';
import { markLitOpaque } from '../../src/render/pipeline/lit-layer';
import type { Occluder, RingBand } from '../../src/render/pipeline/occlusion';
import type { LineStyle } from '../../src/render/line-style';
import { RingView } from '../../src/game/celestial/ring-view';
import { sunIrradianceAtDistance } from '../../src/render/pipeline/sun-light';
import { AU } from '../../src/physics/planet-orbit';
import { bodyDef, SOLAR_SYSTEM } from '../../src/physics/solar-system';
import { textureOf } from '../../src/render/celestial-textures';
import { v3 } from '../../src/physics/vec3';
import { LINE_RENDER_ORDER } from '../../src/render/line-style';
import { PROTEIN_CASES } from './protein-cases';
import type { ProteinLabCaseMetadata } from './protein-cases';

// 描画は 960×540 固定(撮影した PNG の大きさを決め打ちにするため)。
export const VIEW_WIDTH = 960;
export const VIEW_HEIGHT = 540;
const FOV_DEG = 50;

// 土星ケースが使う実データの環。planet 以外は rings を持たないので、ここで判別を閉じる。
const SATURN_RINGS = (() => {
  const def = bodyDef(SOLAR_SYSTEM, 'saturn');
  if (def.kind !== 'planet' || def.rings === undefined) throw new Error('saturn has no rings');
  return def.rings;
})();

// 全ケース共通の恒星方向。球の陰影と、呼び出し側が置く光源が同じ向きを使う。
export const SUN_DIR = new THREE.Vector3(1, 0.35, 0.5).normalize();

// 色みはそのままに、Rec.709 輝度がボンドアルベドと一致するよう倍率を合わせる。
function scaleToBondAlbedo(hue: Albedo, bondAlbedo: number): Albedo {
  const k = bondAlbedo / rec709Luminance(hue);
  return [hue[0] * k, hue[1] * k, hue[2] * k];
}

// テスト用の球のアルベド。実在天体の値ではなく、線・深度・陰影を読むための識別色。
const BLUE_SPHERE_ALBEDO: Albedo = [0.0242, 0.15, 0.4342];
const GREY_SPHERE_ALBEDO: Albedo = [0.521, 0.4793, 0.4179];
// 土星本体。実写テクスチャの平均色の色みを、その天体のボンドアルベドの輝度へ合わせたもの。
const SATURN_ALBEDO: Albedo = scaleToBondAlbedo([1, 0.812, 0.530], textureOf('saturn')!.bondAlbedo);

// カメラは常に原点から -Z を見る。near はゲーム本体と同じ 2 m(深度分解能の導出がこの値に乗る)。
const EYE = new THREE.Vector3(0, 0, 0);
const AHEAD = new THREE.Vector3(0, 0, -1);
const NEAR = 2;

export type LabCase = {
  readonly objects: readonly THREE.Object3D[];
  readonly camera: THREE.PerspectiveCamera;
  // 大気パスへ渡す天体。中心は描画座標。
  readonly atmosphere?: { readonly center: THREE.Vector3; readonly surfaceRadius: number };
  // 遮蔽パスへ渡す球。フォワード経路は遮蔽を持たないので、影は 2 経路の差としても出る。
  readonly occluders?: readonly Occluder[];
  // 遮蔽パスへ渡す環。中心と法線軸は描画座標。
  readonly rings?: { readonly center: THREE.Vector3; readonly axis: THREE.Vector3; readonly bands: readonly RingBand[] };
  // Optional benchmark metadata. Rendering itself does not inspect it; the measurement harness
  // uses it to attach future protein-motion telemetry to a stable case identity.
  readonly proteinMotion?: ProteinLabCaseMetadata;
};

function labCamera(far: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(FOV_DEG, VIEW_WIDTH / VIEW_HEIGHT, NEAR, far);
  camera.position.copy(EYE);
  camera.lookAt(AHEAD);
  camera.updateMatrixWorld();
  return camera;
}

function sphere(albedo: Albedo, radius: number, center: THREE.Vector3): THREE.Object3D {
  const surface = CelestialSurface.solid(albedo, 64, 48);
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
      sphere(BLUE_SPHERE_ALBEDO, 6.371e6, center),
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
// 手前と奥をひと目で見分けるための赤・青。深度の判定だけが目的で、実在天体の値ではない。
const PROBE_NEAR_ALBEDO: Albedo = [1.0, 0.0908, 0.0578];
const PROBE_FAR_ALBEDO: Albedo = [0.0578, 0.2462, 1.0];

function depthProbe(z: number, far: number): LabCase {
  const camera = labCamera(far);
  const objects: THREE.Object3D[] = [];
  for (const [i, epsilon] of PROBE_EPSILONS.entries()) {
    const x = (i - 2) * 0.3 * z;
    objects.push(sphere(PROBE_NEAR_ALBEDO, z / 10, new THREE.Vector3(x, 0, -z)));
    objects.push(sphere(PROBE_FAR_ALBEDO, z / 10, new THREE.Vector3(x, 0, -z * (1 + epsilon))));
  }
  return { objects, camera };
}

// 地球: 高度 420km から地平線方向を見て、大気のリムと地表のもやを見る。
function earth(): LabCase {
  const camera = labCamera(6e7);
  // 地平線が画面中央へ来る向きへ地球を置く — 視線が地球へ接する角だけ、カメラから見た
  // 中心の向きを視線から傾ける。
  const dist = R_EARTH + 420e3;
  const tilt = Math.asin(R_EARTH / dist);
  const center = new THREE.Vector3(0, -Math.sin(tilt), -Math.cos(tilt)).multiplyScalar(dist);
  const built = createEarth();
  built.group.position.copy(center);
  built.setAuroraVisible(false);
  built.syncSurfaceLod(6e4);
  built.tick(0);
  return { objects: [built.group], camera, atmosphere: { center, surfaceRadius: R_EARTH } };
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

// 較正: アルベド 1 の完全拡散面を 1 天文単位に置く。**放射照度の単位が「1 AU で π」に取れて
// いれば、太陽へ正対した面のトーンマッピング前の線形値は 1.0 になる** — ランバート BRDF の
// 1/π が単位を打ち消すため。ここが動いたら光の単位か BRDF のどちらかが崩れている。
//
// 画面へ出るのはそこから 2 段ぶん先で、**最も明るい画素は sRGB (241, 231, 215)** になる:
// 恒星光の色 (1, 0.905, 0.761) x π に環境光 (0.246, 0.283, 0.479) x 0.292 を足し、1/π を掛けて
// (1.023, 0.931, 0.805) — R が 1 をわずかに超えるのは環境光ぶん — これを PBR Neutral へ通すと
// (0.876, 0.795, 0.685) になり、sRGB 符号化で上の値へ落ちる。
function albedo(): LabCase {
  const camera = labCamera(6e7);
  const surface = new THREE.Mesh(
    new THREE.SphereGeometry(300, 96, 64),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 }),
  );
  surface.position.set(0, 0, -1000);
  markLitOpaque(surface);
  return { objects: [surface], camera };
}

// 土星: 本体の球と実データの環を並べ、**環だけが本体より桁で明るくないか**を見る。恒星の
// 放射照度は本体(ライティングパスが画素ごとに逆二乗を掛ける)にも環(sync が受け取る)にも
// 同じだけ掛かる。**恒星は他のケースと同じ 1 天文単位に置く** — 本体だけが位置によらない
// 環境光を受け取るので、太陽から遠ざけると比がそのぶん動いてしまう。
function saturn(): LabCase {
  const camera = labCamera(1e13);
  const radius = 6.0268e7;
  const distance = 1.2e9;
  const center = new THREE.Vector3(0, -0.15 * distance, -distance);
  const axis = v3(0.3, 0.9, 0.32);
  const view = new RingView(SATURN_RINGS, radius, 1);
  const sunPosition = SUN_DIR.clone().multiplyScalar(AU);
  const sunDistance = center.distanceTo(sunPosition);
  view.sync(
    center,
    axis,
    v3(center.x, center.y, center.z),
    () => distance / VIEW_HEIGHT,
    v3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z),
    sunIrradianceAtDistance(sunDistance),
  );
  return { objects: [sphere(SATURN_ALBEDO, radius, center), view.group], camera };
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
      sphere(GREY_SPHERE_ALBEDO, moon / 10, new THREE.Vector3(-0.4 * moon, 0, -moon)),
      sphere(BLUE_SPHERE_ALBEDO, neptune / 10, new THREE.Vector3(0.4 * neptune, 0, -neptune)),
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
  'earth': earth,
  'far': far,
  'saturn': saturn,
  'albedo': albedo,
  ...PROTEIN_CASES,
} as const satisfies Record<string, () => LabCase>;

export type CaseName = keyof typeof CASES;
export const CASE_NAMES = Object.keys(CASES) as readonly CaseName[];
