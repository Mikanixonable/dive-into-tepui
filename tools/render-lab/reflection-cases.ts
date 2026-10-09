// 映り込みのぼけ方のケース。粗さを段に振った金属の帯を床に並べ、帯ごとに同じ発光球を1つずつ映し、恒星と地球の
// 鏡面像も同じ床に映す。同じ粗さの面で、近くの物体の像と遠方の光の像が同じ規則でぼけるかを、帯を横に並べて読む
// 試験体。帯ごとの像の縁の幅と縮小段の内訳は tools/render-lab-reflection-levels.mjs が撮影から表にする。
import * as THREE from 'three/webgpu';
import { R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import { markLitOpaque, markShadowCaster } from '../../src/render/pipeline/lit-layer';
import { directionFromAngles, type EarthAngleKey, type LabViewAngles } from './view-angles';
import { labCamera, type CaseBuilder, type LabCase, type LabShot } from './lab-case';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';

// 帯の粗さ。帯 k は左から k 番目。
const ROUGHNESSES = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;
// 帯の金属の線形の灰色の値(金属度 1 なので鏡面反射率そのもの)。
const METAL_REFLECTANCE = 0.9;

// 床の上面は y = 0 で、カメラはその真上の高さ CAMERA_HEIGHT [m] から −Z の向きを CAMERA_PITCH_DEG [deg] 見下ろす。
const CAMERA_HEIGHT = 2;
const CAMERA_PITCH_DEG = 10;
// カメラの周回の中心までの距離 [m]。
const VIEW_DISTANCE = 8;

// 帯は、カメラの真下の点から水平に放射状へ延ばした扇形。**全帯がカメラの真下を通る鉛直軸まわりに回しただけの
// 配置** — 反射点・当たり距離・カメラから反射点までの距離が全帯で揃い、縁の幅の予測が粗さだけで決まる。
// 帯の内外の半径 [m] と、隣り合う帯の中心線の間の方位角と帯の幅の方位角 [deg]。両端の帯が画面の縁の映り込みの
// フェードに掛からない範囲に収める。
const BAND_INNER_RADIUS = 2.4;
const BAND_OUTER_RADIUS = 24;
const BAND_SPACING_DEG = 6.6;
const BAND_WIDTH_DEG = 5.6;

// 発光球の中心の高さと半径 [m]。中心は帯の奥の端の真上。
const SPHERE_HEIGHT = 2;
const SPHERE_RADIUS = 1;
// 発光球の放射輝度。「1 天文単位で恒星に正対したアルベド 1 の面 = 1」の目盛り。像がトーンマッピングの圧縮に
// 掛からない明るさ。
const SPHERE_RADIANCE = 0.5;
// 発光球の粗さ。帯のどの粗さとも離し、粗さのデバッグ表示で帯と見分ける。
const SPHERE_ROUGHNESS = 1;

// 地球の置き方: 真上に、縁がどの方位でも仰角 EARTH_EDGE_ELEVATION_DEG に来る大きさで置く — 縁の鏡像が全帯で同じ
// 俯角の床に落ち、発光球の像(俯角 7〜12°)より手前に来る。恒星は床の真下なので、見えている側は満ちている。
const EARTH_EDGE_ELEVATION_DEG = 20;
const EARTH_RADIUS_DEG = 90 - EARTH_EDGE_ELEVATION_DEG;
const LADDER_EARTH: Pick<LabViewAngles, EarthAngleKey> = {
  earthAzimuthDeg: 0,
  earthElevationDeg: 90,
  earthAltitudeLog: Math.log10(R_EARTH / Math.sin(THREE.MathUtils.degToRad(EARTH_RADIUS_DEG)) - R_EARTH),
  earthLatitudeDeg: 23,
  earthLongitudeDeg: 13,
};

// 恒星の鏡像を帯へ落とす撮影の恒星の仰角 [deg]。鏡像は俯角が同じ床、発光球の像と地球の像のあいだに落ちる。
const SUN_ELEVATION_DEG = 14;
// 同じ撮影の露出補正。恒星の鏡面が粗い帯を一面に白く飛ばさない明るさ。
const SUN_EXPOSURE_COMPENSATION = 0.25;

// どの撮影にも重ねる描画設定。環境光の鏡面は粗さによらない一様な放射輝度でぼけを持たず、帯どうしの差を埋めるので
// 切る。レンズ効果は縁の明るさの立ち上がりをにじませるので切る。
const LADDER_GRAPHICS: Partial<GraphicsSettingsData> = { ambient: false, lens: false, screenSpaceSpecular: true };

// 帯 index の中心線の方位角 [deg]。帯は画面の左から右へ並ぶ。
function bandAzimuthDeg(index: number): number {
  return 180 - (index - (ROUGHNESSES.length - 1) / 2) * BAND_SPACING_DEG;
}

// 帯 index。床に寝かせた扇形の金属の板。
function band(index: number): THREE.Mesh {
  // RingGeometry の扇形は XY 平面で +X から反時計回りに測り、X 軸まわりに −90° 倒すと角 θ が方位角 θ + 90° になる。
  const startDeg = bandAzimuthDeg(index) - 90 - BAND_WIDTH_DEG / 2;
  const geometry = new THREE.RingGeometry(
    BAND_INNER_RADIUS, BAND_OUTER_RADIUS, 16, 32,
    THREE.MathUtils.degToRad(startDeg), THREE.MathUtils.degToRad(BAND_WIDTH_DEG),
  );
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(METAL_REFLECTANCE, METAL_REFLECTANCE, METAL_REFLECTANCE, THREE.LinearSRGBColorSpace),
    roughness: ROUGHNESSES[index]!,
    metalness: 1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  return mesh;
}

// 帯 index の奥の端の上の発光球。ベース色は黒で、自己発光だけで光る。ジオメトリとマテリアルは全球の共有物で、
// 最初の球が所有する。
function emitter(index: number, geometry: THREE.SphereGeometry, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  directionFromAngles(bandAzimuthDeg(index), 0, mesh.position).multiplyScalar(BAND_OUTER_RADIUS);
  mesh.position.y = SPHERE_HEIGHT;
  mesh.userData.ownsGeometry = index === 0;
  mesh.userData.ownsMaterial = index === 0;
  return mesh;
}

// 帯と発光球を 1 つの枝にまとめる — 影パスの枠がケース全体で 1 つになる。
function structure(): THREE.Object3D {
  // 発光球はどれも同じジオメトリとマテリアルを使う。
  const geometry = new THREE.SphereGeometry(SPHERE_RADIUS, 64, 32);
  const material = new THREE.MeshStandardMaterial({
    color: 0x000000,
    roughness: SPHERE_ROUGHNESS,
    metalness: 0,
    emissive: 0xffffff,
    emissiveIntensity: SPHERE_RADIANCE,
  });
  const group = new THREE.Group();
  group.add(
    ...ROUGHNESSES.map((_, index) => band(index)),
    ...ROUGHNESSES.map((_, index) => emitter(index, geometry, material)),
  );
  markLitOpaque(group);
  markShadowCaster(group);
  return group;
}

// 帯 k に恒星の鏡像を落とす撮影 ladder-sun-k。
function sunShots(): Record<string, LabShot> {
  return Object.fromEntries(ROUGHNESSES.map((_, index) => [
    `ladder-sun-${index}`,
    {
      view: { sunAzimuthDeg: bandAzimuthDeg(index), sunElevationDeg: SUN_ELEVATION_DEG },
      graphics: { ...LADDER_GRAPHICS, exposureCompensation: SUN_EXPOSURE_COMPENSATION },
    },
  ]));
}

// 粗さの段の床。恒星は既定で床の真下に置き、見えている面へ直射を当てない — 帯に映る遠方の光は地球の天体照だけ。
function reflectionLadder(): LabCase {
  const camera = labCamera();
  camera.position.set(0, CAMERA_HEIGHT, 0);
  const forward = directionFromAngles(180, -CAMERA_PITCH_DEG, new THREE.Vector3());
  const viewTarget = camera.position.clone().addScaledVector(forward, VIEW_DISTANCE);
  camera.lookAt(viewTarget);
  camera.updateMatrixWorld();
  const off = { ...LADDER_GRAPHICS, screenSpaceSpecular: false };
  return {
    objects: [structure()],
    camera,
    viewTarget,
    sunDirection: new THREE.Vector3(0, -1, 0),
    earth: LADDER_EARTH,
    shots: {
      'ladder': { view: {}, graphics: LADDER_GRAPHICS },
      'ladder-off': { view: {}, graphics: off },
      // 地球の像の縁は、トーンマッピングだけを通した鏡面照度で測る。映り込みを切り、置換で弱めない。
      'ladder-off-specular': { view: {}, graphics: off, debugTarget: 'specular' },
      // 映り込みを切ったフレームの縮小段は、何も読んでいないので一面の黒。
      'ladder-off-level': { view: {}, graphics: off, debugTarget: 'reflection-level' },
      ...sunShots(),
      'ladder-roughness': { view: {}, graphics: LADDER_GRAPHICS, debugTarget: 'roughness' },
      'ladder-weight': { view: {}, graphics: LADDER_GRAPHICS, debugTarget: 'reflection-weight' },
      'ladder-distance': { view: {}, graphics: LADDER_GRAPHICS, debugTarget: 'reflection-distance' },
      'ladder-level': { view: {}, graphics: LADDER_GRAPHICS, debugTarget: 'reflection-level' },
      'ladder-reflection': { view: {}, graphics: LADDER_GRAPHICS, debugTarget: 'reflection' },
    },
  };
}

export const REFLECTION_CASES = {
  'reflection-ladder': reflectionLadder,
} as const satisfies Record<string, CaseBuilder>;
