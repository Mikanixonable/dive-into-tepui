// 相別の層消散を DataArrayTexture へ渡せる Float32 RG 入力へ並べ替える純変換。

import type { CloudExtinctionLayer } from './cloud-mass-extinction';

export interface CloudOpticalVolumeFrame {
  readonly width: number;
  readonly height: number;
  readonly layerEdgesM: Float32Array;
  readonly liquidExtinctionPerM: Float32Array;
  readonly iceExtinctionPerM: Float32Array;
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

function float32Values(values: readonly number[], name: string): Float32Array {
  const converted = Float32Array.from(values);
  for (let index = 0; index < converted.length; index += 1) {
    if (!Number.isFinite(values[index]) || values[index]! < 0 || !Number.isFinite(converted[index])) {
      throw new RangeError(`${name} must remain finite and non-negative in Float32`);
    }
  }
  return converted;
}

// extinctionFromCloudMass の layer-major cell 列を、GPU volume が読む層・行・列順のRG32Fへ写す。
export function cloudOpticalVolumeFrameFromExtinction(
  width: number,
  height: number,
  layerEdgesM: readonly number[],
  extinctionLayers: readonly CloudExtinctionLayer[],
): CloudOpticalVolumeFrame {
  requirePositiveInteger(width, 'width');
  requirePositiveInteger(height, 'height');
  const cellCount = width * height;
  if (!Number.isSafeInteger(cellCount)) throw new RangeError('optical volume dimensions are too large');
  if (layerEdgesM.length !== extinctionLayers.length + 1 || layerEdgesM.length < 2) {
    throw new RangeError('one more layer edge than extinction layers is required');
  }
  for (let index = 0; index < layerEdgesM.length; index += 1) {
    const edgeM = layerEdgesM[index]!;
    if (!Number.isFinite(edgeM) || edgeM < 0
      || (index > 0 && edgeM <= layerEdgesM[index - 1]!)) {
      throw new RangeError('layerEdgesM must be finite, non-negative, and strictly increasing');
    }
  }

  const texelCount = cellCount * extinctionLayers.length;
  if (!Number.isSafeInteger(texelCount)) throw new RangeError('optical volume dimensions are too large');
  const liquid = new Float32Array(texelCount);
  const ice = new Float32Array(texelCount);
  for (const [layerIndex, layer] of extinctionLayers.entries()) {
    if (layer.lowerAltitudeM !== layerEdgesM[layerIndex]
      || layer.upperAltitudeM !== layerEdgesM[layerIndex + 1]) {
      throw new RangeError(`extinction layer ${layerIndex} does not match layerEdgesM`);
    }
    if (layer.liquidPerMByCell.length !== cellCount || layer.icePerMByCell.length !== cellCount) {
      throw new RangeError(`extinction layer ${layerIndex} has an invalid cell count`);
    }
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      const textureIndex = layerIndex * cellCount + cellIndex;
      const liquidPerM = layer.liquidPerMByCell[cellIndex]!;
      const icePerM = layer.icePerMByCell[cellIndex]!;
      if (!Number.isFinite(liquidPerM) || liquidPerM < 0
        || !Number.isFinite(icePerM) || icePerM < 0) {
        throw new RangeError('extinction values must be finite and non-negative');
      }
      liquid[textureIndex] = liquidPerM;
      ice[textureIndex] = icePerM;
      if (!Number.isFinite(liquid[textureIndex]) || !Number.isFinite(ice[textureIndex])
        || (liquidPerM > 0 && liquid[textureIndex] === 0)
        || (icePerM > 0 && ice[textureIndex] === 0)) {
        throw new RangeError('extinction values must remain finite and non-zero when positive in Float32');
      }
    }
  }
  const float32LayerEdgesM = float32Values(layerEdgesM, 'layerEdgesM');
  for (let index = 1; index < float32LayerEdgesM.length; index += 1) {
    if (float32LayerEdgesM[index]! <= float32LayerEdgesM[index - 1]!) {
      throw new RangeError('layerEdgesM must remain strictly increasing in Float32');
    }
  }
  return {
    width,
    height,
    layerEdgesM: float32LayerEdgesM,
    liquidExtinctionPerM: liquid,
    iceExtinctionPerM: ice,
  };
}
