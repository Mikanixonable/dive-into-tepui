import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { float, vec3 } from 'three/tsl';
import { v3 } from '../../src/math/vec3';
import type { CloudOpticalVolumeData } from '../../src/render/cloud/cloud-optical-volume';
import {
  CloudLocalFieldSampler, cloudLocalDirectionAt, cloudLocalLayerIndexAt, cloudLocalUvAt,
  integrateCloudLocalFieldRayCpu, sampleCloudLocalFieldCpu, validateCloudLocalFieldFrame,
  type CloudLocalFieldFrame,
} from '../../src/render/cloud/cloud-local-field';
import { test } from '../harness';

const RADIUS_M = 6_371_000;
const EDGES_M = [0, 1_000, 3_000, 6_000, 8_000];
const LIQUID_BETA = 2e-4;
const ICE_BETA = 1e-4;
const WIDTH = 64;
const HEIGHT = 64;
const CELL_M = 250;

function frame(): CloudLocalFieldFrame {
  return {
    centerDirection: v3(0, 0, 1),
    eastDirection: v3(1, 0, 0),
    northDirection: v3(0, 1, 0),
    sphereRadiusM: RADIUS_M,
    gridOriginEastM: -(WIDTH * CELL_M) / 2,
    gridOriginNorthM: -(HEIGHT * CELL_M) / 2,
    cellWidthM: CELL_M,
    cellHeightM: CELL_M,
    gridWidth: WIDTH,
    gridHeight: HEIGHT,
    maxAngularDistanceRad: 0.01,
    layerEdgesM: EDGES_M,
  };
}

// 均質な層別の場。液水は 1–3 km 全格子、氷は 6–8 km 全格子で一様。
function uniformLayeredData(): CloudOpticalVolumeData {
  const layers = EDGES_M.length - 1;
  const liquid = new Float32Array(WIDTH * HEIGHT * layers);
  const ice = new Float32Array(liquid.length);
  liquid.fill(LIQUID_BETA, WIDTH * HEIGHT, WIDTH * HEIGHT * 2);
  ice.fill(ICE_BETA, WIDTH * HEIGHT * 3, WIDTH * HEIGHT * 4);
  return {
    width: WIDTH,
    height: HEIGHT,
    layerEdgesM: new Float32Array(EDGES_M),
    liquidExtinctionPerM: liquid,
    iceExtinctionPerM: ice,
  };
}

// 局所 ENU の端点を、正規化空間の直線光路へ写す。
function localRay(
  fromEastM: number, fromNorthM: number, fromAltM: number,
  toEastM: number, toNorthM: number, toAltM: number,
  f: CloudLocalFieldFrame,
): { readonly positionN: ReturnType<typeof v3>; readonly directionN: ReturnType<typeof v3> } {
  const fromDir = cloudLocalDirectionAt(fromEastM, fromNorthM, f);
  const toDir = cloudLocalDirectionAt(toEastM, toNorthM, f);
  const fromR = 1 + fromAltM / f.sphereRadiusM;
  const toR = 1 + toAltM / f.sphereRadiusM;
  const from = v3(fromDir.x * fromR, fromDir.y * fromR, fromDir.z * fromR);
  const to = v3(toDir.x * toR, toDir.y * toR, toDir.z * toR);
  const delta = v3(to.x - from.x, to.y - from.y, to.z - from.z);
  const length = Math.hypot(delta.x, delta.y, delta.z);
  return {
    positionN: from,
    directionN: v3(delta.x / length, delta.y / length, delta.z / length),
  };
}

export function register(): void {
  test('cloud local field: validates the frame contract', () => {
    assert.doesNotThrow(() => validateCloudLocalFieldFrame(frame()));
    assert.throws(() => validateCloudLocalFieldFrame({
      ...frame(), eastDirection: v3(0, 1, 0),
    }), /orthogonal|unit vector/);
    assert.throws(() => validateCloudLocalFieldFrame({
      ...frame(), layerEdgesM: [0, 1, 3, 3, 6, 8],
    }), /strictly increasing/);
    assert.throws(() => validateCloudLocalFieldFrame({
      ...frame(), layerEdgesM: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    }), /between 1 and 8 layers/);
    assert.throws(() => validateCloudLocalFieldFrame({
      ...frame(), centerDirection: v3(0, 0, 2),
    }), /unit vector/);
  });

  test('cloud local field: log-map projects directions onto the tangent grid', () => {
    const f = frame();
    const center = cloudLocalUvAt(f.centerDirection, f)!;
    assert.ok(Math.abs(center.u - 0.5) < 1e-12);
    assert.ok(Math.abs(center.v - 0.5) < 1e-12);
    // 逆写像からの往復で uv が戻る。
    for (const [eastM, northM] of [[4_000, 0], [0, -2_000], [-3_250, 6_100]]) {
      const direction = cloudLocalDirectionAt(eastM, northM, f);
      const uv = cloudLocalUvAt(direction, f)!;
      const spanEast = WIDTH * CELL_M;
      const spanNorth = HEIGHT * CELL_M;
      assert.ok(Math.abs(uv.u * spanEast - (eastM + spanEast / 2)) < 1e-6);
      assert.ok(Math.abs(uv.v * spanNorth - (northM + spanNorth / 2)) < 1e-6);
      assert.ok(Math.abs(uv.eastM - eastM) < 1e-6);
      assert.ok(Math.abs(uv.northM - northM) < 1e-6);
    }
    // 有効角距離を超える方向は領域外。
    assert.equal(cloudLocalUvAt(v3(1, 0, 0), f), null);
  });

  test('cloud local field: layer selection keeps lower edges and top edge', () => {
    const f = frame();
    assert.equal(cloudLocalLayerIndexAt(0, f), 0);
    assert.equal(cloudLocalLayerIndexAt(999, f), 0);
    // 内部境界は上側の層へ属する。
    assert.equal(cloudLocalLayerIndexAt(1_000, f), 1);
    assert.equal(cloudLocalLayerIndexAt(3_000, f), 2);
    assert.equal(cloudLocalLayerIndexAt(6_000, f), 3);
    // 最上端は最終層。
    assert.equal(cloudLocalLayerIndexAt(8_000, f), 3);
    assert.equal(cloudLocalLayerIndexAt(-1, f), null);
    assert.equal(cloudLocalLayerIndexAt(8_001, f), null);
  });

  test('cloud local field: cpu point samples match the volume and mask outside', () => {
    const f = frame();
    const data = uniformLayeredData();
    const center = sampleCloudLocalFieldCpu(data, f.centerDirection, 1_500, f);
    assert.ok(Math.abs(center.liquidExtinctionPerM - LIQUID_BETA) < 1e-9);
    assert.equal(center.iceExtinctionPerM, 0);
    const upper = sampleCloudLocalFieldCpu(data, f.centerDirection, 7_000, f);
    assert.equal(upper.liquidExtinctionPerM, 0);
    assert.ok(Math.abs(upper.iceExtinctionPerM - ICE_BETA) < 1e-9);
    // 空隙層は透明。
    const gap = sampleCloudLocalFieldCpu(data, f.centerDirection, 4_500, f);
    assert.equal(gap.liquidExtinctionPerM, 0);
    assert.equal(gap.iceExtinctionPerM, 0);
    // 高度外・領域外は透明。
    const outside = sampleCloudLocalFieldCpu(data, v3(1, 0, 0), 1_500, f);
    assert.equal(outside.liquidExtinctionPerM, 0);
    assert.equal(sampleCloudLocalFieldCpu(data, f.centerDirection, 9_000, f).iceExtinctionPerM, 0);
    // 場と frame の層境界がずれていると層選びが食い違うので拒否する。
    const shifted = { ...data, layerEdgesM: new Float32Array([0, 2_000, 4_000, 6_000, 8_000]) };
    assert.throws(
      () => sampleCloudLocalFieldCpu(shifted, f.centerDirection, 1_500, f),
      /layer edges/,
    );
  });

  test('cloud local field: cpu ray integration matches analytic optical depths', () => {
    const f = frame();
    const data = uniformLayeredData();
    // 垂直レイ: 液水 2000 m × 2e-4 = 0.4、氷 2000 m × 1e-4 = 0.2。
    const vertical = localRay(0, 0, 0, 0, 0, 9_000, f);
    const verticalPath = integrateCloudLocalFieldRayCpu(
      vertical.positionN, vertical.directionN, data, f, 64,
    );
    assert.ok(Math.abs(verticalPath.liquidTau - 0.4) < 1e-6);
    assert.ok(Math.abs(verticalPath.iceTau - 0.2) < 1e-6);
    assert.ok(Math.abs(verticalPath.totalTau - 0.6) < 1e-6);
    assert.ok(Math.abs(verticalPath.transmittance - Math.exp(-0.6)) < 1e-6);
    // 45 度レイ: 高度差と東距離が同じなので光路はほぼ sqrt(2) 倍。正規化空間の直線は
    // ENU の 45 度とわずかにずれるので、解析値とはおおよその一致を見る。
    const slanted = localRay(0, 0, 0, 9_000, 0, 9_000, f);
    const slantedPath = integrateCloudLocalFieldRayCpu(
      slanted.positionN, slanted.directionN, data, f, 64,
    );
    assert.ok(Math.abs(slantedPath.totalTau - 0.6 * Math.SQRT2) < 5e-3);
    // 領域外のレイは透過率 1。中心から 0.05 rad 離れた方向へ真上に出す。
    const outsideDir = v3(Math.sin(0.05), 0, Math.cos(0.05));
    const outsidePos = v3(
      outsideDir.x * 1.000_08, outsideDir.y * 1.000_08, outsideDir.z * 1.000_08,
    );
    const outsidePath = integrateCloudLocalFieldRayCpu(
      outsidePos, outsideDir, data, f, 64,
    );
    assert.equal(outsidePath.totalTau, 0);
    assert.equal(outsidePath.transmittance, 1);
    // 層境界の不一致も拒否する。
    const shifted = { ...data, layerEdgesM: new Float32Array([0, 1_000, 3_000, 6_000]) };
    assert.throws(
      () => integrateCloudLocalFieldRayCpu(vertical.positionN, vertical.directionN, shifted, f, 64),
      /layer edges/,
    );
  });

  test('cloud local field: horizontal rays are limited to the angular domain', () => {
    const f = frame();
    const data = uniformLayeredData();
    // 液水層の中を横切る光路。格子域は ±8000 m、有効角距離は ±63.7 km なので、
    // 格子の幅ぶんだけ積分される。
    const ray = localRay(-20_000, 0, 1_500, 20_000, 0, 1_500, f);
    const path = integrateCloudLocalFieldRayCpu(
      ray.positionN, ray.directionN, data, f, 128,
    );
    assert.ok(Math.abs(path.liquidTau - LIQUID_BETA * 16_000) / (LIQUID_BETA * 16_000) < 0.05);
    assert.equal(path.iceTau, 0);
  });

  test('cloud local field: sampler builds TSL graphs for point and path sampling', () => {
    const sampler = new CloudLocalFieldSampler();
    const texture = new THREE.DataArrayTexture(
      new Float32Array(WIDTH * HEIGHT * 4 * 2), WIDTH, HEIGHT, 4,
    );
    try {
      sampler.bind(null);
      sampler.bind({ texture, frame: frame() });
      const point = sampler.sampleLocalOptical(vec3(0, 0, 1), float(1_500));
      const path = sampler.localOpticalPathAt(vec3(0, 0, 1), vec3(0, 0, 1), 16);
      assert.ok(point.liquidExtinctionPerM);
      assert.ok(point.iceExtinctionPerM);
      assert.ok(path);
      assert.throws(
        () => sampler.bind({ texture, frame: { ...frame(), gridWidth: WIDTH / 2 } }),
        /match the frame grid/,
      );
      assert.throws(
        () => sampler.bind({ texture, frame: { ...frame(), layerEdgesM: [0, 4_000] } }),
        /match the frame layer count/,
      );
    } finally {
      texture.dispose();
    }
  });
}
