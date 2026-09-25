import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {
  CloudOpticalVolume, encodeCloudOpticalVolumeHalfFloat,
  sampleCloudOpticalVolumeCpu, validateCloudOpticalVolumeData,
  type CloudOpticalVolumeData,
} from '../../src/render/cloud/cloud-optical-volume';
import { sampleEventOpticalVolume } from '../../tools/render-lab/cloud-event-optical-volume-case';
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

function halfTextureData(volume: CloudOpticalVolume): Uint16Array {
  return (volume.texture.image as { readonly data: Uint16Array }).data;
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
      assert.equal(volume.storageFormat, 'rg32f');
      assert.equal(volume.halfFloatDiagnosticsByPhase, null);
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

  test('cloud optical volume: optional RG16F packs independent phase values and accounts for owned memory', () => {
    const volume = new CloudOpticalVolume(DATA, { storageFormat: 'rg16f' });
    try {
      assert.equal(volume.texture.format, THREE.RGFormat);
      assert.equal(volume.texture.type, THREE.HalfFloatType);
      assert.equal(volume.texture.isDataArrayTexture, true);
      assert.equal(volume.storageFormat, 'rg16f');
      const expected = Array.from(DATA.liquidExtinctionPerM).flatMap((liquid, index) => [
        THREE.DataUtils.toHalfFloat(liquid),
        THREE.DataUtils.toHalfFloat(DATA.iceExtinctionPerM[index]!),
      ]);
      assert.deepEqual(Array.from(halfTextureData(volume)), expected);
      const texelCount = DATA.width * DATA.height * 2;
      const halfUploadBytes = texelCount * 2 * Uint16Array.BYTES_PER_ELEMENT;
      const ownedCpuBytes = DATA.layerEdgesM.byteLength
        + DATA.liquidExtinctionPerM.byteLength + DATA.iceExtinctionPerM.byteLength
        + halfUploadBytes;
      assert.equal(volume.estimatedGpuBaseLevelBytes, halfUploadBytes);
      assert.equal(volume.cpuBackingBytes, ownedCpuBytes);
      assert.equal(volume.estimatedGpuBaseLevelBytes * 2, 2 * 2 * 2 * 2 * Float32Array.BYTES_PER_ELEMENT);
      assert.deepEqual(volume.sampleCpu(0.5, 0.5, 100), {
        liquidExtinctionPerM: 25, iceExtinctionPerM: 65,
      });
    } finally {
      volume.dispose();
    }
  });

  test('cloud optical volume: RG16F event-scale, thin, and thick samples meet the fixed 20 km optical-depth gate', () => {
    const eventLiquidPerM = 1.4682237e-6;
    const eventIcePerM = 3.0590641e-6;
    const liquid = new Float32Array([
      1e-8, 2e-8, 3e-8, 1e-6, eventLiquidPerM, 1e-4, 1e-2,
    ]);
    const ice = new Float32Array([
      2e-8, 1e-8, 4e-8, 8e-7, eventIcePerM, 2e-4, 8e-3,
    ]);
    const encoded = encodeCloudOpticalVolumeHalfFloat(liquid, ice);
    assert.equal(encoded.liquidRoundTripPerM[4], 1.430511474609375e-6);
    assert.equal(encoded.iceRoundTripPerM[4], 3.039836883544922e-6);
    assert.ok(Math.abs((encoded.liquidRoundTripPerM[4]! - eventLiquidPerM) * 20_000
      + 0.0007542445) < 1e-8);
    assert.ok(Math.abs((encoded.iceRoundTripPerM[4]! - eventIcePerM) * 20_000
      + 0.0003845443) < 1e-8);
    assert.ok(Math.abs((encoded.liquidRoundTripPerM[6]! - liquid[6]!) * 20_000
      + 0.1098588109) < 1e-8);
    for (const [source, roundTrip] of [
      [liquid, encoded.liquidRoundTripPerM], [ice, encoded.iceRoundTripPerM],
    ] as const) {
      for (let index = 0; index < source.length; index += 1) {
        const sourceTau = source[index]! * 20_000;
        const roundTripTau = roundTrip[index]! * 20_000;
        if (sourceTau <= 0.5) {
          assert.ok(Math.abs(roundTripTau - sourceTau) <= 0.005,
            `low-tau source ${sourceTau} became ${roundTripTau}`);
        } else {
          assert.ok(Math.abs(roundTripTau - sourceTau) / sourceTau <= 0.01,
            `high-tau source ${sourceTau} became ${roundTripTau}`);
        }
      }
    }
    for (const [phase, maximumInputRoundedToZeroPerM, singleTau, totalTau] of [
      ['liquid', 3e-8, 0.0006, 0.0012], ['ice', 4e-8, 0.0008, 0.0014],
    ] as const) {
      const stats = encoded.diagnosticsByPhase[phase];
      assert.equal(stats.positiveValueCount, 7);
      assert.equal(stats.zeroRoundedPositiveCount, 3);
      assert.ok(Math.abs(stats.maximumInputRoundedToZeroPerM - maximumInputRoundedToZeroPerM) < 1e-14);
      assert.ok(Math.abs(stats.maximumSingleZeroRoundedOpticalDepthContributionAt20Km - singleTau) < 1e-8);
      assert.ok(Math.abs(stats.sumAcrossTexelsOfZeroRoundedOpticalDepthContributionsAt20Km - totalTau) < 1e-8);
    }
  });

  test('cloud optical volume: sampled-event tile values meet the fixed low-tau gate and report zero rounding', () => {
    const eventData = sampleEventOpticalVolume();
    const encoded = encodeCloudOpticalVolumeHalfFloat(
      eventData.liquidExtinctionPerM, eventData.iceExtinctionPerM,
    );
    const fullPrecisionVolume = new CloudOpticalVolume(eventData);
    const halfPrecisionVolume = new CloudOpticalVolume(eventData, { storageFormat: 'rg16f' });
    try {
      const uploadBytes = eventData.liquidExtinctionPerM.length * 2 * Uint16Array.BYTES_PER_ELEMENT;
      const sourceBackingBytes = eventData.layerEdgesM.byteLength
        + eventData.liquidExtinctionPerM.byteLength + eventData.iceExtinctionPerM.byteLength;
      assert.equal(halfPrecisionVolume.estimatedGpuBaseLevelBytes, uploadBytes);
      assert.equal(fullPrecisionVolume.estimatedGpuBaseLevelBytes, uploadBytes * 2);
      assert.equal(halfPrecisionVolume.cpuBackingBytes, sourceBackingBytes + uploadBytes);
    } finally {
      fullPrecisionVolume.dispose();
      halfPrecisionVolume.dispose();
    }
    for (const [source, roundTrip] of [
      [eventData.liquidExtinctionPerM, encoded.liquidRoundTripPerM],
      [eventData.iceExtinctionPerM, encoded.iceRoundTripPerM],
    ] as const) {
      for (let index = 0; index < source.length; index += 1) {
        const sourceTau = source[index]! * 20_000;
        const roundTripTau = roundTrip[index]! * 20_000;
        assert.ok(sourceTau <= 0.5);
        assert.ok(Math.abs(roundTripTau - sourceTau) <= 0.005);
      }
    }
    for (const phase of ['liquid', 'ice'] as const) {
      const stats = encoded.diagnosticsByPhase[phase];
      assert.ok(stats.positiveValueCount > 0);
      assert.ok(stats.zeroRoundedPositiveCount > 0);
      assert.ok(stats.maximumInputRoundedToZeroPerM > 0);
      assert.ok(stats.maximumSingleZeroRoundedOpticalDepthContributionAt20Km > 0);
      assert.ok(stats.sumAcrossTexelsOfZeroRoundedOpticalDepthContributionsAt20Km
        >= stats.maximumSingleZeroRoundedOpticalDepthContributionAt20Km);
    }
  });

  test('cloud optical volume: RG16F rejects non-finite/out-of-range coefficients but reports finite underflow', () => {
    assert.throws(() => encodeCloudOpticalVolumeHalfFloat(
      new Float32Array([Number.NaN]), new Float32Array([0]),
    ), RangeError);
    assert.throws(() => encodeCloudOpticalVolumeHalfFloat(
      new Float32Array([70_000]), new Float32Array([0]),
    ), RangeError);
    assert.throws(() => new CloudOpticalVolume(DATA, { storageFormat: 'invalid' as 'rg16f' }), RangeError);
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
