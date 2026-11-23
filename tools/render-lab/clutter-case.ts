// 雑多な構造のケース。白い床の 7 m × 5 m の区画に、細い柱の林・トラスの立方体・細かい階段・蛇腹と L 字に折った板・
// 突起の板とグレーチング・散らばった小箱を密に置く。画面上で幅が数画素の構造と、向きの急に変わる面と輪郭が密に並ぶ
// 上で、近くの構造による遮りと照り返しが欠けずに出るかを読む試験体。
import * as THREE from 'three/webgpu';
import { markLitOpaque, markShadowCaster } from '../../src/render/pipeline/lit-layer';
import { anglesFromDirection, directionFromAngles } from './view-angles';
import { labCamera, OVERHEAD_EARTH, slab, white, type CaseBuilder, type LabCase } from './lab-case';

// 床に置く姿勢。鉛直軸から見た位置 x・z [m] と、x・y・z 軸まわりの角 rotationDeg [deg]。角は z・x・y の順に掛かり、
// 最後の y が方位の回転になる。
interface FloorPose {
  readonly x: number;
  readonly z: number;
  readonly rotationDeg: readonly [number, number, number];
}

// 棒の断面。
type RodSection = 'square' | 'round';

// 区画の半幅(x)と半奥行き(z)[m]。中心は原点で、部品はおおむねこの中に置く。
const DISTRICT_HALF_WIDTH = 3.5;
const DISTRICT_HALF_DEPTH = 2.5;

// 細い柱の林。区画の −X・−Z の隅から、列数(x)・行数(z)・間隔 [m] の格子に並べ、格子から最大 ±FOREST_JITTER/2 [m]
// ずらす。
const FOREST_COLUMNS = 10;
const FOREST_ROWS = 4;
const FOREST_PITCH = 0.5;
const FOREST_JITTER = 0.3;
// 柱の太さの候補と高さの範囲 [m]。断面は角柱と円柱を半々に混ぜ、角柱は軸まわりに回す。
const PILLAR_THICKNESSES = [0.02, 0.03, 0.05, 0.08, 0.12];
const PILLAR_MIN_HEIGHT = 0.4;
const PILLAR_MAX_HEIGHT = 2;
// 立てたままにする柱の割合と、残りを傾ける鉛直からの角の上限 [deg]。
const UPRIGHT_SHARE = 0.6;
const MAX_LEAN_DEG = 45;
// 円柱の周の分割数。
const ROUND_SEGMENTS = 24;

// トラスの立方体: 一辺と梁の太さ [m] と、床に置く姿勢。
const TRUSSES = [
  { size: 1.5, beam: 0.05, x: 2.6, z: -1.7, rotationDeg: [0, 0, 0] },
  { size: 1.2, beam: 0.03, x: -0.9, z: 0.45, rotationDeg: [0, 30, 0] },
] as const;
// トラスの面の筋交いの両端の角。角の添字の 3 つの bit が x・y・z の正負を表し、向かい合う面で対角を入れ違える。
const TRUSS_BRACES = [[0, 3], [5, 6], [0, 5], [3, 6], [0, 6], [3, 5]] as const;

// 細かい階段と粗い階段: 蹴上げ・踏面・幅 [m] と段数、床に置く姿勢。姿勢 0 では +X へ上る。
const STAIRS = [
  { rise: 0.04, tread: 0.06, steps: 25, width: 0.8, x: -2.65, z: 0.1, rotationDeg: [0, 180, 0] },
  { rise: 0.1, tread: 0.15, steps: 8, width: 0.8, x: -2.7, z: 1.7, rotationDeg: [0, 120, 0] },
] as const;

// 蛇腹に折った板の厚みと、折り返して進む長さ [m]。
const PLEAT_THICKNESS = 0.01;
const PLEAT_RUN = 0.7;
// 蛇腹に折った板: 山と谷の内角 [deg]・面の幅 [m]・折れ目に沿う幅 [m] と、床に置く姿勢。姿勢 0 では床に伏せて折れ目を
// z に沿わせ、x を −90° 回すと折れ目を鉛直にした屏風になる。
const PLEATS = [
  { foldDeg: 30, facet: 0.1, width: 0.6, x: -1.2, z: 1.8, rotationDeg: [0, 10, 0] },
  { foldDeg: 60, facet: 0.05, width: 0.6, x: 0.15, z: 1.45, rotationDeg: [0, -35, 0] },
  { foldDeg: 90, facet: 0.2, width: 0.5, x: 1.4, z: 1.75, rotationDeg: [-90, 15, 0] },
  { foldDeg: 120, facet: 0.15, width: 0.5, x: 3, z: 0.3, rotationDeg: [-90, 80, 0] },
] as const;

// L 字に折った薄い板: 二つの脚の長さ・厚み・折れ目に沿う幅 [m] と、床に置く姿勢。姿勢 0 では一方の脚を床に伏せ、
// もう一方を立てる。
const CORNER_PLATES = [
  { legs: [0.35, 0.25], thickness: 0.015, width: 0.4, x: -0.4, z: 2.2, rotationDeg: [0, 25, 0] },
  { legs: [0.3, 0.3], thickness: 0.02, width: 0.45, x: 0.9, z: 2.3, rotationDeg: [-90, -30, 0] },
  { legs: [0.3, 0.3], thickness: 0.01, width: 0.35, x: 2.3, z: 1.5, rotationDeg: [0, 60, -135] },
  { legs: [0.25, 0.25], thickness: 0.015, width: 0.4, x: 3, z: 2.1, rotationDeg: [0, -15, 45] },
  { legs: [0.3, 0.2], thickness: 0.02, width: 0.3, x: -1.75, z: 0.85, rotationDeg: [30, 40, 20] },
  { legs: [0.35, 0.2], thickness: 0.01, width: 0.3, x: 2, z: 2.35, rotationDeg: [70, -40, 15] },
] as const;

// 突起の板: 一辺 STUD_GRID 個の格子の間隔と、突起(立方体)の一辺の候補、板の厚み [m]、床に置く姿勢。
const STUD_GRID = 9;
const STUD_PITCH = 0.08;
const STUD_SIZES = [0.02, 0.03, 0.04];
const STUD_PLATE_THICKNESS = 0.02;
const STUD_PLATE_POSE: FloorPose = { x: 0.6, z: 0.1, rotationDeg: [0, 15, 0] };

// グレーチング: 縁を立てた羽板の厚み・隙間・高さ・長さ [m] と枚数、その下に直交して渡す横桟の太さ [m] と本数、
// 床に置く姿勢。
const SLAT_THICKNESS = 0.02;
const SLAT_GAP = 0.04;
const SLAT_HEIGHT = 0.05;
const SLAT_LENGTH = 0.9;
const SLAT_COUNT = 15;
const CROSSBAR_SIZE = 0.02;
const CROSSBAR_COUNT = 4;
const GRATING_POSE: FloorPose = { x: 1.75, z: 0.35, rotationDeg: [0, -20, 0] };

// 散らばった小箱: 個数と、各辺の長さの範囲 [m]、傾きの上限 [deg]。区画の全体へ散らし、ほかの部品と交わってよい。
const BOX_COUNT = 36;
const BOX_MIN_SIZE = 0.03;
const BOX_MAX_SIZE = 0.2;
const BOX_MAX_TILT_DEG = 45;
// 黄金比の逆数。小箱を区画へ偏りなく散らす格子の、x の刻み。
const GOLDEN_RATIO_INVERSE = (Math.sqrt(5) - 1) / 2;

// scatter へ渡す部品ごとの種。部品のあいだで値の並びを揃えない。
const SEEDS = { pillar: 1, box: 2, stud: 3 } as const;

// 床の、どの部品からも近傍の半径(4 m)より外まで広げる幅と、厚み [m]。上面は y = 0。
const FLOOR_MARGIN = 4.5;
const FLOOR_THICKNESS = 0.2;

// 観察の中心と、既定のカメラの方位・仰角 [deg]・距離 [m]。右手前から見下ろす — 区画の全体を画面に収め、区画の中心で
// 1 画素が約 1.4 cm になる距離。
const VIEW_TARGET = new THREE.Vector3(0, 0.3, 0.3);
const CAMERA_AZIMUTH_DEG = 20;
const CAMERA_ELEVATION_DEG = 40;
const CAMERA_DISTANCE = 8;
// 遠景の撮影の、カメラの距離の倍率。
const FAR_DISTANCE_SCALE = 2;

// 恒星の方位・仰角 [deg]。カメラから見て左手から低く差す。仰角は真上の地球の縁(仰角 20°)より低くする — 高いと
// 恒星が地球に隠れる。
const SUN_AZIMUTH_DEG = -70;
const SUN_ELEVATION_DEG = 15;

// 部品の種 seed と個体の添字 i(1024 未満)から決まる、[0, 1) の 8 つの値。配置と寸法を決定的に散らす。
function scatter(
  seed: number, i: number,
): readonly [number, number, number, number, number, number, number, number] {
  // 32 bit の整数ハッシュ(lowbias32)。
  const unit = (k: number): number => {
    const n = (seed * 1024 + i) * 8 + k + 1;
    const a = Math.imul(n ^ (n >>> 16), 0x7feb352d);
    const b = Math.imul(a ^ (a >>> 15), 0x846ca68b);
    return ((b ^ (b >>> 16)) >>> 0) / 2 ** 32;
  };
  return [unit(0), unit(1), unit(2), unit(3), unit(4), unit(5), unit(6), unit(7)];
}

// [0, 1) の値 u で、options から 1 つを選ぶ。
function pick<T>(options: readonly T[], u: number): T {
  return options[Math.floor(u * options.length)]!;
}

// geometry の白い Mesh。ジオメトリとマテリアルは Mesh が所有する。
function whiteMesh(geometry: THREE.BufferGeometry): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, white());
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  return mesh;
}

// object を姿勢 pose で置き、いちばん低い点を床の上面(y = 0)へ下ろす。
function placed<T extends THREE.Object3D>(object: T, pose: FloorPose): T {
  const [x, y, z] = pose.rotationDeg;
  const rad = THREE.MathUtils.degToRad;
  object.rotation.set(rad(x), rad(y), rad(z), 'YXZ');
  object.position.set(pose.x, 0, pose.z);
  object.position.y = -new THREE.Box3().setFromObject(object, true).min.y;
  return object;
}

// 太さ thickness [m] の棒を、描画座標の from から to まで渡す。断面の辺は、水平な辺と、棒を含む鉛直面内の辺に揃え、
// そこから軸まわりに spinDeg [deg] 回す。
function rod(from: THREE.Vector3, to: THREE.Vector3, thickness: number, section: RodSection, spinDeg = 0): THREE.Mesh {
  const axis = new THREE.Vector3().subVectors(to, from);
  const geometry = section === 'square'
    ? new THREE.BoxGeometry(thickness, axis.length(), thickness)
    : new THREE.CylinderGeometry(thickness / 2, thickness / 2, axis.length(), ROUND_SEGMENTS);
  geometry.rotateY(THREE.MathUtils.degToRad(spinDeg));
  // 立てた棒を、鉛直から傾けてから方位へ回す。
  const { azimuthDeg, elevationDeg } = anglesFromDirection(axis);
  const mesh = whiteMesh(geometry);
  mesh.rotation.set(THREE.MathUtils.degToRad(90 - elevationDeg), THREE.MathUtils.degToRad(azimuthDeg), 0, 'YXZ');
  mesh.position.addVectors(from, to).multiplyScalar(0.5);
  return mesh;
}

// 林の i 番目の柱。格子から位置をずらし、太さ・高さ・断面・傾き・軸まわりの回転を散らす。根元は床の上面に置く。
function pillar(i: number): THREE.Mesh {
  const [xPick, zPick, thicknessPick, heightPick, sectionPick, leanPick, azimuthPick, spinPick] =
    scatter(SEEDS.pillar, i);
  const base = new THREE.Vector3(
    -DISTRICT_HALF_WIDTH + ((i % FOREST_COLUMNS) + 0.5) * FOREST_PITCH + (xPick - 0.5) * FOREST_JITTER,
    0,
    -DISTRICT_HALF_DEPTH + (Math.floor(i / FOREST_COLUMNS) + 0.5) * FOREST_PITCH + (zPick - 0.5) * FOREST_JITTER,
  );
  // 割合 UPRIGHT_SHARE は立て、残りは傾きを 0〜MAX_LEAN_DEG に散らす。
  const leanDeg = Math.max(0, leanPick - UPRIGHT_SHARE) / (1 - UPRIGHT_SHARE) * MAX_LEAN_DEG;
  const height = THREE.MathUtils.lerp(PILLAR_MIN_HEIGHT, PILLAR_MAX_HEIGHT, heightPick);
  const top = directionFromAngles(azimuthPick * 360, 90 - leanDeg, new THREE.Vector3())
    .multiplyScalar(height).add(base);
  return rod(base, top, pick(PILLAR_THICKNESSES, thicknessPick), sectionPick < 0.5 ? 'square' : 'round', spinPick * 90);
}

// 一辺 size [m]・梁の太さ beam [m] のトラスの立方体。辺の梁と、各面の対角の筋交いからなる。中心を原点に置く。
function truss(size: number, beam: number): THREE.Group {
  // 梁の中心線がなす立方体の角。添字の 3 つの bit が x・y・z の正負を表す。
  const half = (size - beam) / 2;
  const corner = (i: number): THREE.Vector3 => new THREE.Vector3(
    i & 1 ? half : -half, i & 2 ? half : -half, i & 4 ? half : -half,
  );
  // 辺の梁。角で直交する梁どうしが角を埋めるよう、両端を梁の太さの半分ずつ延ばす。
  const edges: THREE.Mesh[] = [];
  for (const bit of [1, 2, 4]) {
    for (let i = 0; i < 8; i++) {
      if (i & bit) continue;
      const from = corner(i);
      const to = corner(i | bit);
      const pad = new THREE.Vector3().subVectors(to, from).setLength(beam / 2);
      edges.push(rod(from.sub(pad), to.add(pad), beam, 'square'));
    }
  }
  const braces = TRUSS_BRACES.map(([a, b]) => rod(corner(a), corner(b), beam, 'square'));
  return new THREE.Group().add(...edges, ...braces);
}

// 断面 profile(xy 平面の多角形 [m])を z へ width [m] 押し出した柱体。中心を原点に置く。
function prism(profile: THREE.Vector2[], width: number): THREE.Mesh {
  const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(profile), { depth: width, bevelEnabled: false });
  geometry.center();
  return whiteMesh(geometry);
}

// 段数 steps の階段の断面。蹴上げ rise・踏面 tread [m] で +x へ上り、最上段の奥から床へ垂直に下ろす。
function stairProfile(rise: number, tread: number, steps: number): THREE.Vector2[] {
  const treads = Array.from({ length: steps }, (_, k) => [
    new THREE.Vector2(k * tread, (k + 1) * rise), new THREE.Vector2((k + 1) * tread, (k + 1) * rise),
  ]);
  return [new THREE.Vector2(0, 0), ...treads.flat(), new THREE.Vector2(steps * tread, 0)];
}

// 床に伏せた蛇腹の断面。山と谷の内角 foldDeg [deg]・面の幅 facet [m] で +x へ PLEAT_RUN ほど折り返し、厚みは
// PLEAT_THICKNESS。
function pleatProfile(foldDeg: number, facet: number): THREE.Vector2[] {
  const halfFold = THREE.MathUtils.degToRad(foldDeg / 2);
  const step = facet * Math.sin(halfFold);
  const rise = facet * Math.cos(halfFold);
  const lower = Array.from(
    { length: Math.round(PLEAT_RUN / step) + 1 }, (_, k) => new THREE.Vector2(k * step, k % 2 === 0 ? 0 : rise),
  );
  // 上の面は下の面を真上へずらしたもの。面に垂直に測った厚みが PLEAT_THICKNESS になる量だけずらす。
  const lift = PLEAT_THICKNESS / Math.sin(halfFold);
  const upper = lower.map((p) => new THREE.Vector2(p.x, p.y + lift)).reverse();
  return [...lower, ...upper];
}

// L 字の断面。脚の長さ legs [m] で x と y へ伸ばし、厚みは thickness [m]。
function cornerProfile([a, b]: readonly [number, number], thickness: number): THREE.Vector2[] {
  const t = thickness;
  return [
    new THREE.Vector2(0, 0), new THREE.Vector2(a, 0), new THREE.Vector2(a, t),
    new THREE.Vector2(t, t), new THREE.Vector2(t, b), new THREE.Vector2(0, b),
  ];
}

// 突起の板。板の上面に、一辺を STUD_SIZES から選んだ立方体の突起を STUD_GRID × STUD_GRID の格子に並べる。上面の
// 中心を原点に置く。
function studdedPlate(): THREE.Group {
  const half = STUD_GRID * STUD_PITCH / 2;
  const studs = Array.from({ length: STUD_GRID * STUD_GRID }, (_, i) => {
    const [sizePick] = scatter(SEEDS.stud, i);
    const size = pick(STUD_SIZES, sizePick);
    const center = new THREE.Vector3(
      ((i % STUD_GRID) + 0.5) * STUD_PITCH - half, size / 2, (Math.floor(i / STUD_GRID) + 0.5) * STUD_PITCH - half,
    );
    return slab(center.clone().subScalar(size / 2), center.clone().addScalar(size / 2));
  });
  const plate = slab(new THREE.Vector3(-half, -STUD_PLATE_THICKNESS, -half), new THREE.Vector3(half, 0, half));
  return new THREE.Group().add(plate, ...studs);
}

// グレーチング。縁を立てた羽板を SLAT_GAP の隙間で並べ、その下に羽板と直交する横桟を渡す。中心を原点に置く。
function grating(): THREE.Group {
  const pitch = SLAT_THICKNESS + SLAT_GAP;
  const halfSpan = (SLAT_COUNT * pitch - SLAT_GAP) / 2;
  const halfLength = SLAT_LENGTH / 2;
  const slats = Array.from({ length: SLAT_COUNT }, (_, k) => {
    const x = k * pitch - halfSpan;
    return slab(
      new THREE.Vector3(x, CROSSBAR_SIZE, -halfLength),
      new THREE.Vector3(x + SLAT_THICKNESS, CROSSBAR_SIZE + SLAT_HEIGHT, halfLength),
    );
  });
  const crossbars = Array.from({ length: CROSSBAR_COUNT }, (_, k) => {
    const z = ((k + 0.5) / CROSSBAR_COUNT - 0.5) * SLAT_LENGTH;
    return slab(
      new THREE.Vector3(-halfSpan, 0, z - CROSSBAR_SIZE / 2),
      new THREE.Vector3(halfSpan, CROSSBAR_SIZE, z + CROSSBAR_SIZE / 2),
    );
  });
  return new THREE.Group().add(...slats, ...crossbars);
}

// i 番目の小箱。区画の全体へ黄金比の格子で散らし、各辺の長さと姿勢を散らして床に置く。
function scatteredBox(i: number): THREE.Mesh {
  const [sizeXPick, sizeYPick, sizeZPick, tiltXPick, yawPick, tiltZPick] = scatter(SEEDS.box, i);
  // 辺の長さは対数で一様に散らす — 小さい箱ほど多い。
  const side = (u: number): number => BOX_MIN_SIZE * (BOX_MAX_SIZE / BOX_MIN_SIZE) ** u;
  const tilt = (u: number): number => (2 * u - 1) * BOX_MAX_TILT_DEG;
  return placed(whiteMesh(new THREE.BoxGeometry(side(sizeXPick), side(sizeYPick), side(sizeZPick))), {
    x: DISTRICT_HALF_WIDTH * (2 * ((i * GOLDEN_RATIO_INVERSE) % 1) - 1),
    z: DISTRICT_HALF_DEPTH * (2 * (i + 0.5) / BOX_COUNT - 1),
    rotationDeg: [tilt(tiltXPick), yawPick * 360, tilt(tiltZPick)],
  });
}

// 区画の部品と、その全体を囲む床を 1 つの枝にまとめる — 影パスの枠が全体で 1 つになる。
function structure(): THREE.Object3D {
  const group = new THREE.Group().add(
    ...Array.from({ length: FOREST_COLUMNS * FOREST_ROWS }, (_, i) => pillar(i)),
    ...TRUSSES.map((t) => placed(truss(t.size, t.beam), t)),
    ...STAIRS.map((s) => placed(prism(stairProfile(s.rise, s.tread, s.steps), s.width), s)),
    ...PLEATS.map((p) => placed(prism(pleatProfile(p.foldDeg, p.facet), p.width), p)),
    ...CORNER_PLATES.map((c) => placed(prism(cornerProfile(c.legs, c.thickness), c.width), c)),
    placed(studdedPlate(), STUD_PLATE_POSE),
    placed(grating(), GRATING_POSE),
    ...Array.from({ length: BOX_COUNT }, (_, i) => scatteredBox(i)),
  );
  // 床は、部品の全体を水平に FLOOR_MARGIN ずつ囲む。
  const bounds = new THREE.Box3().setFromObject(group);
  group.add(slab(
    new THREE.Vector3(bounds.min.x - FLOOR_MARGIN, -FLOOR_THICKNESS, bounds.min.z - FLOOR_MARGIN),
    new THREE.Vector3(bounds.max.x + FLOOR_MARGIN, 0, bounds.max.z + FLOOR_MARGIN),
  ));
  markLitOpaque(group);
  markShadowCaster(group);
  return group;
}

// 雑多な構造。恒星は左手から低く差し、地球は真上に置く — 天体照と環境光の遮りと、日の当たる面の照り返しが同じ絵に
// 入る。
function clutter(): LabCase {
  const camera = labCamera();
  camera.position.copy(VIEW_TARGET).addScaledVector(
    directionFromAngles(CAMERA_AZIMUTH_DEG, CAMERA_ELEVATION_DEG, new THREE.Vector3()), CAMERA_DISTANCE,
  );
  camera.lookAt(VIEW_TARGET);
  camera.updateMatrixWorld();
  return {
    objects: [structure()],
    camera,
    viewTarget: VIEW_TARGET,
    sunDirection: directionFromAngles(SUN_AZIMUTH_DEG, SUN_ELEVATION_DEG, new THREE.Vector3()),
    earth: OVERHEAD_EARTH,
    shots: {
      'clutter': { view: {} },
      // 同じ場面を FAR_DISTANCE_SCALE 倍の距離から撮る — 構造の多くが画面上で 1〜5 px に縮む。
      'clutter-far': { view: { cameraDistanceLog: Math.log10(FAR_DISTANCE_SCALE) } },
    },
  };
}

export const CLUTTER_CASES = {
  'clutter': clutter,
} as const satisfies Record<string, CaseBuilder>;
