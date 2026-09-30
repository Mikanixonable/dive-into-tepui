// 平面のケース。白い平らな床 1 枚を置く。床の半球はどの向きも開けているので、近くの構造による遮りと照り返しは
// 光源の向きと大きさによらず 0 になる — 補正が 0 のままかを読む試験体。
import * as THREE from 'three/webgpu';
import { R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import { markLitOpaque } from '../../src/render/pipeline/lit-layer';
import { directionFromAngles, type EarthAngleKey, type LabViewAngles } from './view-angles';
import { EARTH_AWAY, labCamera, slab, type CaseBuilder, type LabCase } from './lab-case';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';

// 床の半幅と厚み [m]。上面は y = 0。掠める構図でも、地平の近くまで床が続く。
const FLOOR_EXTENT = 400;
const FLOOR_THICKNESS = 0.2;

// 観察の中心と、既定のカメラの方位・仰角 [deg]・距離 [m]。床を斜め上から見下ろす。
const VIEW_TARGET = new THREE.Vector3(0, 0, 0);
const CAMERA_AZIMUTH_DEG = 15;
const CAMERA_ELEVATION_DEG = 50;
const CAMERA_DISTANCE = 11.6;
// 床を掠める構図のカメラの仰角 [deg]。画面の上端に地平が入る。
const GRAZING_CAMERA_ELEVATION_DEG = 10;

// 地球の置き方の既定: 描画原点の高度を低軌道の 420 km にし、真上に置く。直下点は地表の色が読める陸(サハラ)。
const OVERHEAD_EARTH: Pick<LabViewAngles, EarthAngleKey> = {
  earthAzimuthDeg: 0,
  earthElevationDeg: 90,
  earthAltitudeLog: Math.log10(420e3),
  earthLatitudeDeg: 23,
  earthLongitudeDeg: 13,
};
// 恒星を床の真下に置く向き。床は直射を受けない。
const SUN_BELOW: Partial<LabViewAngles> = { sunAzimuthDeg: 0, sunElevationDeg: -90 };
// 天体照の撮影の、地球の方位 [deg](画面の右手)と、大きい地球・小さい地球の視半径 [deg]。
const EARTH_AZIMUTH_DEG = 90;
const LARGE_EARTH_RADIUS_DEG = 30;
const SMALL_EARTH_RADIUS_DEG = 3;
// 視半径 LARGE_EARTH_RADIUS_DEG の地球の天体照で、床が読める明るさになる恒星までの距離 [log10 天文単位]。
const LARGE_EARTH_SUN_DISTANCE_LOG_AU = -0.16;

// 天体照だけで照らす撮影の観察の向き。恒星は床の真下、地球は描画原点から方位 EARTH_AZIMUTH_DEG・仰角
// elevationDeg [deg] の向きへ、視半径 radiusDeg [deg] で見える高度に置く。恒星までの距離は、視半径によらず
// 正対する面へ同じ照度が届くように決める。
function earthLightView(elevationDeg: number, radiusDeg: number): Partial<LabViewAngles> {
  const sinRadius = Math.sin(THREE.MathUtils.degToRad(radiusDeg));
  const sinLargeRadius = Math.sin(THREE.MathUtils.degToRad(LARGE_EARTH_RADIUS_DEG));
  return {
    ...SUN_BELOW,
    sunDistanceLogAu: LARGE_EARTH_SUN_DISTANCE_LOG_AU + Math.log10(sinRadius / sinLargeRadius),
    earthAzimuthDeg: EARTH_AZIMUTH_DEG,
    earthElevationDeg: elevationDeg,
    earthAltitudeLog: Math.log10(R_EARTH / sinRadius - R_EARTH),
  };
}

// 天体照だけを一様球で当てる描画設定。
const PLANET_LIGHT_ONLY: Partial<GraphicsSettingsData> = {
  ambient: false, planetLightModel: 0, exposureCompensation: 4, lens: false,
};
// 一様な環境光だけで照らす観察の向きと描画設定。
const AMBIENT_ONLY_VIEW: Partial<LabViewAngles> = { ...SUN_BELOW, ...EARTH_AWAY };
const AMBIENT_ONLY: Partial<GraphicsSettingsData> = { planetLightCount: 0, exposureCompensation: 4, lens: false };
// 床を掠める構図の、観察の向きの差分。
const GRAZING: Partial<LabViewAngles> = { cameraElevationDeg: GRAZING_CAMERA_ELEVATION_DEG };

// 平面。撮影はどれも恒星を床の真下に置き、天体照か一様な環境光の片方だけで照らす。
function plane(): LabCase {
  const floor = slab(
    new THREE.Vector3(-FLOOR_EXTENT, -FLOOR_THICKNESS, -FLOOR_EXTENT), new THREE.Vector3(FLOOR_EXTENT, 0, FLOOR_EXTENT),
  );
  markLitOpaque(floor);
  const camera = labCamera();
  camera.position.copy(VIEW_TARGET).addScaledVector(
    directionFromAngles(CAMERA_AZIMUTH_DEG, CAMERA_ELEVATION_DEG, new THREE.Vector3()), CAMERA_DISTANCE,
  );
  camera.lookAt(VIEW_TARGET);
  camera.updateMatrixWorld();
  return {
    objects: [floor],
    camera,
    viewTarget: VIEW_TARGET,
    earth: OVERHEAD_EARTH,
    shots: {
      // 大きい地球を、真上・球冠の下端が仰角 5° まで届く低さ・地平をまたぐ低さに置く。
      'plane-earth-overhead': { view: earthLightView(90, LARGE_EARTH_RADIUS_DEG), graphics: PLANET_LIGHT_ONLY },
      'plane-earth-low': { view: earthLightView(35, LARGE_EARTH_RADIUS_DEG), graphics: PLANET_LIGHT_ONLY },
      'plane-earth-horizon': { view: earthLightView(10, LARGE_EARTH_RADIUS_DEG), graphics: PLANET_LIGHT_ONLY },
      // 小さい地球を、同じく真上・球冠の下端が仰角 5° の低さ・地平をまたぐ低さに置く。
      'plane-moon-overhead': { view: earthLightView(90, SMALL_EARTH_RADIUS_DEG), graphics: PLANET_LIGHT_ONLY },
      'plane-moon-low': { view: earthLightView(8, SMALL_EARTH_RADIUS_DEG), graphics: PLANET_LIGHT_ONLY },
      'plane-moon-horizon': { view: earthLightView(1, SMALL_EARTH_RADIUS_DEG), graphics: PLANET_LIGHT_ONLY },
      // 一様な環境光だけ。
      'plane-ambient': { view: AMBIENT_ONLY_VIEW, graphics: AMBIENT_ONLY },
      // 床を掠める構図。手前から地平まで、近傍の半径が画面の上で 2 桁変わる。
      'plane-earth-low-grazing': {
        view: { ...earthLightView(35, LARGE_EARTH_RADIUS_DEG), ...GRAZING }, graphics: PLANET_LIGHT_ONLY,
      },
      'plane-ambient-grazing': { view: { ...AMBIENT_ONLY_VIEW, ...GRAZING }, graphics: AMBIENT_ONLY },
    },
  };
}

export const PLANE_CASES = {
  'plane': plane,
} as const satisfies Record<string, CaseBuilder>;
