// 描画テスト環境が描くケースの表。ゲーム本体と同じ球・艦・線を組んでカメラと一緒に返すだけで、
// シーンへ足すのもチャンネルを振るのも呼び出し側の仕事。ケースを増やすのはこの表への追記で済む。
import * as THREE from 'three/webgpu';
import { CelestialSurface } from '../../src/render/celestial-surface';
import { rec709Luminance, type Albedo } from '../../src/render/celestial-albedo';
import { createEarth } from '../../src/render/earth';
import { R_EARTH } from '../../src/physics/solar-system';
import { Curve } from '../../src/render/curve';
import { buildPlayerShip } from '../../src/render/ships';
import { InstancedPool } from '../../src/render/instanced-pool';
import { markLitOpaque } from '../../src/render/pipeline/lit-layer';
import type { Occluder, RingBand, SunOcclusion } from '../../src/render/pipeline/sun-occlusion';
import type { LineStyle } from '../../src/render/line-style';
import { RingView } from '../../src/game/celestial/ring-view';
import type { SunLight } from '../../src/render/pipeline/sun-light';
import { bodyDef, SOLAR_SYSTEM } from '../../src/physics/solar-system';
import { textureOf } from '../../src/render/celestial-textures';
import { v3 } from '../../src/physics/vec3';
import { LINE_RENDER_ORDER } from '../../src/render/line-style';
import { PROTEIN_CASES } from './protein-cases';
import type { ProteinLabCaseMetadata } from './protein-cases';
import type { ProteinMotionFrameSample } from '../../src/protein-motion-metrics';

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

// 土星の環を遮蔽パスへ渡す形へ直したもの。RingView が描く帯と同じ表から引く。
const SATURN_OCCLUSION_BANDS: readonly RingBand[] = SATURN_RINGS.bands.map((band) => ({
  innerRadius: band.innerRadius,
  outerRadius: band.outerRadius,
  normalOpticalDepth: band.optics.normalOpticalDepth,
}));

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
  // 恒星の向き(原点から見た単位ベクトル)。省略すると SUN_DIR。
  readonly sunDirection?: THREE.Vector3;
  // カメラを周回させるときに中心へ据える点(描画座標)。省略するとケースの物体を包む箱の中心。
  readonly viewTarget?: THREE.Vector3;
  // 大気パスへ渡す天体。中心は描画座標。
  readonly atmosphere?: { readonly center: THREE.Vector3; readonly surfaceRadius: number };
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
  // 見かけ直径は画面の高さぶんとみなす(ケースの球はおおむね画面いっぱいに写る)。
  surface.syncLod(VIEW_HEIGHT);
  return group;
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

// 自機メッシュ 1 隻を、描画座標の position へ置く。rotation を渡すと機体の姿勢を回す。
function shipAt(position: THREE.Vector3, rotation?: THREE.Euler): THREE.Object3D {
  const group = buildPlayerShip();
  group.position.copy(position);
  if (rotation !== undefined) group.rotation.copy(rotation);
  return group;
}

// 斜光のケースで使う恒星の向きと、機体の姿勢。カメラは −Z を見るので、恒星を左上手前へ置き、
// 機体を上面と左舷が見える向きへ回すと、突起の影が見えている面を横切る。
const OBLIQUE_SUN_DIR = new THREE.Vector3(-0.70, 0.20, 0.68).normalize();
const OBLIQUE_SHIP_ROTATION = new THREE.Euler(-0.5, 0.6, 0.12);

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
    objects: [shipAt(shipPosition, OBLIQUE_SHIP_ROTATION)],
    camera: labCamera(6e7),
    sunDirection: OBLIQUE_SUN_DIR,
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
    objects: positions.map((position) => shipAt(position, OBLIQUE_SHIP_ROTATION)),
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
    objects: positions.map((position) => shipAt(position, OBLIQUE_SHIP_ROTATION)),
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
      shipAt(receiver, OBLIQUE_SHIP_ROTATION),
      shipAt(new THREE.Vector3(3000, 0, -10), OBLIQUE_SHIP_ROTATION),
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
    objects: [shipAt(shipPosition, OBLIQUE_SHIP_ROTATION), debrisPool(shipPosition, 512)],
    camera: labCamera(6e7),
    sunDirection: OBLIQUE_SUN_DIR,
    viewTarget: shipPosition,
  };
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
  const shipPosition = new THREE.Vector3(0, -1, -10);
  return {
    objects: [
      sphere(BLUE_SPHERE_ALBEDO, 6.371e6, center),
      circle(center, orbitRadius, u, v, style, camera),
      shipAt(shipPosition),
    ],
    camera,
    viewTarget: shipPosition,
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

// 日食下の地球: earth と同じ構図へ、地球自身と食を起こす球を遮蔽器として足す。**大気の明暗は
// 入射角だけでなく遮蔽度にも比例する**ので、リムともやの両方へ影の落ちた斑が出る。遮蔽器の
// 視半径は太陽よりわずかに大きく取ってあり、本影(半径 60km)を半影(340km)が縁取る。
function earthEclipse(): LabCase {
  const base = earth();
  const center = base.atmosphere!.center;
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
//
// 本体を遮蔽器に、環の帯を遮蔽する環に登録するので、**環が本体の影へ入る境界と、本体表面に
// 落ちる環の影の境界の両方**が同じ 1 つの遮蔽関数から出る。どちらもぼけていることを見る。
function saturn(sunOcclusion: SunOcclusion, sunLight: SunLight): LabCase {
  const camera = labCamera(1e13);
  const radius = 6.0268e7;
  const distance = 1.2e9;
  const center = new THREE.Vector3(0, -0.15 * distance, -distance);
  const axis = v3(0.3, 0.9, 0.32);
  const view = new RingView(SATURN_RINGS, radius, 1, sunOcclusion, sunLight);
  view.sync(
    center,
    axis,
    v3(center.x, center.y, center.z),
    () => distance / VIEW_HEIGHT,
  );
  return {
    objects: [sphere(SATURN_ALBEDO, radius, center), view.group],
    camera,
    occluders: [{ center, radius }],
    rings: {
      center,
      axis: new THREE.Vector3(axis.x, axis.y, axis.z).normalize(),
      bands: SATURN_OCCLUSION_BANDS,
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
function saturnShadow(sunOcclusion: SunOcclusion, sunLight: SunLight): LabCase {
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
  view.sync(center, axis, v3(center.x, center.y, center.z), () => distance / VIEW_HEIGHT);
  return {
    objects: [sphere(SATURN_ALBEDO, radius, center), view.group],
    camera,
    occluders: [{ center, radius }],
    rings: { center, axis: new THREE.Vector3(axis.x, axis.y, axis.z), bands: SATURN_OCCLUSION_BANDS },
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

export const CASES = {
  'leo': leo,
  'ship-selfshadow': shipSelfShadow,
  'ship-cluster': shipCluster,
  'ship-crowd': shipCrowd,
  'ship-far-shadow': shipFarShadow,
  'ship-in-debris': shipInDebris,
  'order': order,
  'depth-1e4': () => depthProbe(1e4, 6e7),
  'depth-1e6': () => depthProbe(1e6, 6e7),
  'depth-1e8': () => depthProbe(1e8, 1e13),
  'depth-1e11': () => depthProbe(1e11, 1e13),
  'eclipse': eclipse,
  'earth': earth,
  'earth-eclipse': earthEclipse,
  'far': far,
  'saturn': saturn,
  'saturn-shadow': saturnShadow,
  'albedo': albedo,
  ...PROTEIN_CASES,
} as const satisfies Record<string, (sunOcclusion: SunOcclusion, sunLight: SunLight) => LabCase>;

export type CaseName = keyof typeof CASES;
export const CASE_NAMES = Object.keys(CASES) as readonly CaseName[];
