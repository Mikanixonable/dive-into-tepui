import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {
  CloudOpticalVolume, sampleCloudOpticalVolumeCpu, validateCloudOpticalVolumeData,
  type CloudOpticalVolumeData,
} from '../../src/render/cloud/cloud-optical-volume';
import { test } from '../harness';

const DATA: CloudOpticalVolumeData = {
  width: 2,
  height: 2,
  layerEdgesM: new Float32Array([0, 100, 300]),
  // 各層の行優先。液水と氷を別配列のまま入力する。
  liquidExtinctionPerM: new Float32Array([1, 2, 3, 4, 10, 20, 30, 40]),
  iceExtinctionPerM: new Float32Array([5, 6, 7, 8, 50, 60, 70, 80]),
};

function textureData(volume: CloudOpticalVolume): Float32Array {
  return (volume.texture.image as { readonly data: Float32Array }).data;
}

export function register(): void {
  test('cloud optical volume: packs phase pairs by discrete altitude layer into RG32F DataArrayTexture', () => {
    const source: CloudOpticalVolumeData = {
      ...DATA,
      layerEdgesM: DATA.layerEdgesM.slice(),
      liquidExtinctionPerM: DATA.liquidExtinctionPerM.slice(),
      iceExtinctionPerM: DATA.iceExtinctionPerM.slice(),
    };
    const volume = new CloudOpticalVolume(source);
    try {
      source.layerEdgesM[1] = 250;
      source.liquidExtinctionPerM[0] = 999;
      const copiedEdges = volume.layerEdgesM;
      copiedEdges[1] = 275;
      assert.deepEqual(Array.from(volume.layerEdgesM), [0, 100, 300]);
      assert.equal(volume.texture.isDataArrayTexture, true);
      assert.equal(volume.texture.format, THREE.RGFormat);
      assert.equal(volume.texture.type, THREE.FloatType);
      assert.equal(volume.width, 2);
      assert.equal(volume.height, 2);
      assert.equal(volume.depth, 2);
      const gpuBytes = 2 * 2 * 2 * 2 * Float32Array.BYTES_PER_ELEMENT;
      const sourceBytes = 2 * 2 * 2 * 2 * Float32Array.BYTES_PER_ELEMENT
        + 3 * Float32Array.BYTES_PER_ELEMENT;
      assert.equal(volume.estimatedGpuBaseLevelBytes, gpuBytes);
      assert.equal(volume.cpuBackingBytes, gpuBytes + sourceBytes);
      assert.deepEqual(Array.from(textureData(volume)), [
        1, 5, 2, 6, 3, 7, 4, 8,
        10, 50, 20, 60, 30, 70, 40, 80,
      ]);
      assert.deepEqual(Array.from(volume.layerEdgesM), [0, 100, 300]);
    } finally {
      volume.dispose();
      volume.dispose();
    }
  });

  test('cloud optical volume: xy samples are bilinear and altitude layers are discrete', () => {
    const volume = new CloudOpticalVolume(DATA);
    try {
      assert.deepEqual(volume.sampleCpu(0.5, 0.5, 0), {
        liquidExtinctionPerM: 2.5,
        iceExtinctionPerM: 6.5,
      });
      assert.deepEqual(volume.sampleCpu(0.5, 0.5, 100), {
        liquidExtinctionPerM: 25,
        iceExtinctionPerM: 65,
      });
      assert.deepEqual(volume.sampleCpu(0, 0, 99.999), {
        liquidExtinctionPerM: 1,
        iceExtinctionPerM: 5,
      });
      assert.deepEqual(volume.sampleCpu(1, 1, 300), {
        liquidExtinctionPerM: 40,
        iceExtinctionPerM: 80,
      });
      assert.throws(() => volume.sampleCpu(0, 0, -0.001), RangeError);
      assert.throws(() => volume.sampleCpu(0, 0, 300.001), RangeError);
    } finally {
      volume.dispose();
    }
  });

  test('cloud optical volume: rejects invalid dimensions, altitude edges, phase lengths, and coefficients', () => {
    validateCloudOpticalVolumeData(DATA);
    assert.throws(() => new CloudOpticalVolume({ ...DATA, width: 0 }), RangeError);
    assert.throws(() => new CloudOpticalVolume({
      ...DATA, layerEdgesM: new Float32Array([0, 100, 100]),
    }), RangeError);
    assert.throws(() => new CloudOpticalVolume({
      ...DATA, layerEdgesM: new Float32Array([-1, 100, 300]),
    }), RangeError);
    assert.throws(() => new CloudOpticalVolume({
      ...DATA, liquidExtinctionPerM: [1, 2, 3, 4, 10, 20, 30, 40] as unknown as Float32Array,
    }), RangeError);
    assert.throws(() => new CloudOpticalVolume({
      ...DATA, iceExtinctionPerM: new Float32Array(7),
    }), RangeError);
    assert.throws(() => new CloudOpticalVolume({
      ...DATA, liquidExtinctionPerM: new Float32Array([1, 2, 3, 4, 10, 20, -1, 40]),
    }), RangeError);
    assert.throws(() => new CloudOpticalVolume({
      ...DATA, iceExtinctionPerM: new Float32Array([5, 6, 7, 8, 50, 60, Number.NaN, 80]),
    }), RangeError);
  });

  test('cloud optical volume: CPU oracle preserves zero phase and accepts exterior UV by edge clamp', () => {
    const data: CloudOpticalVolumeData = {
      width: 1,
      height: 1,
      layerEdgesM: new Float32Array([0, 1]),
      liquidExtinctionPerM: new Float32Array([0]),
      iceExtinctionPerM: new Float32Array([0.25]),
    };
    assert.deepEqual(sampleCloudOpticalVolumeCpu(data, -2, 3, 0.5), {
      liquidExtinctionPerM: 0,
      iceExtinctionPerM: 0.25,
    });
  });
}
