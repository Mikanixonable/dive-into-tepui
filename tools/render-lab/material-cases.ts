// 材質と較正のケース。金属球に映る天体照、恒星の見え方と灰色球、アルベド 1 の球による放射照度の
// 較正と日食、温度による自照を読む試験体を組む。
import * as THREE from 'three/webgpu';
import { buildBarrelMesh } from '../../src/render/dynamic/dynamic-entity/ejected-gun-part-view';
import { InstancedPool } from '../../src/render/instanced-pool';
import { markLitOpaque } from '../../src/render/pipeline/lit-layer';
import {
  attachThermalEmissive, syncThermalState, THERMAL_SHAPE_ATTRIBUTE, type ThermalSource,
} from '../../src/render/thermal-emissive';
import { sphereShadowBody } from '../../src/render/pipeline/shadow/body-shadow';
import { directionFromAngles, type EarthAngleKey, type LabViewAngles } from './view-angles';
import { HULL_EMISS } from '../../src/game/dynamic/dynamic-motion';
import {
  labCamera, OBLIQUE_SUN_DIR, SHIP_ROTATION_PORT, shipAt, sphere, SUN_DIR_ANGLES, sunAnglesOf,
  type CaseBuilder, type LabCase,
} from './lab-case';
import type { Albedo } from '../../src/render/celestial-albedo';

// 水星近日点の距離(天文単位)の常用対数。太陽の視半径が 0.86° に広がる。
const MERCURY_PERIHELION_LOG_AU = Math.log10(0.31);

// 典型的な天体表面・艦の外殻の反射率。
const OUTER_ALBEDO: Albedo = [0.3, 0.3, 0.3];
// 灰色球の半径 [m]。
const OUTER_BODY_RADIUS = 6.371e6;

// 太陽を画面へ入れる撮影の恒星の向き。灰色球の縁の右上の外、艦から離れた位置に太陽が来る。
const SUN_IN_VIEW = sunAnglesOf(new THREE.Vector3(0.2563, 0.1392, -0.9565));

// 恒星と灰色球と艦: 灰色球と艦 1 隻を置き、恒星の距離を変えて見る。灰色球はそのまま天体照の光源にも
// なる(艦の夜側を照らす)。艦は灰色球の外、画面の左上へ置く — 太陽に正対する面(球の右上)へ
// 重なると、そこの画素が艦の鏡面反射に置き換わって読めない。
function outer(): LabCase {
  const center = new THREE.Vector3(0, -0.5 * OUTER_BODY_RADIUS, -3 * OUTER_BODY_RADIUS);
  const shipPosition = new THREE.Vector3(-55, 22, -100);
  return {
    objects: [sphere(OUTER_ALBEDO, OUTER_BODY_RADIUS, center), shipAt(shipPosition, SHIP_ROTATION_PORT)],
    camera: labCamera(),
    viewTarget: shipPosition,
    planetLights: [{ center, radius: OUTER_BODY_RADIUS, albedo: OUTER_ALBEDO }],
    shots: {
      // 水星近日点の太陽。球の昼夜境界の幅が球光源のときだけ広がる。
      'sun-close': { view: { sunDistanceLogAu: MERCURY_PERIHELION_LOG_AU } },
      // 外惑星圏。恒星を遠ざけ、**太陽に正対した面が黒へ潰れていないか**を読む。球の最も明るい
      // 画素が太陽に正対した面にあたるので、距離ごとの表示値はそこで測る。
      'outer-5au': { view: { sunDistanceLogAu: Math.log10(5) } },
      'outer-30au': { view: { sunDistanceLogAu: Math.log10(30) } },
      // 太陽の見かけ径。1 AU で円盤が分解され(5.4 px)、5.2 AU で 1 px、30 AU で 0.2 px になる。
      // **1 px を切ると**総光量がラスタライズの被覆率へ量子化される — サブピクセルの移動に対する
      // 画面のちらつきを、この向きでカメラ方位を回して測る。
      'sun-1au': { view: SUN_IN_VIEW },
      'sun-5au': { view: { ...SUN_IN_VIEW, sunDistanceLogAu: Math.log10(5.2) } },
      'sun-30au': { view: { ...SUN_IN_VIEW, sunDistanceLogAu: Math.log10(30) } },
    },
  };
}

// 低軌道の金属球のケースの描画原点の高度 [m]。
const LEO_METAL_ALTITUDE = 420e3;
// 低軌道の金属球のケースの地球の置き方: 視線の先(−Z)に置き、直下点を地表の色が読める陸
// (サハラ、北緯 23°・東経 13°)にする。
const LEO_METAL_PLACEMENT: Pick<LabViewAngles, EarthAngleKey> = {
  earthAzimuthDeg: 180,
  earthElevationDeg: 0,
  earthAltitudeLog: Math.log10(LEO_METAL_ALTITUDE),
  earthLatitudeDeg: 23,
  earthLongitudeDeg: 13,
};
// 低軌道の手前へ置く金属球の半径 [m] と中心(描画座標)。画面の高さの半分ほどを占める。
const LEO_METAL_RADIUS = 2000;
const LEO_METAL_CENTER = new THREE.Vector3(0, -600, -9000);
// 昼夜境界が地球の円盤を横切る位相になる恒星の向き。
const LEO_METAL_TERMINATOR_SUN = sunAnglesOf(new THREE.Vector3(1, 0.2, 0));
// 金属のハイライトの撮影で、周回の中心(金属球の奥行き)からカメラまでの距離 [m]。
const METAL_HIGHLIGHT_DISTANCE = 3000;

// 低軌道の金属球: 実写テクスチャの地球で画面を埋め、手前の金属球へ天体照がどう映るかを読む。
// **映り込みと、その隣に写る地球そのものを1枚の中で見比べる構図。** 見比べる相手は実機に写る地球
// なので、大気と雲も実機と同じく組む。
function leoMetal(): LabCase {
  const metal = new THREE.Mesh(
    new THREE.SphereGeometry(LEO_METAL_RADIUS, 128, 96),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 1 }),
  );
  metal.position.copy(LEO_METAL_CENTER);
  metal.userData.ownsGeometry = true;
  metal.userData.ownsMaterial = true;
  markLitOpaque(metal);
  return {
    objects: [metal],
    camera: labCamera(),
    viewTarget: LEO_METAL_CENTER,
    earth: LEO_METAL_PLACEMENT,
    shots: {
      'leo-metal': { view: {} },
      'leo-metal-terminator': { view: LEO_METAL_TERMINATOR_SUN },
      // 金属のハイライト。曲率のゆるい大きな球に、球光源では太陽の円盤が幅十数 px の像として映り、
      // 点光源の GGX では粗さぶんの数 px の点に潰れる。
      'metal-highlight': {
        view: {
          sunDistanceLogAu: MERCURY_PERIHELION_LOG_AU,
          cameraDistanceLog: Math.log10(METAL_HIGHLIGHT_DISTANCE / -LEO_METAL_CENTER.z),
        },
      },
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
  // 積んだ InstancedMesh を仮の親から外し、ケースの物体として返す。
  const mesh = host.children[0]!;
  host.remove(mesh);
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  return mesh;
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
  // 排出直後の砲身。**赤熱が薬室から砲口へ向かって連続して落ちる**ことを見る。
  const barrel = buildBarrelMesh();
  barrel.position.set(0, 6, -20);
  barrel.rotation.set(0, Math.PI / 2, 0.06);
  syncThermalState(barrel, BLACKBODY_BARREL_TEMPERATURE, BLACKBODY_BARREL_DEVIATION, HULL_EMISS);
  objects.push(barrel);
  // 艦 1 隻を同じ絵へ。**モデルから読んだマテリアルにも温度が届く**ことを見る。
  const heatedShip = shipAt(new THREE.Vector3(22, -15, -50), SHIP_ROTATION_PORT);
  syncThermalState(heatedShip, BLACKBODY_SHIP_TEMPERATURE, 0, HULL_EMISS);
  objects.push(heatedShip);
  return { objects, camera: labCamera(), sunDirection: OBLIQUE_SUN_DIR };
}

// 日食の撮影の恒星の向き。影の源はこの向きへ置くので、較正の向き(SUN_DIR)の撮影では影の源の軸が
// 受ける球から約 1.6 km(1e4 m × sin 9.5°)外れ、球(半径 300 m)にも環の帯(外縁 320 m)の影にも
// かからない。
const ALBEDO_ECLIPSE_SUN = {
  ...SUN_DIR_ANGLES,
  sunAzimuthDeg: SUN_DIR_ANGLES.sunAzimuthDeg + 10,
};

// 較正と日食: アルベド 1 の完全拡散球を 1 天文単位の恒星で照らす。日食の撮影の恒星の方向には、
// 見えない影の源(球と、それを巡る環の帯)を置く。
function albedo(): LabCase {
  const center = new THREE.Vector3(0, 0, -1000);
  const surface = new THREE.Mesh(
    new THREE.SphereGeometry(300, 96, 64),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 }),
  );
  surface.position.copy(center);
  markLitOpaque(surface);
  const eclipseSunDirection = directionFromAngles(
    ALBEDO_ECLIPSE_SUN.sunAzimuthDeg, ALBEDO_ECLIPSE_SUN.sunElevationDeg, new THREE.Vector3(),
  );
  const shadowSourceCenter = center.clone().addScaledVector(eclipseSunDirection, 1e4);
  return {
    objects: [surface],
    camera: labCamera(),
    shadowBodies: [sphereShadowBody(shadowSourceCenter, 50)],
    rings: {
      center: shadowSourceCenter,
      axis: eclipseSunDirection.clone().add(new THREE.Vector3(0, 0.7, 0)).normalize(),
      bands: [
        { innerRadius: 110, outerRadius: 170, normalOpticalDepth: 0.4 },
        { innerRadius: 210, outerRadius: 320, normalOpticalDepth: 1.6 },
      ],
    },
    shots: {
      // 較正。**放射照度の単位が「1 AU で π」に取れていれば、太陽へ正対した面のトーンマッピング前の
      // 線形値は 1.0 になる** — ランバート BRDF の 1/π が単位を打ち消すため。ここが動いたら光の単位か
      // BRDF のどちらかが崩れている。画面上の**最も明るい画素は sRGB (241, 241, 241)**: 白い恒星光に
      // 誘電体の鏡面(F0=0.04、粗さ 1)のわずかな持ち上がりが乗り、PBR Neutral と sRGB 符号化を通した値。
      'albedo': { view: {} },
      // 日食。影の源の球は太陽とほぼ同じ視半径なので本影は点に近く、面の大半が半影の階調になる —
      // 影の縁がぼけて見えることが円盤の重なり面積を解いている証拠で、環の縞はそれとは別の経路の
      // 証拠になる。
      'eclipse': { view: ALBEDO_ECLIPSE_SUN },
    },
  };
}

export const MATERIAL_CASES = {
  'leo-metal': leoMetal,
  'outer': outer,
  'albedo': albedo,
  'blackbody': blackbody,
} as const satisfies Record<string, CaseBuilder>;
