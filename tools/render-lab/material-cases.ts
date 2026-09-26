// 材質と較正のケース。粗さと金属度・アルベドを振った球の格子で天体照の映り込み・恒星の見え方・放射照度の
// 較正と日食を読む試験体と、温度による自照を読む試験体を組む。
import * as THREE from 'three/webgpu';

import { InstancedPool } from '../../src/render/instanced-pool';
import { markLitOpaque } from '../../src/render/pipeline/lit-layer';
import {
  attachThermalEmissive, syncThermalState, THERMAL_SHAPE_ATTRIBUTE, type ThermalSource,
} from '../../src/render/thermal-emissive';
import { sphereShadowBody } from '../../src/render/pipeline/shadow/body-shadow';
import {
  anglesFromDirection, directionFromAngles, type EarthAngleKey, type LabViewAngles,
} from './view-angles';
import { HULL_EMISS } from '../../src/game/dynamic/dynamic-motion';
import {
  detachPoolMesh, labCamera, OBLIQUE_SUN_DIR, SHIP_ROTATION_PORT, shipAt, SUN_DIR_ANGLES, sunAnglesOf,
  type CaseBuilder, type LabCase, type LabShot,
} from './lab-case';

// 水星近日点の距離(天文単位)の常用対数。太陽の視半径が 0.86° に広がる。
const MERCURY_PERIHELION_LOG_AU = Math.log10(0.31);

// 格子の列(左から)の粗さ。
const GRID_ROUGHNESS = [0.05, 0.25, 0.5, 0.75, 1];
// 格子の行(上から)の色と金属度。色は線形 RGB の灰色の値で、金属では反射率、非金属ではアルベド。
const GRID_ROWS = [
  { color: 1, metalness: 1 },
  { color: 0.05, metalness: 0 },
  { color: 0.3, metalness: 0 },
  { color: 1, metalness: 0 },
];
// 格子の球の半径と、隣りあう球の中心の間隔 [m]。
const GRID_SPHERE_RADIUS = 100;
const GRID_SPACING = 250;
// 格子の中心(描画座標)。既定の構図で格子が画面の高さの 8 割を占める奥行きで、近接の撮影で隅の球へ回り込んだ
// カメラもその球から半径の 6 倍離れる。
const GRID_CENTER = new THREE.Vector3(0, 0, -1250);

// 格子の column 列・row 行(どちらも 0 始まり)の球の中心(描画座標)。
function gridPosition(column: number, row: number): THREE.Vector3 {
  return new THREE.Vector3(
    (column - (GRID_ROUGHNESS.length - 1) / 2) * GRID_SPACING,
    ((GRID_ROWS.length - 1) / 2 - row) * GRID_SPACING,
    0,
  ).add(GRID_CENTER);
}

// 近接で写す球の中心(描画座標)。左上の金属・粗さ 0.05、右下のアルベド 1・粗さ 1、その上のアルベド 0.3・粗さ 1。
const SMOOTH_METAL = gridPosition(0, 0);
const ROUGH_WHITE = gridPosition(4, 3);
const ROUGH_GREY = gridPosition(4, 2);

// 格子の球 target(描画座標)を画面の中央へ、ズーム 10^zoomLog 倍で写す観察の向き。
function closeUpOf(
  target: THREE.Vector3, zoomLog: number,
): Pick<LabViewAngles, 'cameraAzimuthDeg' | 'cameraElevationDeg' | 'cameraZoomLog'> {
  // カメラは格子の中心を見ながらそのまわりを回るので、中心から target への向きに置くと target が視線に乗る。
  const { azimuthDeg, elevationDeg } = anglesFromDirection(target.clone().sub(GRID_CENTER));
  return { cameraAzimuthDeg: azimuthDeg, cameraElevationDeg: elevationDeg, cameraZoomLog: zoomLog };
}

// 金属・粗さ 0.05 の球の近接。10 倍に寄せると、水星近日点の太陽の円盤(視直径 1.7°)の鏡像が、球の曲率で
// 1/13.5 に縮んで幅 13 px に写る。
const SMOOTH_METAL_CLOSE_UP = closeUpOf(SMOOTH_METAL, 1);
// 粗さ 1 のアルベド 1 とアルベド 0.3 の球の近接。2 倍に寄せると、球が画面の高さの 6〜7 割を占め、日食の縞が読める。
const ROUGH_WHITE_CLOSE_UP = closeUpOf(ROUGH_WHITE, Math.log10(2));
const ROUGH_GREY_CLOSE_UP = closeUpOf(ROUGH_GREY, Math.log10(2));

// 格子の背にする地球の既定の置き方: 視線の先(−Z)で描画原点の高度を低軌道の 420 km にし、直下点を
// 地表の色が読める陸(サハラ、北緯 23°・東経 13°)にする。
const BACKDROP_EARTH_PLACEMENT: Pick<LabViewAngles, EarthAngleKey> = {
  earthAzimuthDeg: 180,
  earthElevationDeg: 0,
  earthAltitudeLog: Math.log10(420e3),
  earthLatitudeDeg: 23,
  earthLongitudeDeg: 13,
};
// 地球を遠ざける置き方: 高度 1e9 m の真下。どの撮影の画面にも入らず、恒星と格子のあいだにも入らない。
const EARTH_AWAY: Partial<LabViewAngles> = { earthElevationDeg: -90, earthAltitudeLog: 9 };

// 昼夜境界が地球の円盤を横切る位相になる恒星の向き。
const TERMINATOR_SUN = sunAnglesOf(new THREE.Vector3(1, 0.2, 0));
// 金属のハイライトの恒星の向き。方位をカメラから 25° 回す(20° 離れる)と、ハイライトは球の中心からその半分
// 画面の右へずれ、画面に収まる。
const METAL_HIGHLIGHT_SUN: Partial<LabViewAngles> = {
  sunAzimuthDeg: SMOOTH_METAL_CLOSE_UP.cameraAzimuthDeg + 25,
  sunElevationDeg: SMOOTH_METAL_CLOSE_UP.cameraElevationDeg,
  sunDistanceLogAu: MERCURY_PERIHELION_LOG_AU,
};
// 右下の球の近接の視線に直交する恒星の向き(+Z)。視線が xy 面内にあるので、+Z から差すと昼夜境界が
// 画面の縦に球の中心を通る。
const SIDE_SUN: Partial<LabViewAngles> = {
  sunAzimuthDeg: 0, sunElevationDeg: 0, sunDistanceLogAu: MERCURY_PERIHELION_LOG_AU,
};
// 太陽を画面へ入れる撮影の向き。太陽は格子の右上の外に来る。既定の地球は画面を埋めて太陽を隠すので遠ざける。
const SUN_IN_VIEW: Partial<LabViewAngles> = { ...sunAnglesOf(new THREE.Vector3(0.67, 0.29, -1)), ...EARTH_AWAY };

// 日食の撮影の恒星の向き。影の源はこの向きへ置くので、ほかの撮影の恒星の向きでは影の源の影がどの球にも
// かからない(較正の向き SUN_DIR では、影の源の軸が右下の球から半径の約 5.5 倍外れる)。
const ECLIPSE_SUN = {
  ...SUN_DIR_ANGLES,
  sunAzimuthDeg: SUN_DIR_ANGLES.sunAzimuthDeg + 10,
};
// 日食の影の源の寸法を測る単位 [m]。右下の球の半径の 1/300。
const ECLIPSE_UNIT = GRID_SPHERE_RADIUS / 300;

// 較正の撮影。天体照を切り、地球を遠ざけて、恒星の直射と環境光だけで照らす。view は観察の向きの差分。
function calibration(view: Partial<LabViewAngles>): LabShot {
  return { view: { ...EARTH_AWAY, ...view }, graphics: { planetLightCount: 0 } };
}

// 材質の格子: 列ごとに粗さ、行ごとに金属度とアルベドを振った球を並べ、低軌道の地球を背にする。右下の球から
// 日食の撮影の恒星の方向には、見えない影の源(球と、それを巡る環の帯)を置く。
function materials(): LabCase {
  // ジオメトリは先頭の球が所有する。
  const geometry = new THREE.SphereGeometry(GRID_SPHERE_RADIUS, 128, 96);
  const objects = GRID_ROWS.flatMap(({ color, metalness }, row) => GRID_ROUGHNESS.map((roughness, column) => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(color, color, color, THREE.LinearSRGBColorSpace),
      roughness,
      metalness,
    }));
    mesh.position.copy(gridPosition(column, row));
    mesh.userData.ownsGeometry = row === 0 && column === 0;
    mesh.userData.ownsMaterial = true;
    markLitOpaque(mesh);
    return mesh;
  }));
  // 日食の影の源。
  const eclipseSunDirection = directionFromAngles(
    ECLIPSE_SUN.sunAzimuthDeg, ECLIPSE_SUN.sunElevationDeg, new THREE.Vector3(),
  );
  const shadowSourceCenter = ROUGH_WHITE.clone().addScaledVector(eclipseSunDirection, 1e4 * ECLIPSE_UNIT);
  return {
    objects,
    camera: labCamera(),
    viewTarget: GRID_CENTER,
    earth: BACKDROP_EARTH_PLACEMENT,
    shadowBodies: [sphereShadowBody(shadowSourceCenter, 50 * ECLIPSE_UNIT)],
    rings: {
      center: shadowSourceCenter,
      axis: eclipseSunDirection.clone().add(new THREE.Vector3(0, 0.7, 0)).normalize(),
      bands: [
        { innerRadius: 110 * ECLIPSE_UNIT, outerRadius: 170 * ECLIPSE_UNIT, normalOpticalDepth: 0.4 },
        { innerRadius: 210 * ECLIPSE_UNIT, outerRadius: 320 * ECLIPSE_UNIT, normalOpticalDepth: 1.6 },
      ],
    },
    shots: {
      // 金属の行への天体照の映り込みと、その後ろに写る地球そのものを 1 枚の中で見比べる。
      'leo-metal': { view: {} },
      'leo-metal-terminator': { view: TERMINATOR_SUN },
      // 金属のハイライト。左上の球に、球光源では太陽の円盤が幅十数 px の像として映り、点光源の GGX では
      // 粗さぶんの数 px の点に潰れる。
      'metal-highlight': { view: { ...SMOOTH_METAL_CLOSE_UP, ...METAL_HIGHLIGHT_SUN } },
      // 水星近日点の太陽を横から当てた右下の球。昼夜境界の幅が球光源のときだけ広がる。低軌道の地球の照り返しは
      // 夜側を埋めるので、地球は遠ざける。
      'sun-close': { view: { ...ROUGH_WHITE_CLOSE_UP, ...SIDE_SUN, ...EARTH_AWAY } },
      // 較正。**放射照度の単位が「1 AU で π」に取れていれば、右下の球の太陽へ正対した面のトーンマッピング前の
      // 線形値は 1.0 になる** — ランバート BRDF の 1/π が単位を打ち消すため。ここが動いたら光の単位か
      // BRDF のどちらかが崩れている。その球の**最も明るい画素は sRGB (241, 241, 241)**: 白い恒星光に
      // 誘電体の鏡面(F0=0.04、粗さ 1)のわずかな持ち上がりが乗り、PBR Neutral と sRGB 符号化を通した値。
      'albedo': calibration(ROUGH_WHITE_CLOSE_UP),
      // 日食。影の源の球は太陽とほぼ同じ視半径なので本影は点に近く、右下の球の面の大半が半影の階調になる —
      // 影の縁がぼけて見えることが円盤の重なり面積を解いている証拠で、環の縞はそれとは別の経路の証拠になる。
      'eclipse': calibration({ ...ROUGH_WHITE_CLOSE_UP, ...ECLIPSE_SUN }),
      // 外惑星圏。恒星を遠ざけ、アルベド 0.3・粗さ 1 の球の**太陽に正対した面が黒へ潰れていないか**を読む。
      // 球の最も明るい画素が太陽に正対した面にあたるので、距離ごとの表示値はそこで測る。
      'outer-5au': calibration({ ...ROUGH_GREY_CLOSE_UP, sunDistanceLogAu: Math.log10(5) }),
      'outer-30au': calibration({ ...ROUGH_GREY_CLOSE_UP, sunDistanceLogAu: Math.log10(30) }),
      // 太陽の見かけ径。1 AU で円盤が分解され(5.4 px)、5.2 AU で 1 px、30 AU で 0.2 px になる。
      // **1 px を切ると**総光量がラスタライズの被覆率へ量子化される — サブピクセルの移動に対する
      // 画面のちらつきを、この向きでカメラ方位を回して測る。
      'sun-1au': { view: SUN_IN_VIEW },
      'sun-5au': { view: { ...SUN_IN_VIEW, sunDistanceLogAu: Math.log10(5.2) } },
      'sun-30au': { view: { ...SUN_IN_VIEW, sunDistanceLogAu: Math.log10(30) } },
    },
  };
}

// 球の列の温度 [K] と、列を置く奥行き [m]。
const BLACKBODY_TEMPERATURES = [900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000];
const BLACKBODY_DEPTH = 30;
// 温度勾配の円柱の平均温度 [K] と、右端が平均より高い温度差 [K]。
const BLACKBODY_GRADIENT_AVERAGE = 950;
const BLACKBODY_GRADIENT_DEVIATION = 550;
// 艦が喪失する温度(1,300 K)の少し上。夜側で赤熱として読める明るさになる。
const BLACKBODY_SHIP_TEMPERATURE = 1400;
// 1 本の InstancedMesh へ積む枝の温度 [K]。
const BLACKBODY_INSTANCE_TEMPERATURES = [1200, 1300, 1400, 1500, 1600, 1700];

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
  // 個体を横一列に並べ、それぞれの温度を属性として積む。
  const piece = new THREE.Object3D();
  pool.beginFrame();
  for (const [i, temperature] of BLACKBODY_INSTANCE_TEMPERATURES.entries()) {
    piece.position.copy(center).setX(center.x + (i - (count - 1) / 2) * spacing);
    piece.rotation.set(0.42, 0.62, 0);
    syncThermalState(piece, temperature, 0, HULL_EMISS);
    pool.push(piece);
  }
  pool.endFrame();
  return detachPoolMesh(host);
}

// 温度による自照を読むケース。恒星は斜めから差すので、反射に埋もれる昼側と自照だけの夜側が同じ
// 物体の上に並ぶ。
function blackbody(): LabCase {
  // 温度の違う球の列。**球はすべて同じ 1 つのマテリアルを共有し、温度だけが個体ごとに違う** —
  // 明るさが球ごとに違って見えることが、個体ごとの温度が届いていることの唯一の印で、全部同じ
  // 明るさなら配線が死んでいる。ジオメトリとマテリアルは先頭の球が所有する。
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
  // 頂点ごとの温度勾配を持つ円柱と、個体ごとの温度を持つ枝。円柱では、**赤熱が部品の切れ目ではなく
  // 勾配として終わる**ことを見る。
  const barMaterial = blackbodyMaterial(true);
  const bar = blackbodyGradientBar(barMaterial, 30, 1.0);
  bar.position.set(0, -3.4, -BLACKBODY_DEPTH);
  bar.userData.ownsMaterial = true;
  syncThermalState(bar, BLACKBODY_GRADIENT_AVERAGE, BLACKBODY_GRADIENT_DEVIATION, HULL_EMISS);
  markLitOpaque(bar);
  objects.push(bar);
  objects.push(blackbodyInstancedRow(new THREE.Vector3(-14, -8, -BLACKBODY_DEPTH), 3));
  // 艦 1 隻を同じ絵へ。**モデルから読んだマテリアルにも温度が届く**ことを見る。
  const heatedShip = shipAt(new THREE.Vector3(22, -15, -50), SHIP_ROTATION_PORT);
  syncThermalState(heatedShip, BLACKBODY_SHIP_TEMPERATURE, 0, HULL_EMISS);
  objects.push(heatedShip);
  return { objects, camera: labCamera(), sunDirection: OBLIQUE_SUN_DIR };
}

export const MATERIAL_CASES = {
  'materials': materials,
  'blackbody': blackbody,
} as const satisfies Record<string, CaseBuilder>;
