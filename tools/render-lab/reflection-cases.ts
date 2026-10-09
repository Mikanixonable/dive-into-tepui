// 映り込みのぼけ方のケース。粗さを段に振った金属の帯を床に並べ、帯ごとに同じ発光球を1つずつ映し、地球の鏡面像も
// 同じ床に映す。同じ粗さの面で、近くの物体の像と遠方の光の像が同じ規則でぼけるかを、帯を横に並べて読む試験体。
// 対照のケースは発光球の代わりに同じ場所・大きさ・放射輝度の球光源を置き、ライティングパスが積分した鏡面像を映す。
// チェッカーのケースは発光球の代わりに 2×2 のマスの発光板を立て、当たった画素どうしの境のぼけと、縦と横のぼけ方の
// 違いを映す — 一様な発光球の像は、当たり / 外れの境のぼけしか持たない。
// 帯ごとの像の縁の幅と明るさは tools/render-lab-reflection-levels.mjs が撮影から表にする。
import * as THREE from 'three/webgpu';
import { R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import { markLitOpaque, markShadowCaster } from '../../src/render/pipeline/lit-layer';
import { directionFromAngles, type EarthAngleKey, type LabViewAngles } from './view-angles';
import { labCamera, type CaseBuilder, type LabCase } from './lab-case';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';
import type { SphereLightValue } from '../../src/render/pipeline/lighting/sphere-lights';

// 帯の粗さ。帯 k は左から k 番目。鏡に近い側を細かく刻み、0.6 で映り込みが消えるところまでを置く。いちばん
// 滑らかな帯は、three の標準マテリアルが下から切る粗さ 0.0525 の面として G バッファに載る。
const ROUGHNESSES = [0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6] as const;
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

// 発光球の中心の高さと半径 [m]。中心は帯の奥の端の真上。像の幅が帯の幅の 1/3 ほどで、帯の中で横へぼける余地を残す。
const SPHERE_HEIGHT = 2;
const SPHERE_RADIUS = 0.4;
// 発光球とチェッカーの発光するマスの放射輝度。「1 天文単位で恒星に正対したアルベド 1 の面 = 1」の目盛り。像が
// トーンマッピングの圧縮に掛からない明るさ。
const EMITTER_RADIANCE = 0.5;
// 発光球とチェッカーのマスの粗さ。帯のどの粗さとも離し、粗さのデバッグ表示で帯と見分ける。
const EMITTER_ROUGHNESS = 1;

// チェッカーの発光板の幅と高さ [m]。幅は帯の奥の端での帯の幅の弦で、板の鏡像が帯の幅いっぱいに映る — 広げると隣の
// 帯の像と重なる。高さは床から測り、上下のマスの境の縦のぼけが、粗さ 0.2 の帯までマスの像に収まる大きさ。
const PLATE_WIDTH = 2 * BAND_OUTER_RADIUS * Math.tan(THREE.MathUtils.degToRad(BAND_WIDTH_DEG / 2));
const PLATE_HEIGHT = 6;

// 地球の置き方: 真上に、縁がどの方位でも仰角 EARTH_EDGE_ELEVATION_DEG に来る大きさで置く — 縁の鏡像が全帯で同じ
// 俯角の床に落ち、発光球の像(俯角 8〜11°)より手前に来る。恒星は床の真下なので、見えている側は満ちている。
const EARTH_EDGE_ELEVATION_DEG = 20;
const EARTH_RADIUS_DEG = 90 - EARTH_EDGE_ELEVATION_DEG;
const LADDER_EARTH: Pick<LabViewAngles, EarthAngleKey> = {
  earthAzimuthDeg: 0,
  earthElevationDeg: 90,
  earthAltitudeLog: Math.log10(R_EARTH / Math.sin(THREE.MathUtils.degToRad(EARTH_RADIUS_DEG)) - R_EARTH),
  earthLatitudeDeg: 23,
  earthLongitudeDeg: 13,
};

// 恒星の向き。床の真下に置き、見えている面へ直射を当てない — 帯に映る遠方の光は地球の天体照だけ。
const SUN_BELOW = new THREE.Vector3(0, -1, 0);

// どの撮影にも重ねる描画設定。環境光の鏡面は粗さによらない一様な放射輝度でぼけを持たず、帯どうしの差を埋めるので
// 切る。レンズ効果は縁の明るさの立ち上がりを、アンチエイリアスは孤立した 1 画素の明るさをにじませるので切る。
const LADDER_GRAPHICS: Partial<GraphicsSettingsData> = {
  ambient: false, lens: false, antialias: 0, screenSpaceSpecular: true,
};
// 天体照を切った撮影の描画設定。地球の像に埋もれる球の像を見る。
const NO_PLANET_GRAPHICS: Partial<GraphicsSettingsData> = { ...LADDER_GRAPHICS, planetLightCount: 0 };

// 帯 index の中心線の方位角 [deg]。帯は画面の左から右へ並ぶ。
function bandAzimuthDeg(index: number): number {
  return 180 - (index - (ROUGHNESSES.length - 1) / 2) * BAND_SPACING_DEG;
}

// 帯 index の中心線の奥の端の、床の上の点(描画座標)。
function bandEnd(index: number): THREE.Vector3 {
  return directionFromAngles(bandAzimuthDeg(index), 0, new THREE.Vector3()).multiplyScalar(BAND_OUTER_RADIUS);
}

// 帯 index の奥の端の上の、発光球(と対照の球光源)の中心(描画座標)。
function sphereCenter(index: number): THREE.Vector3 {
  const center = bandEnd(index);
  center.y = SPHERE_HEIGHT;
  return center;
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

// 発光球とチェッカーの発光するマスのマテリアル。ベース色は黒で、自己発光だけで光る。
function emitterMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x000000,
    roughness: EMITTER_ROUGHNESS,
    metalness: 0,
    emissive: 0xffffff,
    emissiveIntensity: EMITTER_RADIANCE,
  });
}

// 帯 index の奥の端の上の発光球。ジオメトリとマテリアルは全球の共有物で、最初の球が所有する。
function emitter(index: number, geometry: THREE.SphereGeometry, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(sphereCenter(index));
  mesh.userData.ownsGeometry = index === 0;
  mesh.userData.ownsMaterial = index === 0;
  return mesh;
}

// 帯ごとの発光球。
function emitters(): THREE.Mesh[] {
  const geometry = new THREE.SphereGeometry(SPHERE_RADIUS, 64, 32);
  const material = emitterMaterial();
  return ROUGHNESSES.map((_, index) => emitter(index, geometry, material));
}

// 帯 index の奥の端に、帯の中心線に垂直に立ててカメラ側へ向けたチェッカーの発光板。2×2 のマスのうち、カメラから
// 見て左下と右上が glowing、残りが dark。ジオメトリ cell とマテリアルは全板の共有物で、最初の板の、それを使う
// 最初のマスが所有する。
function checkerPlate(
  index: number, cell: THREE.PlaneGeometry, glowing: THREE.Material, dark: THREE.Material,
): THREE.Object3D {
  const plate = new THREE.Group();
  plate.position.copy(bandEnd(index));
  // マスの面は +Z を向き、右が +X。Y 軸まわりに方位角 + 180° 回すと、面が原点(カメラの真下)を向く。
  plate.rotation.y = THREE.MathUtils.degToRad(bandAzimuthDeg(index) + 180);
  for (const column of [0, 1]) {
    for (const row of [0, 1]) {
      const mesh = new THREE.Mesh(cell, column === row ? glowing : dark);
      mesh.position.set((column - 0.5) * PLATE_WIDTH / 2, (row + 0.5) * PLATE_HEIGHT / 2, 0);
      mesh.userData.ownsGeometry = index === 0 && column === 0 && row === 0;
      mesh.userData.ownsMaterial = index === 0 && row === 0;
      plate.add(mesh);
    }
  }
  return plate;
}

// 帯ごとのチェッカーの発光板。
function checkerPlates(): THREE.Object3D[] {
  const cell = new THREE.PlaneGeometry(PLATE_WIDTH / 2, PLATE_HEIGHT / 2);
  const glowing = emitterMaterial();
  const dark = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: EMITTER_ROUGHNESS, metalness: 0 });
  return ROUGHNESSES.map((_, index) => checkerPlate(index, cell, glowing, dark));
}

// 帯と、帯の奥の端に置く物体 targets を 1 つの枝にまとめる — 影パスの枠がケース全体で 1 つになる。
function structure(targets: readonly THREE.Object3D[]): THREE.Object3D {
  const group = new THREE.Group();
  group.add(...ROUGHNESSES.map((_, index) => band(index)), ...targets);
  markLitOpaque(group);
  markShadowCaster(group);
  return group;
}

// カメラと、周回の中心。
function ladderCamera(): { readonly camera: THREE.PerspectiveCamera; readonly viewTarget: THREE.Vector3 } {
  const camera = labCamera();
  camera.position.set(0, CAMERA_HEIGHT, 0);
  const forward = directionFromAngles(180, -CAMERA_PITCH_DEG, new THREE.Vector3());
  const viewTarget = camera.position.clone().addScaledVector(forward, VIEW_DISTANCE);
  camera.lookAt(viewTarget);
  camera.updateMatrixWorld();
  return { camera, viewTarget };
}

// 粗さの段の床と発光球。
function reflectionLadder(): LabCase {
  const off = { ...LADDER_GRAPHICS, screenSpaceSpecular: false };
  return {
    objects: [structure(emitters())],
    ...ladderCamera(),
    sunDirection: SUN_BELOW,
    earth: LADDER_EARTH,
    shots: {
      'ladder': { view: {}, graphics: LADDER_GRAPHICS },
      'ladder-no-planet': { view: {}, graphics: NO_PLANET_GRAPHICS },
      'ladder-off': { view: {}, graphics: off },
      // 地球の像の縁は、トーンマッピングだけを通した遠方の鏡面照度(天体照と環境光)で測る。
      'ladder-off-specular': { view: {}, graphics: off, debugTarget: 'far-specular' },
      'ladder-roughness': { view: {}, graphics: LADDER_GRAPHICS, debugTarget: 'roughness' },
      'ladder-weight': { view: {}, graphics: LADDER_GRAPHICS, debugTarget: 'reflection-weight' },
      'ladder-distance': { view: {}, graphics: LADDER_GRAPHICS, debugTarget: 'reflection-distance' },
      'ladder-reflection': { view: {}, graphics: LADDER_GRAPHICS, debugTarget: 'reflection' },
    },
  };
}

// 対照: 同じ床と地球に、発光球の代わりに同じ場所・大きさ・放射輝度の球光源を置く。縁の幅は天体照を切った直接の
// 鏡面照度で測る — 球光源の像の手前に地球の像の縁が来ると、粗い帯で縁の幅を読めない。
function reflectionLadderLights(): LabCase {
  // 球光源は発光球と同じ中心・半径・放射輝度。
  const radiance = new THREE.Color(EMITTER_RADIANCE, EMITTER_RADIANCE, EMITTER_RADIANCE);
  const sphereLights: SphereLightValue[] = ROUGHNESSES.map((_, index) => ({
    center: sphereCenter(index), radius: SPHERE_RADIUS, radiance,
  }));
  return {
    objects: [structure([])],
    ...ladderCamera(),
    sunDirection: SUN_BELOW,
    earth: LADDER_EARTH,
    sphereLights,
    shots: {
      'ladder-lights': { view: {}, graphics: LADDER_GRAPHICS },
      'ladder-lights-no-planet': { view: {}, graphics: NO_PLANET_GRAPHICS },
      'ladder-lights-no-planet-specular': { view: {}, graphics: NO_PLANET_GRAPHICS, debugTarget: 'direct-specular' },
    },
  };
}

// 同じ床と地球に、発光球の代わりにチェッカーの発光板を立てる。どの撮影も天体照を切る — 天体照は黒いマスにも誘電体の
// 鏡面の照り返しを乗せ、黒いマスの像が 0 にならない。
function reflectionLadderChecker(): LabCase {
  return {
    objects: [structure(checkerPlates())],
    ...ladderCamera(),
    sunDirection: SUN_BELOW,
    earth: LADDER_EARTH,
    shots: {
      'ladder-checker-no-planet': { view: {}, graphics: NO_PLANET_GRAPHICS },
      // 境の縁の幅は、R を掛ける前の映り込みの像で測る。
      'ladder-checker-reflection': { view: {}, graphics: NO_PLANET_GRAPHICS, debugTarget: 'reflection' },
    },
  };
}

export const REFLECTION_CASES = {
  'reflection-ladder': reflectionLadder,
  'reflection-ladder-lights': reflectionLadderLights,
  'reflection-ladder-checker': reflectionLadderChecker,
} as const satisfies Record<string, CaseBuilder>;
