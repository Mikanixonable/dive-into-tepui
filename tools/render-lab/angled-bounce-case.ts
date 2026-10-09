// 照り返しの空間構造を送り手の角度ごとに読むケース。広い白い床を、床に蝶番で付けた5枚の光る板だけが
// 照らす。板と床の二面角は 30°〜150°、色相は板ごとに違い(輝度は正規化)、放射輝度は接合部の床の
// 放射照度が角度によらず揃うよう補正する。板は細く、床での寄与が板ごとに分かれる。板はカメラのまわりの
// 円弧に置き、どの接合部も同じ仰角で真正面から見える。接合部の近くの明るい芯と床に広がる裾が、
// スクリーンスペースの帯の鎖を通ったあと角度ごとにどう残るかを見る。
import * as THREE from 'three/webgpu';
import { markLitOpaque } from '../../src/render/pipeline/lit-layer';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';
import { EARTH_AWAY, labCamera, slab, type CaseBuilder, type LabCase } from './lab-case';

// 板を置く円弧の半径 [m]。中心は床の原点。
const ARC_RADIUS = 10;
// 隣り合う板の方位の間隔 [deg]。−Z 軸を中心に並べる。
const AZIMUTH_STEP_DEG = 15;
// 画面の左から右へ並べる板の二面角 [deg]。床の内側と発光面のあいだの角で、90 未満は床に覆いかぶさり、
// 90 で垂直、90 超は反り返る。
const PANEL_ANGLES_DEG = [30, 60, 90, 120, 150] as const;
// 板の幅(蝶番に沿う)・長さ(蝶番から先端)・厚み(発光面の裏へ) [m]。
const PANEL_WIDTH = 0.6;
const PANEL_LENGTH = 3;
const PANEL_THICKNESS = 0.05;
// 床の厚み [m] と、床が張る範囲(x は ±FLOOR_HALF_WIDTH、奥は円弧の外 FLOOR_MARGIN) [m]。
const FLOOR_THICKNESS = 0.2;
const FLOOR_HALF_WIDTH = 13;
const FLOOR_MARGIN = 4;
// 二面角 90° の板の放射輝度。各板の放射輝度は、接合部の床の放射照度が 90° の板と同じになるよう
// 選ぶ(幅の広い板から蝶番上の点への形態係数が (1 + cos α) / 2 なので、その逆数を掛ける)。
// これで角度どうしを同じ表示尺度で比べられる。
const RADIANCE_AT_90 = 1;
// 板ごとの色相(線形 RGB)。輝度 1 へ正規化して使う。
const PANEL_HUES: readonly (readonly [number, number, number])[] = [
  [1, 0.25, 0.2], [1, 0.8, 0.2], [0.25, 1, 0.3], [0.2, 0.6, 1], [0.85, 0.3, 1],
];
// 接合部を見る仰角 [deg]。カメラは円弧の中心の真上に置く。
const CAMERA_ELEVATION_DEG = 20;
const VIEW_TARGET = new THREE.Vector3(0, 0.6, -8.5);
// 照り返しだけを読むため、環境光・天体照・レンズを切る。
const GRAPHICS: Partial<GraphicsSettingsData> = {
  ambient: false, planetLightCount: 0, lens: false, exposureCompensation: 4,
};

// 色相 hue を Rec.709 輝度 1 へ正規化した線形の色。
function equalLuminance([r, g, b]: readonly [number, number, number]): THREE.Color {
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return new THREE.Color().setRGB(r / luminance, g / luminance, b / luminance, THREE.LinearSRGBColorSpace);
}

// 発光面だけが光る板。BoxGeometry の面の並びは +x -x +y -y +z -z で、局所 +z の面(添字 4)を発光面にする。
function panelMesh(hue: THREE.Color, radiance: number): THREE.Mesh {
  const black = () => new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 });
  const emissive = new THREE.MeshStandardMaterial({
    color: 0x000000, roughness: 1, emissive: hue, emissiveIntensity: radiance,
  });
  const materials = [black(), black(), black(), black(), emissive, black()];
  return slab(
    new THREE.Vector3(-PANEL_WIDTH / 2, 0, -PANEL_THICKNESS),
    new THREE.Vector3(PANEL_WIDTH / 2, PANEL_LENGTH, 0),
    materials,
  );
}

// 二面角 dihedralDeg・方位 azimuthDeg の板。蝶番を円弧に接して床に置き、発光面を円弧の中心へ向ける。
function panel(dihedralDeg: number, azimuthDeg: number, hue: THREE.Color): THREE.Object3D {
  const tilt = new THREE.Group();
  tilt.rotation.x = THREE.MathUtils.degToRad(90 - dihedralDeg);
  const radiance = RADIANCE_AT_90 / (1 + Math.cos(THREE.MathUtils.degToRad(dihedralDeg)));
  tilt.add(panelMesh(hue, radiance));
  const onArc = new THREE.Group();
  onArc.position.set(0, 0, -ARC_RADIUS);
  onArc.add(tilt);
  const aimed = new THREE.Group();
  aimed.rotation.y = THREE.MathUtils.degToRad(azimuthDeg);
  aimed.add(onArc);
  return aimed;
}

function angledBounce(): LabCase {
  const objects = new THREE.Group();
  objects.add(slab(
    new THREE.Vector3(-FLOOR_HALF_WIDTH, -FLOOR_THICKNESS, -(ARC_RADIUS + FLOOR_MARGIN)),
    new THREE.Vector3(FLOOR_HALF_WIDTH, 0, 1),
  ));
  // 方位が正の板は x が負(画面の左)に来るので、左端が二面角の最小になる。
  const middle = (PANEL_ANGLES_DEG.length - 1) / 2;
  for (const [index, angle] of PANEL_ANGLES_DEG.entries()) {
    objects.add(panel(angle, (middle - index) * AZIMUTH_STEP_DEG, equalLuminance(PANEL_HUES[index]!)));
  }
  markLitOpaque(objects);

  const camera = labCamera();
  camera.position.set(0, ARC_RADIUS * Math.tan(THREE.MathUtils.degToRad(CAMERA_ELEVATION_DEG)), 0);
  camera.lookAt(VIEW_TARGET);
  camera.updateMatrixWorld();
  return {
    objects: [objects], camera, viewTarget: VIEW_TARGET,
    // 真下から — 床の上面を直接照らさない。
    sunDirection: new THREE.Vector3(0, -1, 0),
    shots: {
      'angled-bounce': { view: EARTH_AWAY, graphics: GRAPHICS },
      'angled-bounce-correction': { view: EARTH_AWAY, graphics: GRAPHICS, debugTarget: 'correction' },
    },
  };
}

export const ANGLED_BOUNCE_CASES = {
  'angled-bounce': angledBounce,
} as const satisfies Record<string, CaseBuilder>;
