// render-lab で、地表・大気・影の三経路が同じ局所光学場を読むことを確かめるための、目に見える
// 規模の診断体積場を作る。中心直下の眺め(緯度 0・経度 0 が直下点の構図)に場が来るよう、
// 天体固定の赤道・本初子午線へ張る。
import * as THREE from 'three/webgpu';
import { R_EARTH_EQ } from '../../src/game/celestial/solar-system/earth-system';
import { v3 } from '../../src/math/vec3';
import type { CloudLocalFieldBinding, CloudLocalFieldFrame } from '../../src/render/cloud/cloud-local-field';

// 場の一辺 [texel] と、中心のまわりに東西・南北へ張る幅 [m]。
const DIAGNOSTIC_GRID_SIZE = 256;
const DIAGNOSTIC_SPAN_M = 500e3;
// 高度層の境界 [m]。下層は液水の塊、上層は氷の塊を置く。
const DIAGNOSTIC_LAYER_EDGES_M = [0, 3e3, 9e3];
// 塊の消散の山 [m^-1]。鉛直の光学的厚みは液水 0.6・氷 0.6 になる。
const DIAGNOSTIC_LIQUID_BETA = 2e-4;
const DIAGNOSTIC_ICE_BETA = 1e-4;
// ガウス塊の広がり [m] と、氷塊の中心の東・北へのずれ [m]。
const DIAGNOSTIC_LIQUID_RADIUS_M = 130e3;
const DIAGNOSTIC_ICE_RADIUS_M = 160e3;
const DIAGNOSTIC_ICE_OFFSET_EAST_M = 60e3;
const DIAGNOSTIC_ICE_OFFSET_NORTH_M = 70e3;

// 見える規模の診断場を焼き、RG32F の DataArrayTexture と frame の組を返す。
// texture の所有権は呼び出し側が持ち、破棄は差し込んだ側が行う。
export function createCloudLocalFieldDiagnostic(): CloudLocalFieldBinding {
  const size = DIAGNOSTIC_GRID_SIZE;
  const cellM = DIAGNOSTIC_SPAN_M / size;
  const layers = DIAGNOSTIC_LAYER_EDGES_M.length - 1;
  const data = new Float32Array(size * size * layers * 2);
  for (let y = 0; y < size; y += 1) {
    const northM = -DIAGNOSTIC_SPAN_M / 2 + (y + 0.5) * cellM;
    for (let x = 0; x < size; x += 1) {
      const eastM = -DIAGNOSTIC_SPAN_M / 2 + (x + 0.5) * cellM;
      const liquid = DIAGNOSTIC_LIQUID_BETA
        * Math.exp(-(((eastM ** 2) + (northM ** 2)) / DIAGNOSTIC_LIQUID_RADIUS_M ** 2));
      const iceDeltaEast = eastM - DIAGNOSTIC_ICE_OFFSET_EAST_M;
      const iceDeltaNorth = northM - DIAGNOSTIC_ICE_OFFSET_NORTH_M;
      const ice = DIAGNOSTIC_ICE_BETA
        * Math.exp(-(((iceDeltaEast ** 2) + (iceDeltaNorth ** 2)) / DIAGNOSTIC_ICE_RADIUS_M ** 2));
      const texel = (y * size + x) * 2;
      data[texel] = liquid;
      data[size * size * 2 + texel + 1] = ice;
    }
  }

  const texture = new THREE.DataArrayTexture(data, size, size, layers);
  texture.name = 'render-lab-cloud-local-field-diagnostic';
  texture.format = THREE.RGFormat;
  texture.type = THREE.FloatType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  // 天体固定の赤道・本初子午線を中心に張る。直下点がその位置へ来る構図で三経路へ効く。
  const frame: CloudLocalFieldFrame = {
    centerDirection: v3(0, 0, 1),
    eastDirection: v3(1, 0, 0),
    northDirection: v3(0, 1, 0),
    sphereRadiusM: R_EARTH_EQ,
    gridOriginEastM: -DIAGNOSTIC_SPAN_M / 2,
    gridOriginNorthM: -DIAGNOSTIC_SPAN_M / 2,
    cellWidthM: cellM,
    cellHeightM: cellM,
    gridWidth: size,
    gridHeight: size,
    // 格子の角(半対角)まで場が届く角距離。
    maxAngularDistanceRad: Math.hypot(DIAGNOSTIC_SPAN_M / 2, DIAGNOSTIC_SPAN_M / 2) / R_EARTH_EQ,
    layerEdgesM: DIAGNOSTIC_LAYER_EDGES_M,
  };
  return { texture, frame };
}
