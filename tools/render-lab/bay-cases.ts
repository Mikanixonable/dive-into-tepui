// 荷室のケース。白い床に奥の壁と両端の壁を立てて手前と上を開けた荷室へ、立方体・トラス・光る箱・
// 金属の板・薬莢を置き、低軌道の地球を真上に据える。同じ材質・同じ向きの面が、開けた外側と囲まれた
// 内側でどれだけ明るさと色を変えるか(近くの構造による天体照と環境光の遮り、明るい面と自己発光する面の
// 照り返し、滑らかな面への近くの物体の映り込み)を読む試験体。
import * as THREE from 'three/webgpu';
import { R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import { CasingPool } from '../../src/render/dynamic/dynamic-entity/casing-view';
import { markLitOpaque, markShadowCaster } from '../../src/render/pipeline/lit-layer';
import { directionFromAngles, type EarthAngleKey, type LabViewAngles } from './view-angles';
import { EARTH_AWAY, labCamera, OBLIQUE_SUN_DIR, type CaseBuilder, type LabCase } from './lab-case';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';

// 白い面の線形の灰色の値と粗さ。
const WHITE = 0.8;
const WHITE_ROUGHNESS = 0.7;
// 日の当たる端の壁(+X。ケースの恒星は −X から差す)の内面の色(線形 RGB)。
const ORANGE = new THREE.Vector3(0.8, 0.3, 0.05);

// 床の寸法 [m]。上面は y = 0。荷室の外へ左右 6 m ずつはみ出させる — 外側に、4 m 以内に遮りの無い床を残す。
// 手前の縁は荷室の開口に揃える — 後ろから見下ろすと、開口の先に真下の地球が見える。
const FLOOR_SIZE = new THREE.Vector3(20, 0.2, 8);
// 荷室の内寸 [m]。内面は x = ±BAY_HALF_WIDTH、奥の壁の内面は z = BAY_BACK_Z で、z = BAY_FRONT_Z で開ける。
const BAY_HALF_WIDTH = 4;
const BAY_BACK_Z = -3;
const BAY_FRONT_Z = 3;
const WALL_HEIGHT = 2.5;
const WALL_THICKNESS = 0.2;

// 床の中央の白い立方体の一辺 [m]。
const CUBE_SIZE = 1.2;
// 光る箱の寸法と底面の中心 [m]。奥の壁から離して床に置く — 壁に貼ると壁と同じ面になり、壁も床も照らさない。
const GLOW_SIZE = new THREE.Vector3(0.6, 0.3, 0.6);
const GLOW_BASE = new THREE.Vector3(0, 0, -2.3);
// 光る箱の自己発光の色と放射輝度。放射輝度は「1 天文単位で恒星に正対したアルベド 1 の面 = 1」の目盛り。
const GLOW_COLOR = new THREE.Vector3(0.2, 1, 1);
const GLOW_RADIANCE = 1.5;

// トラスの梁の断面の一辺 [m] と、1 m 格子の区画の数(x・y・z)、格子の最小の角 [m]。橙の壁とのあいだに 1 m の
// 床を残す。高さは奥の壁を越えさせる — 後ろから見下ろすと、壁の上に出た段が開口の先の地球を背にする。
const TRUSS_BEAM = 0.15;
const TRUSS_CELLS = new THREE.Vector3(2, 3, 2);
const TRUSS_CORNER = new THREE.Vector3(0.85, 0, -2.2);

// 金属の板の一辺と厚み [m]、中心の x と、奥から手前へ並べる中心の z と粗さ。板は +X を向く — 右手前から
// 見ると、手前の板は立方体を、中の板は光る箱を映す。
const PLATE_SIZE = 1.5;
const PLATE_THICKNESS = 0.04;
const PLATE_X = -2.6;
const PLATES = [
  { z: -1.1, roughness: 0.8 },
  { z: 0.5, roughness: 0.4 },
  { z: 2.1, roughness: 0.05 },
];

// 板の手前の床に寝かせる薬莢の中心の x・z [m] と、軸の方位 [rad]。軸は奥行き(z)に沿わせる。
const CASINGS = [
  { x: -2.05, z: -1.55, yaw: Math.PI / 2 },
  { x: -2.05, z: -0.05, yaw: -Math.PI / 2 },
  { x: -2.05, z: 1.45, yaw: Math.PI / 2 },
];
// 寝かせた薬莢の軸の高さ [m]。焼いたモデルの底の縁の半径。
const CASING_AXIS_HEIGHT = 0.231;

// 観察の中心と、既定のカメラの方位・仰角 [deg]・距離 [m]。荷室を右手前の上から覗き込む。
const VIEW_TARGET = new THREE.Vector3(-1, 0.8, 0.5);
const CAMERA_AZIMUTH_DEG = 15;
const CAMERA_ELEVATION_DEG = 50;
const CAMERA_DISTANCE = 11.6;

// 地球の置き方: 描画原点の高度を低軌道の 420 km にし、荷室の真上に置く — 開口から天体照が差し込む。直下点は
// 地表の色が読める陸(サハラ、北緯 23°・東経 13°)。
const BAY_EARTH: Pick<LabViewAngles, EarthAngleKey> = {
  earthAzimuthDeg: 0,
  earthElevationDeg: 90,
  earthAltitudeLog: Math.log10(420e3),
  earthLatitudeDeg: 23,
  earthLongitudeDeg: 13,
};
// 恒星を床の真下に置く向き。見えている面はどれも直射を受けない。
const SUN_BELOW: Partial<LabViewAngles> = { sunAzimuthDeg: 0, sunElevationDeg: -90 };
// 天体照の遮られ方を読む撮影の、地球の仰角と方位 [deg]。方位は開いた +X の側と、−X・−Z の内隅の側。
const LOW_EARTH_ELEVATION_DEG = 35;
const OPEN_SIDE_AZIMUTH_DEG = 90;
const CORNER_SIDE_AZIMUTH_DEG = -135;
// 同じ撮影の、大きい地球と小さい地球の視半径 [deg]と、そのとき床が読める明るさになる恒星までの距離
// [log10 天文単位]。
const LARGE_EARTH_RADIUS_DEG = 30;
const LARGE_EARTH_SUN_DISTANCE_LOG_AU = -0.16;
const SMALL_EARTH_RADIUS_DEG = 3;
const SMALL_EARTH_SUN_DISTANCE_LOG_AU = -1.14;
const TINY_EARTH_RADIUS_DEG = 1;
const TINY_EARTH_SUN_DISTANCE_LOG_AU = SMALL_EARTH_SUN_DISTANCE_LOG_AU
  + Math.log10(Math.sin(THREE.MathUtils.degToRad(TINY_EARTH_RADIUS_DEG))
    / Math.sin(THREE.MathUtils.degToRad(SMALL_EARTH_RADIUS_DEG)));

// 観察の中心から方位 azimuthDeg・仰角 elevationDeg [deg]、距離 distance [m] に置くカメラの、観察の向きの差分。
function cameraAt(azimuthDeg: number, elevationDeg: number, distance: number): Partial<LabViewAngles> {
  return {
    cameraAzimuthDeg: azimuthDeg,
    cameraElevationDeg: elevationDeg,
    cameraDistanceLog: Math.log10(distance / CAMERA_DISTANCE),
  };
}

// 天体照の遮られ方を読む撮影の観察の向き。恒星は床の真下の距離 sunDistanceLogAu [log10 天文単位]、地球は
// 描画原点から方位 azimuthDeg・仰角 LOW_EARTH_ELEVATION_DEG の向きへ、視半径 radiusDeg [deg] で見える高度に
// 置く。**恒星を近づけるのは天体照を読める明るさにするため** — 床の真下の恒星は読みどころへ直射を与えず、
// 露出の順応は 1 天文単位の内側で頭打ちなので、近づけたぶんは天体照だけを明るくする。
function earthLightView(azimuthDeg: number, radiusDeg: number, sunDistanceLogAu: number): Partial<LabViewAngles> {
  const altitude = R_EARTH / Math.sin(THREE.MathUtils.degToRad(radiusDeg)) - R_EARTH;
  return {
    ...SUN_BELOW,
    sunDistanceLogAu,
    earthAzimuthDeg: azimuthDeg,
    earthElevationDeg: LOW_EARTH_ELEVATION_DEG,
    earthAltitudeLog: Math.log10(altitude),
  };
}

// 同じ撮影の描画設定。天体照だけを一様球で当て、床が拡散照度のデバッグ表示で線形 0.3〜0.6 に写る露出補正
// exposureCompensation にする。レンズ効果は、暗い壁のそばの P_in を 1% 以上動かすので切る。
function planetLightOnly(
  exposureCompensation: GraphicsSettingsData['exposureCompensation'],
): Partial<GraphicsSettingsData> {
  return { ambient: false, planetLightModel: 0, exposureCompensation, lens: false };
}

// 線形 RGB color の標準マテリアル。
function standard(color: THREE.Vector3, roughness: number, metalness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(color.x, color.y, color.z, THREE.LinearSRGBColorSpace),
    roughness,
    metalness,
  });
}

// 白い面のマテリアル。
function white(): THREE.MeshStandardMaterial {
  return standard(new THREE.Vector3(WHITE, WHITE, WHITE), WHITE_ROUGHNESS, 0);
}

// 描画座標の min から max までを占める箱。ジオメトリとマテリアルは箱が所有する。
function slab(
  min: THREE.Vector3, max: THREE.Vector3, material: THREE.Material | THREE.Material[] = white(),
): THREE.Mesh {
  const size = new THREE.Vector3().subVectors(max, min);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
  mesh.position.addVectors(min, max).multiplyScalar(0.5);
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  return mesh;
}

// 寸法 size の箱を、底面の中心が描画座標の base に来るよう置く。
function boxOnFloor(size: THREE.Vector3, base: THREE.Vector3, material?: THREE.Material): THREE.Mesh {
  const half = new THREE.Vector3(size.x / 2, 0, size.z / 2);
  return slab(base.clone().sub(half), base.clone().add(half).setY(base.y + size.y), material);
}

// 床と、奥の壁・両端の壁。+X の端の壁は内面(−X を向く面)だけを橙にする。
function shell(): THREE.Mesh[] {
  const w = BAY_HALF_WIDTH;
  const t = WALL_THICKNESS;
  const h = WALL_HEIGHT;
  const floor = slab(
    new THREE.Vector3(-FLOOR_SIZE.x / 2, -FLOOR_SIZE.y, BAY_FRONT_Z - FLOOR_SIZE.z),
    new THREE.Vector3(FLOOR_SIZE.x / 2, 0, BAY_FRONT_Z),
  );
  const back = slab(new THREE.Vector3(-w - t, 0, BAY_BACK_Z - t), new THREE.Vector3(w + t, h, BAY_BACK_Z));
  const minusX = slab(new THREE.Vector3(-w - t, 0, BAY_BACK_Z), new THREE.Vector3(-w, h, BAY_FRONT_Z));
  // BoxGeometry の面の群は +X・−X・+Y・−Y・+Z・−Z の順。
  const plusXFaces = [white(), standard(ORANGE, WHITE_ROUGHNESS, 0), white(), white(), white(), white()];
  const plusX = slab(new THREE.Vector3(w, 0, BAY_BACK_Z), new THREE.Vector3(w + t, h, BAY_FRONT_Z), plusXFaces);
  return [floor, back, minusX, plusX];
}

// 光る箱。ベース色は黒で、自己発光だけで光る。
function glowBox(): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial({
    color: 0x000000,
    roughness: WHITE_ROUGHNESS,
    metalness: 0,
    emissive: new THREE.Color().setRGB(GLOW_COLOR.x, GLOW_COLOR.y, GLOW_COLOR.z, THREE.LinearSRGBColorSpace),
    emissiveIntensity: GLOW_RADIANCE,
  });
  return boxOnFloor(GLOW_SIZE, GLOW_BASE, material);
}

// トラス。軸ごとに、その軸に沿って格子を貫く梁を、残り 2 軸の節の数だけ並べる。ジオメトリは軸ごとの先頭の
// 梁が、マテリアルは最初の梁が所有する。
function truss(): THREE.Mesh[] {
  const material = white();
  const beams: THREE.Mesh[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const cells = TRUSS_CELLS.getComponent(axis);
    const size = new THREE.Vector3().setScalar(TRUSS_BEAM).setComponent(axis, cells + TRUSS_BEAM);
    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    for (let i = 0; i <= TRUSS_CELLS.getComponent(u); i++) {
      for (let j = 0; j <= TRUSS_CELLS.getComponent(v); j++) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(TRUSS_CORNER).addScalar(TRUSS_BEAM / 2);
        mesh.position.setComponent(axis, mesh.position.getComponent(axis) + cells / 2);
        mesh.position.setComponent(u, mesh.position.getComponent(u) + i);
        mesh.position.setComponent(v, mesh.position.getComponent(v) + j);
        mesh.userData.ownsGeometry = i === 0 && j === 0;
        mesh.userData.ownsMaterial = beams.length === 0;
        beams.push(mesh);
      }
    }
  }
  return beams;
}

// 金属の板。床に立てる。
function plates(): THREE.Mesh[] {
  return PLATES.map(({ z, roughness }) => boxOnFloor(
    new THREE.Vector3(PLATE_THICKNESS, PLATE_SIZE, PLATE_SIZE), new THREE.Vector3(PLATE_X, 0, z),
    standard(new THREE.Vector3(WHITE, WHITE, WHITE), roughness, 1),
  ));
}

// 荷室の構造(床・壁・立方体・光る箱・トラス・金属の板)を 1 つの枝にまとめる — 影パスの枠が荷室全体で 1 つになる。
function structure(): THREE.Object3D {
  const group = new THREE.Group();
  group.add(
    ...shell(),
    boxOnFloor(new THREE.Vector3().setScalar(CUBE_SIZE), new THREE.Vector3(0, 0, 0)),
    glowBox(),
    ...truss(),
    ...plates(),
  );
  markLitOpaque(group);
  markShadowCaster(group);
  return group;
}

// 実機の薬莢のプールへ、床に寝かせた薬莢を積んで返す。ジオメトリとマテリアルは全薬莢の共有物なので、ケースは
// 所有しない。**荷室とは別の枝にする** — 個体が散らばる枝は影の窓を持たないので、荷室へ混ぜると荷室が窓を失う。
function casings(): THREE.Object3D {
  const host = new THREE.Scene();
  const pool = new CasingPool(host, CASINGS.length);
  const piece = new THREE.Object3D();
  pool.beginFrame();
  for (const { x, z, yaw } of CASINGS) {
    piece.position.set(x, CASING_AXIS_HEIGHT, z);
    // 焼いたモデルの軸はローカルの +Y なので、Z まわりに倒して寝かせてから方位を回す。
    piece.rotation.set(0, yaw, Math.PI / 2);
    pool.push(piece);
  }
  pool.endFrame();
  const mesh = host.children[0]!;
  host.remove(mesh);
  return mesh;
}

// 荷室。読みどころは既定の構図の 960×540 の PNG の画素 (x, y) で、読む撮影では他の部品の影と映り込みが
// 掛からない。
// - P_in (412, 179): −X の内隅に近い床(奥の壁と −X の端の壁から 0.4 m)。bay-earthshine と、天体照の
//   遮られ方の撮影(bay-earth-* / bay-moon-*)で読む。
// - P_out = P_open (186, 183): 荷室の外の床。どの壁・部品からも 4 m より遠い。bay-earthshine・bay と、
//   天体照の遮られ方の撮影で読む。
// - P_base (507, 189): 奥の壁の足元の床(壁から 0.15 m、両端の壁から 2.8 m 以上)。bay と bay-bounce で読む。
// - P_corner (404, 169): 奥の壁と −X の端の壁が床と交わる内隅(両方の壁から 3 画素)。bay で読む。
// - P_bleed (704, 386): 日の当たる橙の壁から 0.4 m の白い床。トラスの影から外れる。bay で読む。
// - P_glow (547, 225): 光る箱の画面に写っている面(+Z)の中央の手前 0.13 m の床。5×5 の窓がまるごと、箱と立方体の
//   あいだに見える床に収まる(面から 0.2 m より先は立方体に隠れる)。bay-dark で読む。
// 天体照の遮られ方の撮影の P_in / P_out は、拡散照度のデバッグ表示で線形の比として読む — 最終の絵には
// 視線ごとに違う床の鏡面が混じり、遮りの無い床どうしでも比が 1 からずれる。遮りと照り返しを標本の数も
// 画面の制約も無しに解いた比は、遮蔽で 0.32(overhead)/ 0.64(earth-open)/ 0.00(earth-corner)/
// 1.00(moon-open)/ 0.00(moon-corner)、遮蔽と照り返しで 0.49 / 1.06 / 0.00 / 1.38 / 0.00(オフは 1.00)。
// bay の P_base と P_corner は −X の端の壁の影に入るので、bay では遮蔽のデバッグ表示でだけ読む。
// bay-bounce では恒星が +Z にあり、どの部品も真後ろの奥の壁へ影を落とす — 板を +X へ向け、薬莢を奥行きに
// 沿って寝かせて、P_base の足元の壁(x = −1.8〜−0.6 m)を空けてある。
function bay(): LabCase {
  const camera = labCamera();
  camera.position.copy(VIEW_TARGET).addScaledVector(
    directionFromAngles(CAMERA_AZIMUTH_DEG, CAMERA_ELEVATION_DEG, new THREE.Vector3()), CAMERA_DISTANCE,
  );
  camera.lookAt(VIEW_TARGET);
  camera.updateMatrixWorld();
  return {
    objects: [structure(), casings()],
    camera,
    viewTarget: VIEW_TARGET,
    sunDirection: OBLIQUE_SUN_DIR,
    earth: BAY_EARTH,
    shots: {
      // 全景。恒星は斜光、地球は真上。
      'bay': { view: {} },
      // 地球照だけ。**内側の床 P_in と外側の床 P_out は同じ材質・同じ向き**で、違いは周りの構造だけ。
      'bay-earthshine': { view: SUN_BELOW },
      // 天体照の遮られ方。地球を真上の低軌道(視半径 70°)と、仰角 35° の開いた +X の側・−X・−Z の内隅の側へ
      // 視半径 30° と 3° で置き、同じ床の P_in と P_out がどれだけ違うかを読む。
      'bay-earth-overhead': { view: SUN_BELOW, graphics: planetLightOnly(1) },
      'bay-earth-open': {
        view: earthLightView(OPEN_SIDE_AZIMUTH_DEG, LARGE_EARTH_RADIUS_DEG, LARGE_EARTH_SUN_DISTANCE_LOG_AU),
        graphics: planetLightOnly(4),
      },
      'bay-earth-open-diffuse': {
        view: earthLightView(OPEN_SIDE_AZIMUTH_DEG, LARGE_EARTH_RADIUS_DEG, LARGE_EARTH_SUN_DISTANCE_LOG_AU),
        graphics: planetLightOnly(4), debugTarget: 'diffuse',
      },
      'bay-earth-open-correction': {
        view: earthLightView(OPEN_SIDE_AZIMUTH_DEG, LARGE_EARTH_RADIUS_DEG, LARGE_EARTH_SUN_DISTANCE_LOG_AU),
        graphics: { ...planetLightOnly(4), screenSpaceDiffuse: 1 }, debugTarget: 'correction',
      },
      'bay-earth-corner': {
        view: earthLightView(CORNER_SIDE_AZIMUTH_DEG, LARGE_EARTH_RADIUS_DEG, LARGE_EARTH_SUN_DISTANCE_LOG_AU),
        graphics: planetLightOnly(4),
      },
      'bay-earth-corner-diffuse': {
        view: earthLightView(CORNER_SIDE_AZIMUTH_DEG, LARGE_EARTH_RADIUS_DEG, LARGE_EARTH_SUN_DISTANCE_LOG_AU),
        graphics: planetLightOnly(4), debugTarget: 'diffuse',
      },
      'bay-earth-corner-correction': {
        view: earthLightView(CORNER_SIDE_AZIMUTH_DEG, LARGE_EARTH_RADIUS_DEG, LARGE_EARTH_SUN_DISTANCE_LOG_AU),
        graphics: { ...planetLightOnly(4), screenSpaceDiffuse: 1 }, debugTarget: 'correction',
      },
      'bay-moon-open': {
        view: earthLightView(OPEN_SIDE_AZIMUTH_DEG, SMALL_EARTH_RADIUS_DEG, SMALL_EARTH_SUN_DISTANCE_LOG_AU),
        graphics: planetLightOnly(4),
      },
      'bay-moon-corner': {
        view: earthLightView(CORNER_SIDE_AZIMUTH_DEG, SMALL_EARTH_RADIUS_DEG, SMALL_EARTH_SUN_DISTANCE_LOG_AU),
        graphics: planetLightOnly(4),
      },
      'bay-earth-radius-1deg': {
        view: earthLightView(OPEN_SIDE_AZIMUTH_DEG, TINY_EARTH_RADIUS_DEG, TINY_EARTH_SUN_DISTANCE_LOG_AU),
        graphics: planetLightOnly(4), debugTarget: 'diffuse',
      },
      'bay-earth-radius-3deg': {
        view: earthLightView(OPEN_SIDE_AZIMUTH_DEG, SMALL_EARTH_RADIUS_DEG, SMALL_EARTH_SUN_DISTANCE_LOG_AU),
        graphics: planetLightOnly(4), debugTarget: 'diffuse',
      },
      'bay-earth-radius-30deg': {
        view: earthLightView(OPEN_SIDE_AZIMUTH_DEG, LARGE_EARTH_RADIUS_DEG, LARGE_EARTH_SUN_DISTANCE_LOG_AU),
        graphics: planetLightOnly(4), debugTarget: 'diffuse',
      },
      // 照り返しの較正。恒星を奥の壁の法線(+Z)に置く — 奥の壁は恒星へ正対し、床と端の壁は直射を掠める
      // だけ。天体照と環境光を切り、地球を遠ざけるので、壁の足元の床 P_base へ届くのは照り返しだけになる。
      'bay-bounce': {
        view: { sunAzimuthDeg: 0, sunElevationDeg: 0, ...EARTH_AWAY },
        graphics: { planetLightCount: 0, ambient: false },
      },
      // 自己発光の照り返し。恒星を床の真下に置き、天体照を切る。光る箱のそばの床 P_glow と遠くの床を比べる。
      'bay-dark': { view: { ...SUN_BELOW, ...EARTH_AWAY }, graphics: { planetLightCount: 0 } },
      'bay-bounce-source': {
        view: { ...SUN_BELOW, ...EARTH_AWAY }, graphics: { planetLightCount: 0 }, debugTarget: 'bounce-source',
      },
      'bay-correction': { view: {}, debugTarget: 'correction' },
      'bay-quality-low': { view: {}, graphics: { screenSpaceQuality: 0 }, debugTarget: 'diffuse' },
      'bay-quality-medium': { view: {}, graphics: { screenSpaceQuality: 1 }, debugTarget: 'diffuse' },
      'bay-quality-high': { view: {}, graphics: { screenSpaceQuality: 2 }, debugTarget: 'diffuse' },
      // 低設定は半解像度。距離約 1 km で半解像度の 4 m 半径が 1〜2 px に投影される。
      'bay-radius-1px': {
        view: cameraAt(CAMERA_AZIMUTH_DEG, CAMERA_ELEVATION_DEG, 1100),
        graphics: { screenSpaceQuality: 0 }, debugTarget: 'diffuse',
      },
      'bay-radius-2px': {
        view: cameraAt(CAMERA_AZIMUTH_DEG, CAMERA_ELEVATION_DEG, 650),
        graphics: { screenSpaceQuality: 0 }, debugTarget: 'diffuse',
      },
      // 細い梁のまわりの暈。後ろからトラスへ寄せて見下ろし、地球を真下へ移す — 奥の壁の上に出た段が、
      // 開口の先の地球の円盤と、その手前の床を背にする。
      'bay-truss': { view: { ...cameraAt(155, 28, 7.5), earthElevationDeg: -90 } },
      // 画面の縁。右手前から寄せ、画面の左端で −X の端の壁と床を切る。
      'bay-edge': { view: cameraAt(35, 40, 6) },
      // 映り込み。右手前から金属の板へ寄せる。地球を +X の地平の下へ移す — 手前の板(粗さ 0.05)が立方体と
      // 薬莢を映すはずの向きに、天体照の像が入る。
      'bay-metal': { view: { ...cameraAt(30, 20, 6.5), earthAzimuthDeg: 130, earthElevationDeg: -12 } },
      'bay-metal-specular': {
        view: { ...cameraAt(30, 20, 6.5), earthAzimuthDeg: 130, earthElevationDeg: -12 },
        debugTarget: 'specular',
      },
    },
  };
}

export const BAY_CASES = {
  'bay': bay,
} as const satisfies Record<string, CaseBuilder>;
