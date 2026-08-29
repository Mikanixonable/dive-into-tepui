// 描画テスト環境が描くケースの表。ゲーム本体と同じ球・艦・線を組んでカメラと一緒に返すだけで、
// シーンへ足すのもチャンネルを振るのも呼び出し側の仕事。ケースを増やすのはこの表への追記で済む。
// 表示スタイルで組み方が変わるケース(環・地球)は、受け取った style をゲーム本体と同じ
// sync / setVisible へそのまま流す — スタイルの切り替えは呼び出し側がケースを組み直して行う。
import * as THREE from 'three/webgpu';
import { Fn, exp, float, max, select, uv, vec3 } from 'three/tsl';
import { CelestialSurface } from '../../src/render/celestial-surface';
import { scaledToBondAlbedo, type Albedo } from '../../src/render/celestial-albedo';
import cloudsTextureUrl from '../../src/assets/8k_clouds.jpg';
import { R_EARTH, R_EARTH_EQ, R_SUN } from '../../src/physics/solar-system/constants';
import { EARTH } from '../../src/physics/solar-system/earth-system';
import { shapeAxes, type RingBandDef } from '../../src/physics/celestial-body-def';
import { BodyGraticule } from '../../src/render/body-graticule';
import { EarthCoastline } from '../../src/render/earth-coastline';
import { Curve } from '../../src/render/curve';
import { createAnnulusRing } from '../../src/render/ring';
import { buildBarrelMesh, buildPlayerShip } from '../../src/render/ships';
import { createStarSphere, type StarSphere } from '../../src/render/star-sphere';
import { REFERENCE_STAR_RADIANT_INTENSITY } from '../../src/render/pipeline/sun-light';
import { SUN_SURFACE_COLOR } from '../../src/game/celestial/solar-system/sun';
import { InstancedPool } from '../../src/render/instanced-pool';
import { markLitOpaque } from '../../src/render/pipeline/lit-layer';
import {
  attachThermalEmissive, syncThermalState, THERMAL_SHAPE_ATTRIBUTE, type ThermalSource,
} from '../../src/render/thermal-emissive';
import { HULL_EMISS } from '../../src/game/const';
import type { Occluder, RingBand, SunOcclusion } from '../../src/render/pipeline/sun-occlusion';
import { rayMarch, type MediumSample } from '../../src/render/ray-march';
import type { FloatNode } from '../../src/render/tsl-types';
import { type AtmosphereBody } from '../../src/render/atmosphere';
import { EARTH_ATMOSPHERE_OPTICS, EARTH_TEXTURE } from '../../src/game/celestial/solar-system/earth-system';
import type { LineStyle } from '../../src/render/line-style';
import { RingView } from '../../src/game/celestial/ring-view';
import type { RenderStyle } from '../../src/render/render-style';
import type { SunLight } from '../../src/render/pipeline/sun-light';
import { AU } from '../../src/physics/planet-orbit';
import { MARS } from '../../src/physics/solar-system/mars-system';
import { SATURN } from '../../src/physics/solar-system/saturn-system';
import { type CelestialTexture } from '../../src/render/celestial-textures';
import { MARS_ATMOSPHERE_OPTICS, MARS_TEXTURE } from '../../src/game/celestial/solar-system/mars-system';
import { SATURN_TEXTURE } from '../../src/game/celestial/solar-system/saturn-system';
import { apparentSizePx, metersPerPixelAtDepth } from '../../src/math/projection';
import { v3 } from '../../src/math/vec3';
import { LINE_RENDER_ORDER } from '../../src/render/line-style';
import { PROTEIN_CASES } from './protein-cases';
import type { ProteinLabCaseMetadata } from './protein-cases';
import type { ProteinMotionFrameSample } from '../../src/protein-motion-metrics';

// 描画は 960×540 固定(撮影した PNG の大きさを決め打ちにするため)。
export const VIEW_WIDTH = 960;
export const VIEW_HEIGHT = 540;
const FOV_DEG = 50;

// カメラの距離を、ケース既定の距離の何桁ぶんまで伸縮できるか(倍率の常用対数の絶対値の上限)。
// **寄り切った先へ物体を置くケースは、この値から距離を逆算する。**
export const MAX_CAMERA_DISTANCE_LOG = 2;

// 土星ケースが使う実データの環。
const SATURN_RINGS = (() => {
  if (SATURN.rings === undefined) throw new Error('saturn has no rings');
  return SATURN.rings;
})();

// 環の帯を遮蔽パスへ渡す形へ直す。半径は描画座標と同じメートルのまま。
function occlusionBands(bands: readonly RingBandDef[]): readonly RingBand[] {
  return bands.map((band) => ({
    innerRadius: band.innerRadius,
    outerRadius: band.outerRadius,
    normalOpticalDepth: band.optics.normalOpticalDepth,
  }));
}

// 太陽面の輝度。放射強度を、面が張る立体角(π R²)で割ったもの。
const SUN_SURFACE_RADIANCE = REFERENCE_STAR_RADIANT_INTENSITY / (Math.PI * R_SUN * R_SUN);

// 全ケース共通の恒星方向。球の陰影と、呼び出し側が置く光源が同じ向きを使う。
export const SUN_DIR = new THREE.Vector3(1, 0.35, 0.5).normalize();

// テスト用の球のアルベド。実在天体の値ではなく、線・深度・陰影を読むための識別色。
const BLUE_SPHERE_ALBEDO: Albedo = [0.0242, 0.15, 0.4342];
const GREY_SPHERE_ALBEDO: Albedo = [0.521, 0.4793, 0.4179];
// 土星本体。実写テクスチャの平均色の色みを、その天体のボンドアルベドの輝度へ合わせたもの。
const SATURN_ALBEDO: Albedo = scaledToBondAlbedo([1, 0.812, 0.530], SATURN_TEXTURE.bondAlbedo);

// 地球を光源として扱うときの色つきアルベド(ゲーム本体の Earth と同じ測光)。
const EARTH_LIGHT_ALBEDO: Albedo = scaledToBondAlbedo(EARTH_TEXTURE.averageHue, EARTH_TEXTURE.bondAlbedo);

// カメラは常に原点から -Z を見る。near はゲーム本体と同じ 2 m(深度分解能の導出がこの値に乗る)。
const EYE = new THREE.Vector3(0, 0, 0);
const AHEAD = new THREE.Vector3(0, 0, -1);
const NEAR = 2;

export type LabCase = {
  readonly objects: readonly THREE.Object3D[];
  readonly camera: THREE.PerspectiveCamera;
  // 恒星の向き(原点から見た単位ベクトル)。省略すると SUN_DIR。
  readonly sunDirection?: THREE.Vector3;
  // 恒星を置く距離 [m]。省略すると 1 天文単位。つまみで上書きできるので、ここに書くのは既定値。
  readonly sunDistance?: number;
  // 恒星の見た目。持たせると、恒星の向きと距離のつまみに合わせて毎フレーム同期される
  // (持たないケースでは、つまみは光源と露出だけを動かす)。
  readonly star?: StarSphere;
  // 天体照の光源として置く天体。中心は描画座標、albedo は輝度がボンドアルベドに一致する
  // 線形 RGB。省略すると天体照は無い。
  readonly planetLights?: readonly {
    readonly center: THREE.Vector3; readonly radius: number; readonly albedo: Albedo;
  }[];
  // カメラを周回させるときに中心へ据える点(描画座標)。省略するとケースの物体を包む箱の中心。
  readonly viewTarget?: THREE.Vector3;
  // 大気パスへ渡す天体。中心は描画座標。並べ替えと濃い表現の重みは、カメラの位置から
  // 引き直される。
  readonly atmospheres?: readonly AtmosphereBody[];
  // 遮蔽パスへ渡す球。中心は描画座標。
  readonly occluders?: readonly Occluder[];
  // 遮蔽パスへ渡す環。中心と法線軸は描画座標。
  readonly rings?: { readonly center: THREE.Vector3; readonly axis: THREE.Vector3; readonly bands: readonly RingBand[] };
  // Optional benchmark metadata. Rendering itself does not inspect it; the measurement harness
  // uses it to attach future protein-motion telemetry to a stable case identity.
  readonly proteinMotion?: ProteinLabCaseMetadata;
  readonly updateProteinMotion?: (displayTime: number) => ProteinMotionFrameSample;
  readonly disposeProteinMotion?: () => void;
};

function labCamera(far: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(FOV_DEG, VIEW_WIDTH / VIEW_HEIGHT, NEAR, far);
  camera.position.copy(EYE);
  camera.lookAt(AHEAD);
  camera.updateMatrixWorld();
  return camera;
}

function sphere(albedo: Albedo, radius: number, center: THREE.Vector3): THREE.Object3D {
  const group = new THREE.Group();
  group.position.copy(center);
  group.scale.setScalar(radius);
  const surface = CelestialSurface.solid(albedo);
  surface.addTo(group);
  // 見かけ直径は画面の高さぶんとみなす。
  surface.syncLod(VIEW_HEIGHT);
  return group;
}

// 寄り切ったときの見かけ直径 [px] として天体へ渡す値。分割段ラダーの最上段が選ばれる。
const CLOSE_UP_DIAMETER_PX = 6e4;

// 実写テクスチャを貼った天体の球。apparentDiameterPx は分割段を選ぶ見かけ直径で、寄れる
// ケースでは寄り切った大きさを渡す。
function texturedSphere(
  texture: CelestialTexture, radius: number, center: THREE.Vector3, apparentDiameterPx: number,
): THREE.Object3D {
  const group = new THREE.Group();
  group.position.copy(center);
  group.scale.setScalar(radius);
  const surface = CelestialSurface.textured(texture);
  surface.addTo(group);
  surface.syncLod(apparentDiameterPx);
  return group;
}

// 中心 center、半径 radius、平面 (u, v) の円を1本。分割はカメラで決まるので、カメラを作った
// あとに呼ぶ。
function circle(
  center: THREE.Vector3, radius: number, u: THREE.Vector3, v: THREE.Vector3,
  style: LineStyle, camera: THREE.Camera,
): THREE.Object3D {
  const curve = new Curve(style);
  curve.setAnalyticCurve((t, out) => {
    const theta = 2 * Math.PI * t;
    out.copy(center)
      .addScaledVector(u, radius * Math.cos(theta))
      .addScaledVector(v, radius * Math.sin(theta));
  }, camera);
  return curve.object;
}

// 自機メッシュ 1 隻を、描画座標の position へ置く。rotation を渡すと機体の姿勢を回す。
function shipAt(position: THREE.Vector3, rotation?: THREE.Euler): THREE.Object3D {
  const group = buildPlayerShip();
  group.position.copy(position);
  if (rotation !== undefined) group.rotation.copy(rotation);
  return group;
}

// 環の面のローカル法線。帯のメッシュはこの向きが環軸へ重なる姿勢で組まれる。
const RING_LOCAL_AXIS = new THREE.Vector3(0, 1, 0);
// 環の帯を本体より後に描くための描画順。
const RING_RENDER_ORDER = 1;

// 環の帯を面として組み、中心 center・軸 axis(どちらも描画座標)の姿勢へ置く。帯の半径は
// 天体の中心から測ったメートルで受ける。
function ringDisc(
  bands: readonly RingBandDef[], bodyRadius: number, center: THREE.Vector3, axis: THREE.Vector3,
  sunOcclusion: SunOcclusion, sunLight: SunLight,
): THREE.Object3D {
  const group = new THREE.Group();
  group.position.copy(center);
  group.scale.setScalar(bodyRadius);
  group.quaternion.setFromUnitVectors(RING_LOCAL_AXIS, axis);
  for (const band of bands) {
    // 半径は「本体半径 = 1」の単位へ直して渡す。被覆率 1 は、帯が画面上 1px より広く写ること。
    const visual = createAnnulusRing(
      band.optics, band.innerRadius / bodyRadius, band.outerRadius / bodyRadius, sunOcclusion, sunLight,
    );
    visual.sync({ ringAxis: axis, coverage: 1 });
    visual.object.traverse((object) => {
      object.renderOrder = RING_RENDER_ORDER;
      object.userData.ownsGeometry = true;
      object.userData.ownsMaterial = true;
    });
    group.add(visual.object);
  }
  return group;
}

// 斜光のケースで使う恒星の向き。カメラは −Z を見るので、左上手前から差す。
const OBLIQUE_SUN_DIR = new THREE.Vector3(-0.70, 0.20, 0.68).normalize();
// 逆光のケースで使う恒星の向き。カメラは −Z を見るので、被写体の向こう側から差す。
const BACKLIT_SUN_DIR = new THREE.Vector3(0, 0.09, -1).normalize();
// 上面と左舷の両方が見える機体の姿勢。突起の影が見えている面を横切る。
const SHIP_ROTATION_PORT = new THREE.Euler(-0.5, 0.6, 0.12);
// 上面と右舷の両方が見える機体の姿勢。右手から差す恒星のもとで、突起の影が見えている面を横切る。
const SHIP_ROTATION_STARBOARD = new THREE.Euler(-0.5, -0.6, -0.12);

// 小片 1 個の一辺 [m] と、散らばる範囲の半幅 [m]。
const DEBRIS_SIZE = 0.12;
const DEBRIS_SPREAD = 100;

// 決定的な擬似乱数(同じ絵を毎回撮るため)。
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

// 薬莢や破片と同じ形の枝(1 本の InstancedMesh に個体を詰めたプール)を、center のまわりへ
// 散らして返す。ゲーム本体と同じ InstancedPool を通すので、影パスから見た姿も同じになる。
function debrisPool(center: THREE.Vector3, count: number): THREE.Object3D {
  const host = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(DEBRIS_SIZE, DEBRIS_SIZE, DEBRIS_SIZE);
  const material = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.8, metalness: 0 });
  const pool = new InstancedPool(host, geometry, material, count);
  const random = lcg(20260825);
  const piece = new THREE.Object3D();
  pool.beginFrame();
  for (let i = 0; i < count; i++) {
    piece.position.set(
      center.x + (random() * 2 - 1) * DEBRIS_SPREAD,
      center.y + (random() * 2 - 1) * DEBRIS_SPREAD,
      center.z + (random() * 2 - 1) * DEBRIS_SPREAD,
    );
    piece.rotation.set(random() * Math.PI, random() * Math.PI, random() * Math.PI);
    pool.push(piece);
  }
  pool.endFrame();
  const mesh = host.children[0]!;
  host.remove(mesh);
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  return mesh;
}

// 自己影: 艦 1 隻を斜光で照らし、突起(アンテナ・放熱板)の影が船体へ落ちるのを見る。
function shipSelfShadow(): LabCase {
  const shipPosition = new THREE.Vector3(0, -1, -10);
  return {
    objects: [shipAt(shipPosition, SHIP_ROTATION_PORT)],
    camera: labCamera(6e7),
    sunDirection: OBLIQUE_SUN_DIR,
    viewTarget: shipPosition,
  };
}

// 逆光: 艦 1 隻を向こう側から照らし、暗い船体の縁が背景の虚空と接する 1 画素を見る。**照度は
// 画素の中心でしか求まらない**ので、縁を跨ぐ画素の材質と照度が食い違うと、ここに輪郭が浮く。
function shipBacklit(): LabCase {
  const shipPosition = new THREE.Vector3(0, -1, -10);
  return {
    objects: [shipAt(shipPosition, SHIP_ROTATION_PORT)],
    camera: labCamera(6e7),
    sunDirection: BACKLIT_SUN_DIR,
    viewTarget: shipPosition,
  };
}

// 複数塊: 互いに離した艦を並べ、スロットが 2 枚以上へ分かれるのを見る。
function shipCluster(): LabCase {
  const positions = [
    new THREE.Vector3(0, -1, -10),
    new THREE.Vector3(9, 3, -18),
    new THREE.Vector3(-8, 2, -16),
    new THREE.Vector3(3, -7, -24),
  ];
  return {
    objects: positions.map((position) => shipAt(position, SHIP_ROTATION_PORT)),
    camera: labCamera(6e7),
    sunDirection: OBLIQUE_SUN_DIR,
    viewTarget: positions[0]!,
  };
}

// スロットより遮蔽器が多い群: 艦をスロット数より多く並べ、カメラの背後にも置く。**枠が尽きた
// ときに何が捨てられるか**を見るためのケースなので、艦の数はスロット数を上回っていなければ
// 意味がない。
function shipCrowd(): LabCase {
  const positions = [
    new THREE.Vector3(0, -1, -10),
    new THREE.Vector3(9, 3, -18),
    new THREE.Vector3(-8, 2, -16),
    new THREE.Vector3(3, -7, -24),
    new THREE.Vector3(-11, -5, -30),
    new THREE.Vector3(14, 6, -34),
    new THREE.Vector3(-2, 9, -42),
  ];
  return {
    objects: positions.map((position) => shipAt(position, SHIP_ROTATION_PORT)),
    camera: labCamera(6e7),
    sunDirection: OBLIQUE_SUN_DIR,
    viewTarget: positions[0]!,
  };
}

// 遠くから伸びてくる影: 恒星方向へ 3 km 離した艦が、手前の艦へ影を落とす。**本影は艦の
// 差し渡しの 107.5 倍(約 915 m)で消える**ので、3 km 先では遮蔽率が (915/3000)² まで落ちて
// いなければならない。遠方の半影の減衰を見るためのケース。
function shipFarShadow(): LabCase {
  const receiver = new THREE.Vector3(0, 0, -10);
  return {
    objects: [
      shipAt(receiver, SHIP_ROTATION_PORT),
      shipAt(new THREE.Vector3(3000, 0, -10), SHIP_ROTATION_PORT),
    ],
    camera: labCamera(6e7),
    sunDirection: new THREE.Vector3(1, 0, 0),
    viewTarget: receiver,
  };
}

// 小片群のなかの自己影: 自己影のケースへ、広く散らばった小片群を 1 本の枝として足す。
function shipInDebris(): LabCase {
  const shipPosition = new THREE.Vector3(0, -1, -10);
  return {
    objects: [shipAt(shipPosition, SHIP_ROTATION_PORT), debrisPool(shipPosition, 512)],
    camera: labCamera(6e7),
    sunDirection: OBLIQUE_SUN_DIR,
    viewTarget: shipPosition,
  };
}

// 小天体のケースの寸法 [m]。艦(差し渡し 8.5 m)と天体が同じ画面へ収まる大きさに取る。
const SMALL_BODY_RADIUS = 30;
const SMALL_BODY_DISTANCE = 130;

// 小天体の環の帯。半径は天体の中心から [m]。**帯の影は環軸と恒星のなす角の余弦(0.55)ぶんへ
// 縮む**ので、内縁 40 m の帯の影は中心から 22 m — 天体の半径 30 m の内側 — へ落ちる。
const SMALL_BODY_RING_BANDS: readonly RingBandDef[] = [
  {
    innerRadius: 40, outerRadius: 48, thickness: 0,
    optics: { normalOpticalDepth: 0.8, singleScatteringAlbedo: 0.6, phaseG: 0.3 },
  },
  {
    innerRadius: 52, outerRadius: 58, thickness: 0,
    optics: { normalOpticalDepth: 1.6, singleScatteringAlbedo: 0.6, phaseG: 0.3 },
  },
];

// 小天体のケースの恒星の向き。カメラ側の成分を 0.55 に取ると、昼面が画面へ大きく入りつつ
// 昼夜境界も残る。
const SMALL_BODY_SUN_DIR = new THREE.Vector3(0.479, 0.684, 0.550).normalize();

// 環の軸を恒星から傾ける角 [rad]。**倒す向きをカメラ側へ取ると環面が「視線と恒星の両方に
// 直交する向き」を含む**ので、その向きへ寄せた艦は環の帯の影から外れ、天体の球の影だけを受ける。
const SMALL_BODY_RING_TILT = 0.9885;

// 影を落とす艦を浮かべる高さ [m] と、その直下点の太陽天頂角・方位 [rad](方位 0 がカメラ側)。
// 天頂角 0 の直下点はカメラから見て縁へ寄るので倒し、方位は帯の影を避ける側へ振る。
const SMALL_BODY_SHIP_ALTITUDE = 20;
const SMALL_BODY_SHIP_ZENITH = 0.7;
const SMALL_BODY_SHIP_AZIMUTH = 0.68;

// 影を受ける艦を天体の後方へ置く距離 [m]。
const SMALL_BODY_SHADOW_DISTANCE = 100;

// 小天体と艦: 環を持つ半径 30 m の天体のまわりへ艦を 2 隻置き、**影の 2 つの経路を同じ絵で
// 読む**。昼面へ浮かべた艦は影の深度マップを通って天体の表面へ影を落とし、後方へ置いた艦は
// 天体の球が解析式で解く影の柱の縁をまたぐ。環の帯の影は昼面を横切る縞として出る。
function shipBodyShadow(_style: RenderStyle, sunOcclusion: SunOcclusion, sunLight: SunLight): LabCase {
  const camera = labCamera(6e7);
  const center = new THREE.Vector3(0, 0, -SMALL_BODY_DISTANCE);
  const sun = SMALL_BODY_SUN_DIR;
  // 恒星に直交する 2 つの向き。lateral はカメラ側を向き、edge は視線にも直交するので画面内で真横。
  const toCamera = new THREE.Vector3().subVectors(camera.position, center).normalize();
  const lateral = toCamera.clone().addScaledVector(sun, -toCamera.dot(sun)).normalize();
  const edge = new THREE.Vector3().crossVectors(toCamera, sun).normalize();
  const axis = sun.clone().multiplyScalar(Math.cos(SMALL_BODY_RING_TILT))
    .addScaledVector(lateral, -Math.sin(SMALL_BODY_RING_TILT));
  // 影を落とす艦は、直下点を天頂角・方位で決めてから恒星方向へ浮かせる。
  const subShip = sun.clone().multiplyScalar(Math.cos(SMALL_BODY_SHIP_ZENITH))
    .addScaledVector(lateral, Math.sin(SMALL_BODY_SHIP_ZENITH) * Math.cos(SMALL_BODY_SHIP_AZIMUTH))
    .addScaledVector(edge, Math.sin(SMALL_BODY_SHIP_ZENITH) * Math.sin(SMALL_BODY_SHIP_AZIMUTH));
  const caster = center.clone()
    .addScaledVector(subShip, SMALL_BODY_RADIUS)
    .addScaledVector(sun, SMALL_BODY_SHIP_ALTITUDE);
  // 影を受ける艦は、影の柱の縁(軸から天体の半径ぶん)へ重ねる。
  const receiver = center.clone()
    .addScaledVector(sun, -SMALL_BODY_SHADOW_DISTANCE)
    .addScaledVector(edge, SMALL_BODY_RADIUS);
  return {
    objects: [
      sphere(GREY_SPHERE_ALBEDO, SMALL_BODY_RADIUS, center),
      ringDisc(SMALL_BODY_RING_BANDS, SMALL_BODY_RADIUS, center, axis, sunOcclusion, sunLight),
      shipAt(caster, SHIP_ROTATION_STARBOARD),
      shipAt(receiver, SHIP_ROTATION_STARBOARD),
    ],
    camera,
    sunDirection: sun,
    viewTarget: center,
    occluders: [{ center, radius: SMALL_BODY_RADIUS }],
    rings: { center, axis, bands: occlusionBands(SMALL_BODY_RING_BANDS) },
  };
}

// 地球低軌道: 艦・地球・自機の円軌道。線が艦と球に正しく隠れるかと、艦の陰影を見る。
// 球は識別色だが、天体照の光源としては実在の地球の値(半径・色つきアルベド)で置く。
function leo(): LabCase {
  const camera = labCamera(6e7);
  const orbitRadius = 6.791e6;
  // 地球は真下。視線は軌道の接線方向なので、地平線と、そこへ伸びていく自分の軌道が入る
  // (真下を向けると地球が全画面を覆い、線も地平線も見えない)。
  const center = new THREE.Vector3(0, -orbitRadius, 0);
  const u = new THREE.Vector3(0, 1, 0);
  const v = new THREE.Vector3(0, 0, -1);
  const style: LineStyle = { color: 0x6fd3ff, opacity: 0.9, renderOrder: LINE_RENDER_ORDER.shipOrbit };
  const shipPosition = new THREE.Vector3(0, -1, -10);
  return {
    objects: [
      sphere(BLUE_SPHERE_ALBEDO, 6.371e6, center),
      circle(center, orbitRadius, u, v, style, camera),
      shipAt(shipPosition),
    ],
    camera,
    viewTarget: shipPosition,
    planetLights: [{ center, radius: R_EARTH, albedo: EARTH_LIGHT_ALBEDO }],
  };
}

// 地球照: 低軌道の艦を、満相の地球が下から照らす。恒星は真上から差すので、艦の上面だけが
// 直射を受け、下面は地球照だけで照らされる。横を向いた面はどちらの光も受けず桁で暗い。
function earthshine(): LabCase {
  const camera = labCamera(6e7);
  const center = new THREE.Vector3(0, -6.791e6, 0);
  const shipPosition = new THREE.Vector3(0, -1, -10);
  return {
    objects: [sphere(BLUE_SPHERE_ALBEDO, R_EARTH, center), shipAt(shipPosition, SHIP_ROTATION_PORT)],
    camera,
    sunDirection: new THREE.Vector3(0, 1, 0),
    viewTarget: shipPosition,
    planetLights: [{ center, radius: R_EARTH, albedo: EARTH_LIGHT_ALBEDO }],
  };
}

// 三日月: earthshine と同じ低軌道で、恒星を横へ倒して位相角 120°(地球が三日月形に見える
// 位置)にする。天体照は満相の Φ(0)=1 から Φ(120°)≈0.11 まで弱まる。
function crescent(): LabCase {
  const base = earthshine();
  return {
    ...base,
    sunDirection: new THREE.Vector3(Math.sin((Math.PI * 2) / 3), Math.cos((Math.PI * 2) / 3), 0),
  };
}

// 典型的な天体表面・艦の外殻の反射率。
const OUTER_ALBEDO: Albedo = [0.3, 0.3, 0.3];
// 灰色球の半径 [m]。
const OUTER_BODY_RADIUS = 6.371e6;

// 外惑星圏: 恒星を sunDistance [m] まで遠ざけ、灰色球と艦を1隻置いて、**太陽に正対した面が
// 黒へ潰れていないか**を読む。球の最も明るい画素が太陽に正対した面にあたるので、距離ごとの
// 表示値はそこで測る。灰色球はそのまま天体照の光源にもなる(艦の夜側を照らす)。
function outer(sunDistance: number): LabCase {
  const camera = labCamera(6e7);
  const center = new THREE.Vector3(0, -0.5 * OUTER_BODY_RADIUS, -3 * OUTER_BODY_RADIUS);
  // 艦は太陽に正対する面(球の右上)へ重ならない位置へ置く — 重なるとそこの画素が艦の
  // 鏡面反射に置き換わって読めない。
  const shipPosition = new THREE.Vector3(-30, -12, -100);
  return {
    objects: [sphere(OUTER_ALBEDO, OUTER_BODY_RADIUS, center), shipAt(shipPosition)],
    camera,
    viewTarget: shipPosition,
    sunDistance,
    planetLights: [{ center, radius: OUTER_BODY_RADIUS, albedo: OUTER_ALBEDO }],
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

// 日食ケースの遮蔽器: 地表のどこへ影を落とすか(直下からの中心角 [rad])と、その球の半径・
// 距離。距離に対する半径の比を太陽の視半径(4.65e-3)よりわずかに大きく取ると、本影を半影が
// 縁取る金環直前の配置になる。
const ECLIPSE_GROUND_ANGLE = 0.25;
const ECLIPSE_OCCLUDER_RADIUS = 2e5;
const ECLIPSE_OCCLUDER_DISTANCE = 3e7;

// 大気の外に置く試験球の位置と半径。カメラと同じ高度帯(403km)に居るので、**カメラとの間に
// 大気が無く、地表と違って霞んではならない。** 地平線を背にした輪郭で読む。
const ABOVE_ATMOSPHERE_CENTER = new THREE.Vector3(0, 0, -5e4);
const ABOVE_ATMOSPHERE_RADIUS = 1e3;

// 検証用の板の置き方。画角(50°)いっぱいに広がる大きさを距離から出す。
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
// 上から順に 解析解 / 等間隔の刻み / 前へ寄せた刻み / 解析解との差 ×100 の4帯。
// **上3帯が同じ濃さで、最下段が黒なら、刻みが不均等でも同じ答えが出ている。**
// 光学的厚みは画面の左から右へ 0.2 から 1.8 まで変える。
function marchSlab(): LabCase {
  const camera = labCamera(1e3);
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

// 地球の球を、中心 center(描画座標)へ寄り切った分割段で組む。雲を合成した地表と、模式図で
// だけ出る経緯度グリッド・海岸線を、ゲーム本体と同じ部品から組む。
function earthAt(center: THREE.Vector3, style: RenderStyle): THREE.Object3D {
  const group = new THREE.Group();
  group.position.copy(center);
  const axes = shapeAxes(R_EARTH_EQ, EARTH.shape);
  group.scale.set(axes.x, axes.y, axes.z);
  const surface = CelestialSurface.clouded(EARTH_TEXTURE, cloudsTextureUrl);
  surface.addTo(group);
  surface.syncLod(CLOSE_UP_DIAMETER_PX);
  surface.setCloudAmount(1);
  const graticule = new BodyGraticule();
  graticule.addTo(group);
  graticule.setVisible(style === 'schematic');
  const coastline = new EarthCoastline();
  coastline.addTo(group);
  coastline.setVisible(style === 'schematic');
  return group;
}

// カメラ(原点)から見て、地球の地平線が視線から margin [rad] だけ下へ来る向きの地球中心。
// 高度 altitude [m] のカメラから地球へ接する視線の角が、そのまま中心の向きの傾きになる。
function earthCenterBelowHorizon(altitude: number, margin: number): THREE.Vector3 {
  const dist = R_EARTH + altitude;
  const tilt = Math.asin(R_EARTH / dist) + margin;
  return new THREE.Vector3(0, -Math.sin(tilt), -Math.cos(tilt)).multiplyScalar(dist);
}

// 地球: 高度 420km から地平線方向を見て、大気のリムと地表のもや、大気の外に居る物体を見る。
function earth(style: RenderStyle): LabCase {
  const camera = labCamera(6e7);
  const center = earthCenterBelowHorizon(420e3, 0);
  return {
    objects: [
      earthAt(center, style),
      sphere(GREY_SPHERE_ALBEDO, ABOVE_ATMOSPHERE_RADIUS, ABOVE_ATMOSPHERE_CENTER),
    ],
    camera,
    atmospheres: [{ center, surfaceRadius: R_EARTH, optics: EARTH_ATMOSPHERE_OPTICS }],
    planetLights: [{ center, radius: R_EARTH, albedo: EARTH_LIGHT_ALBEDO }],
  };
}

// 昼夜境界の地球: earth と同じ構図で、恒星を視線の先の地平線上へ置く。**太陽光が最も長く
// 大気を通って届く向き**なので、波長ごとの減衰だけで縁と霞が橙へ寄っていなければならない。
// 前方散乱が効く向きでもあるので、太陽のまわりのグローもここで読む。
function earthTerminator(style: RenderStyle): LabCase {
  const base = earth(style);
  const up = base.atmospheres![0]!.center.clone().negate().normalize();
  const ahead = AHEAD.clone().projectOnPlane(up).normalize();
  return { ...base, sunDirection: ahead };
}

// 日食下の地球: earth と同じ構図へ、地球自身と食を起こす球を遮蔽器として足す。**大気の明暗は
// 入射角だけでなく遮蔽度にも比例する**ので、リムともやの両方へ影の落ちた斑が出る。遮蔽器の
// 視半径は太陽よりわずかに大きく取ってあり、本影(半径 60km)を半影(340km)が縁取る。
function earthEclipse(style: RenderStyle): LabCase {
  const base = earth(style);
  const center = base.atmospheres![0]!.center;
  // 影を落とす地表点。カメラ直下と地平線(地表距離 2,255km)の中間へ来るよう、直下の向きを
  // 視線側へ回す。
  const groundDir = center.clone().negate().normalize()
    .applyAxisAngle(new THREE.Vector3(1, 0, 0), -ECLIPSE_GROUND_ANGLE);
  const ground = center.clone().addScaledVector(groundDir, R_EARTH);
  return {
    ...base,
    occluders: [
      { center: ground.clone().addScaledVector(SUN_DIR, ECLIPSE_OCCLUDER_DISTANCE), radius: ECLIPSE_OCCLUDER_RADIUS },
      { center, radius: R_EARTH },
    ],
  };
}

// 地球と火星のケースの寸法 [m]。**距離のつまみを縮め切った位置が火星の大気の中**へ来るよう、
// 火星までの距離を到達高度から逆算する。カメラの高度は地球の大気の裾(高度 116km)の内側。
const MARS_RADIUS = MARS.radius;
const MARS_ARRIVAL_ALTITUDE = 4e4;
const EARTH_MARS_DISTANCE = (MARS_RADIUS + MARS_ARRIVAL_ALTITUDE) * 10 ** MAX_CAMERA_DISTANCE_LOG;
const EARTH_MARS_CAMERA_ALTITUDE = 1e5;
// 火星の円盤を地球の地平線から離す角。視半径のこの倍だけ持ち上げると、円盤の下縁が最も厚い
// 大気を、上縁が薄い大気を通って見える構図になる。
const EARTH_MARS_HORIZON_CLEARANCE = 1.25;

// 地球と火星: 大気を持つ天体が2体ある構図。カメラは地球の大気の中から、地平線のすぐ上へ出た
// 火星を見る。**火星の円盤は下縁ほど厚い地球の大気越しに見える**ので、主天体の大気の下で遠くの
// 大気天体がどう保たれるかが1枚の中の階調として出る。距離のつまみを縮めると火星の大気の中まで
// 移動でき、その途中で主天体が入れ替わる。
function earthMars(style: RenderStyle): LabCase {
  const camera = labCamera(1e13);
  const marsCenter = new THREE.Vector3(0, 0, -EARTH_MARS_DISTANCE);
  const margin = EARTH_MARS_HORIZON_CLEARANCE * Math.asin(MARS_RADIUS / EARTH_MARS_DISTANCE);
  const earthCenter = earthCenterBelowHorizon(EARTH_MARS_CAMERA_ALTITUDE, margin);
  return {
    objects: [
      earthAt(earthCenter, style),
      texturedSphere(MARS_TEXTURE, MARS_RADIUS, marsCenter, CLOSE_UP_DIAMETER_PX),
    ],
    camera,
    viewTarget: marsCenter,
    atmospheres: [
      { center: earthCenter, surfaceRadius: R_EARTH, optics: EARTH_ATMOSPHERE_OPTICS },
      { center: marsCenter, surfaceRadius: MARS_RADIUS, optics: MARS_ATMOSPHERE_OPTICS },
    ],
  };
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

// 温度による自照を読むケース。**球はすべて同じ 1 つのマテリアルを共有し、温度だけが個体ごとに
// 違う** — 明るさが球ごとに違って見えることが、個体ごとの温度が届いていることの唯一の印で、
// 全部同じ明るさなら配線が死んでいる。恒星は斜めから差すので、反射に埋もれる昼側と自照だけの
// 夜側が同じ球の上に並ぶ。**円柱は頂点ごとの温度勾配**(左端が平均温度、右端が +550 K)で、
// 赤熱が部品の切れ目ではなく勾配として終わることを見る。
const BLACKBODY_TEMPERATURES = [900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000];
const BLACKBODY_DEPTH = 30;
const BLACKBODY_GRADIENT_AVERAGE = 950;
const BLACKBODY_GRADIENT_DEVIATION = 550;
// 艦が喪失する温度(1,300 K)の少し上。夜側で赤熱として読める明るさになる。
const BLACKBODY_SHIP_TEMPERATURE = 1400;
// 1 本の InstancedMesh へ積む枝の温度 [K]。
const BLACKBODY_INSTANCE_TEMPERATURES = [1200, 1300, 1400, 1500, 1600, 1700];
// 96 発を撃ち切って排出された直後の砲身。平均温度 [K] と、薬室側が平均より高い温度差 [K]。
const BLACKBODY_BARREL_TEMPERATURE = 887;
const BLACKBODY_BARREL_DEVIATION = 619;

// 赤熱を読むための、暗くつや消しの試験体マテリアル。反射で自照が埋もれないアルベドに取る。
function blackbodyMaterial(shaped: boolean, source: ThermalSource = 'object'): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x14161a, roughness: 0.85, metalness: 0 });
  return attachThermalEmissive(material, source, shaped);
}

// 温度勾配を焼いた円柱。軸は画面の横方向で、shape は左端 0・右端 1。
function blackbodyGradientBar(material: THREE.Material, length: number, radius: number): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(radius, radius, length, 24, 96);
  const position = geometry.getAttribute('position');
  const shape = new Float32Array(position.count);
  for (let i = 0; i < position.count; i++) shape[i] = position.getY(i) / length + 0.5;
  geometry.setAttribute(THERMAL_SHAPE_ATTRIBUTE, new THREE.Float32BufferAttribute(shape, 1));
  geometry.rotateZ(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.ownsGeometry = true;
  return mesh;
}

// 個体ごとの温度を持つ枝を 1 本の InstancedMesh へ積んで返す。**同じ 1 本の描画に積まれた
// 個体が、それぞれ違う明るさで光ること**が、個体ごとの温度が属性として届いている印。
function blackbodyInstancedRow(center: THREE.Vector3, spacing: number): THREE.Object3D {
  const host = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(1.6, 1.6, 1.6);
  const material = blackbodyMaterial(false, 'instance');
  const count = BLACKBODY_INSTANCE_TEMPERATURES.length;
  const pool = new InstancedPool(host, geometry, material, count, false, 0, true);
  const piece = new THREE.Object3D();
  pool.beginFrame();
  for (const [i, temperature] of BLACKBODY_INSTANCE_TEMPERATURES.entries()) {
    piece.position.copy(center).setX(center.x + (i - (count - 1) / 2) * spacing);
    piece.rotation.set(0.42, 0.62, 0);
    syncThermalState(piece, temperature, 0, HULL_EMISS);
    pool.push(piece);
  }
  pool.endFrame();
  const mesh = host.children[0]!;
  host.remove(mesh);
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  return mesh;
}

function blackbody(): LabCase {
  const sphereGeometry = new THREE.SphereGeometry(1.1, 32, 16);
  const sphereMaterial = blackbodyMaterial(false);
  const objects: THREE.Object3D[] = [];
  const spacing = 2.8;
  for (const [i, temperature] of BLACKBODY_TEMPERATURES.entries()) {
    const mesh = new THREE.Mesh(sphereGeometry, sphereMaterial);
    mesh.position.set((i - (BLACKBODY_TEMPERATURES.length - 1) / 2) * spacing, 2.2, -BLACKBODY_DEPTH);
    mesh.userData.ownsGeometry = i === 0;
    mesh.userData.ownsMaterial = i === 0;
    syncThermalState(mesh, temperature, 0, HULL_EMISS);
    markLitOpaque(mesh);
    objects.push(mesh);
  }
  const barMaterial = blackbodyMaterial(true);
  const bar = blackbodyGradientBar(barMaterial, 30, 1.0);
  bar.position.set(0, -3.4, -BLACKBODY_DEPTH);
  bar.userData.ownsMaterial = true;
  syncThermalState(bar, BLACKBODY_GRADIENT_AVERAGE, BLACKBODY_GRADIENT_DEVIATION, HULL_EMISS);
  markLitOpaque(bar);
  objects.push(bar);
  objects.push(blackbodyInstancedRow(new THREE.Vector3(-14, -8, -BLACKBODY_DEPTH), 3));
  // 排出直後の砲身。**赤熱が薬室から砲口へ向かって連続して落ちる**ことを見る。
  const barrel = buildBarrelMesh();
  barrel.position.set(0, 6, -20);
  barrel.rotation.set(0, Math.PI / 2, 0.06);
  syncThermalState(barrel, BLACKBODY_BARREL_TEMPERATURE, BLACKBODY_BARREL_DEVIATION, HULL_EMISS);
  objects.push(barrel);
  // 艦 1 隻を同じ絵へ。**モデルから読んだマテリアルにも温度が届く**ことを見る。
  const ship = shipAt(new THREE.Vector3(14, -8, -30), SHIP_ROTATION_PORT);
  syncThermalState(ship, BLACKBODY_SHIP_TEMPERATURE, 0, HULL_EMISS);
  objects.push(ship);
  return { objects, camera: labCamera(6e7), sunDirection: OBLIQUE_SUN_DIR };
}

// 較正: アルベド 1 の完全拡散面を 1 天文単位に置く。**放射照度の単位が「1 AU で π」に取れて
// いれば、太陽へ正対した面のトーンマッピング前の線形値は 1.0 になる** — ランバート BRDF の
// 1/π が単位を打ち消すため。ここが動いたら光の単位か BRDF のどちらかが崩れている。
// 天体照の光源は置かない — 較正はこの 1 本の光だけで読む。
//
// 画面へ出るのはそこから 2 段ぶん先で、**最も明るい画素は sRGB (240, 229, 210)**:
// 恒星光の色 (1, 0.905, 0.761) に誘電体の鏡面(F0=0.04、粗さ 1)のわずかな持ち上がりが乗り、
// PBR Neutral と sRGB 符号化を通した値。
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

// 金属のハイライト: 金属度 1・粗さ 0.05 の球に太陽の円盤が映るか。曲率のゆるい大きな球を
// 水星近日点(視半径 0.86°)の太陽で照らすと、球光源では太陽の円盤が幅十数 px の像として
// 映り、点光源の GGX では粗さぶんの数 px の点に潰れる。
function metalHighlight(): LabCase {
  const camera = labCamera(6e7);
  const surface = new THREE.Mesh(
    new THREE.SphereGeometry(2000, 128, 96),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 1 }),
  );
  surface.position.set(0, -1500, -3000);
  markLitOpaque(surface);
  return { objects: [surface], camera, sunDistance: 0.31 * AU };
}

// 土星: 本体の球と実データの環を並べ、**環だけが本体より桁で明るくないか**を見る。恒星の
// 放射照度は本体(ライティングパスが画素ごとに逆二乗を掛ける)にも環(sync が受け取る)にも
// 同じだけ掛かる。恒星は他のケースと同じ 1 天文単位に置く。
//
// 本体を遮蔽器に、環の帯を遮蔽する環に登録するので、**環が本体の影へ入る境界と、本体表面に
// 落ちる環の影の境界の両方**が同じ 1 つの遮蔽関数から出る。どちらもぼけていることを見る。
function saturn(style: RenderStyle, sunOcclusion: SunOcclusion, sunLight: SunLight): LabCase {
  const camera = labCamera(1e13);
  const radius = 6.0268e7;
  const distance = 1.2e9;
  const center = new THREE.Vector3(0, -0.15 * distance, -distance);
  const axis = v3(0.3, 0.9, 0.32);
  const view = new RingView(SATURN_RINGS, radius, 1, sunOcclusion, sunLight);
  view.sync(center, axis, v3(center.x, center.y, center.z), () => distance / VIEW_HEIGHT, style);
  return {
    objects: [sphere(SATURN_ALBEDO, radius, center), view.group],
    camera,
    occluders: [{ center, radius }],
    rings: {
      center,
      axis: new THREE.Vector3(axis.x, axis.y, axis.z).normalize(),
      bands: occlusionBands(SATURN_RINGS.bands),
    },
  };
}

// 土星(近接): 影の境界だけを見るための構図。saturn は本体が画面上 62px しかなく、半影
// (そこでは 2px 未満)を目で読めない。**環面へ浅い角度で恒星が差す姿勢**(環軸を真上に取り、
// 恒星の仰角を 17° にする)で本体へ寄り、次の 2 つを同じ絵の中で読む:
//
// - **本体表面に落ちる環の影**: カッシーニの間隙が明るい帯として出る。恒星が円盤である以上、
//   その帯の縁は硬くならない(半影 4px 対 帯 19px)。
// - **環が本体の影へ入る境界**: 環の帯を横切る影の縁も、天体の球の半影ぶんだけぼける。
function saturnShadow(style: RenderStyle, sunOcclusion: SunOcclusion, sunLight: SunLight): LabCase {
  const distance = 1.9e8;
  const radius = 6.0268e7;
  // カメラは環面から 20° 傾けて、**恒星とは反対側**へ置く — 同じ側だと影が落ちる面は
  // 常に手前の環の腕に隠れる。真横に置くと環が線に潰れて、影が環を横切る境界を読めない。
  const elevation = 0.35;
  const center = new THREE.Vector3(0, Math.sin(elevation), -Math.cos(elevation)).multiplyScalar(distance);
  // 他のケースと違い、視線は正面ではなく本体の中心へ向ける — 影が落ちるのは環面より南側の
  // 面なので、正面のままだと読みたい範囲が画面の下へ外れる。
  const camera = labCamera(1e13);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  const axis = v3(0, 1, 0);
  const view = new RingView(SATURN_RINGS, radius, 1, sunOcclusion, sunLight);
  view.sync(center, axis, v3(center.x, center.y, center.z), () => distance / VIEW_HEIGHT, style);
  return {
    objects: [sphere(SATURN_ALBEDO, radius, center), view.group],
    camera,
    occluders: [{ center, radius }],
    rings: { center, axis: new THREE.Vector3(axis.x, axis.y, axis.z), bands: occlusionBands(SATURN_RINGS.bands) },
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
      sphere(GREY_SPHERE_ALBEDO, moon / 10, new THREE.Vector3(-0.4 * moon, 0, -moon)),
      sphere(BLUE_SPHERE_ALBEDO, neptune / 10, new THREE.Vector3(0.4 * neptune, 0, -neptune)),
    ],
    camera,
  };
}

// 太陽の向き。**画面中心から外して置く** — 中心だと、注視点へ視線が固定されるぶんカメラ方位を
// 回しても画面上で動かず、サブピクセルの移動そのものが作れない。
const SUN_CASE_DIR = new THREE.Vector3(0.2563, 0.1392, -0.9565).normalize();
// 注視点に据える艦の位置。カメラはこの近点を軸に回るので、遠くの太陽は方位の変化ぶんそのまま
// 画面上を動く。艦の縁で太陽が隠れる様子も同じ絵で読める。
const SUN_CASE_SHIP_POSITION = new THREE.Vector3(0, -1, -10);

// 恒星までの距離 [m] と画角 [deg] に対する、画面上での太陽の見かけ直径 [px]。**LOD の閾値判定と
// 同じ換算を通す** — つまみの脇に出る数と、球/点像の切り替わる距離が食い違ってはならない。
export function sunDiameterPx(distance: number, fovDeg: number): number {
  return apparentSizePx(2 * R_SUN, metersPerPixelAtDepth(fovDeg, distance, VIEW_HEIGHT));
}

// 太陽: 恒星の実球体を distance [m] に置く。**遠ざかると見かけ径が 1px を切り**、総光量が
// ラスタライズの被覆率へ量子化される — サブピクセルの移動に対する画面のちらつきを、この構図で測る。
// 距離はここで決めるのは既定値だけで、球を実際に置くのは恒星のつまみを読む側(lab.ts)。
function sunAt(distance: number): LabCase {
  const camera = labCamera(1e13);
  return {
    objects: [shipAt(SUN_CASE_SHIP_POSITION)],
    camera,
    sunDirection: SUN_CASE_DIR,
    sunDistance: distance,
    star: createStarSphere(SUN_SURFACE_COLOR, SUN_SURFACE_RADIANCE),
    viewTarget: SUN_CASE_SHIP_POSITION,
  };
}

export const CASES = {
  'leo': leo,
  'earthshine': earthshine,
  'crescent': crescent,
  // 水星近日点。視半径 0.86° の太陽で、終端の幅が球光源のときだけ広がる。
  'sun-close': () => outer(0.31 * AU),
  'outer-5au': () => outer(5 * AU),
  'outer-10au': () => outer(10 * AU),
  'outer-30au': () => outer(30 * AU),
  'ship-selfshadow': shipSelfShadow,
  'ship-backlit': shipBacklit,
  'ship-cluster': shipCluster,
  'ship-crowd': shipCrowd,
  'ship-far-shadow': shipFarShadow,
  'ship-in-debris': shipInDebris,
  'ship-body-shadow': shipBodyShadow,
  'order': order,
  'depth-1e4': () => depthProbe(1e4, 6e7),
  'depth-1e6': () => depthProbe(1e6, 6e7),
  'depth-1e8': () => depthProbe(1e8, 1e13),
  'depth-1e11': () => depthProbe(1e11, 1e13),
  'eclipse': eclipse,
  'march-slab': marchSlab,
  'earth': earth,
  'earth-terminator': earthTerminator,
  'earth-eclipse': earthEclipse,
  'earth-mars': earthMars,
  'far': far,
  'saturn': saturn,
  'saturn-shadow': saturnShadow,
  'albedo': albedo,
  'metal-highlight': metalHighlight,
  'sun-1au': () => sunAt(AU),
  'sun-5au': () => sunAt(5.2 * AU),
  'sun-30au': () => sunAt(30 * AU),
  'blackbody': blackbody,
  ...PROTEIN_CASES,
} as const satisfies Record<
  string, (style: RenderStyle, sunOcclusion: SunOcclusion, sunLight: SunLight) => LabCase
>;

export type CaseName = keyof typeof CASES;
export const CASE_NAMES = Object.keys(CASES) as readonly CaseName[];
