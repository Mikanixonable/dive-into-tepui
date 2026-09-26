// 生成雲の相別消散係数を、不変な高度層付き配列テクスチャとして保持する。
import * as THREE from 'three/webgpu';
import { clamp, float, int, texture } from 'three/tsl';
import type { FloatNode, Vec2Node } from '../tsl-types';

export interface CloudOpticalVolumeData {
  readonly width: number;
  readonly height: number;
  // 連続する層の境界 [m]。各層は下端を含み、内部境界は上側の層に属する。
  readonly layerEdgesM: Float32Array;
  // 高度層、行、列の順。値は液水または氷の消散係数 [m^-1]。
  readonly liquidExtinctionPerM: Float32Array;
  readonly iceExtinctionPerM: Float32Array;
}

export interface CloudOpticalVolumeSample {
  readonly liquidExtinctionPerM: number;
  readonly iceExtinctionPerM: number;
}

export type CloudOpticalVolumeStorageFormat = 'rg32f' | 'rg16f';

export interface CloudOpticalVolumeHalfFloatPhaseDiagnostics {
  readonly positiveValueCount: number;
  readonly zeroRoundedPositiveCount: number;
  readonly maximumInputRoundedToZeroPerM: number;
  readonly maximumSingleZeroRoundedOpticalDepthContributionAt20Km: number;
  // 独立した texel 全体の合計 — 1本の物理的な 20 km 光路ではない。
  readonly sumAcrossTexelsOfZeroRoundedOpticalDepthContributionsAt20Km: number;
}

export interface CloudOpticalVolumeHalfFloatEncoding {
  readonly interleaved: Uint16Array;
  readonly liquidRoundTripPerM: Float32Array;
  readonly iceRoundTripPerM: Float32Array;
  readonly diagnosticsByPhase: Readonly<Record<'liquid' | 'ice', CloudOpticalVolumeHalfFloatPhaseDiagnostics>>;
}

const HALF_FLOAT_DIAGNOSTIC_PATH_LENGTH_M = 20_000; // 診断光路長 [m]。

// THREE.DataUtils.toHalfFloat と同じビット切り捨て結果を返す。
export function encodeCloudOpticalVolumeHalfFloat(
  liquidPerM: Float32Array,
  icePerM: Float32Array,
): CloudOpticalVolumeHalfFloatEncoding {
  if (!(liquidPerM instanceof Float32Array) || !(icePerM instanceof Float32Array)
    || liquidPerM.length !== icePerM.length) {
    throw new RangeError('half-float phase arrays must be equally sized Float32Arrays');
  }
  if (!Number.isSafeInteger(liquidPerM.length * 2)) {
    throw new RangeError('half-float texture element count is too large');
  }
  const maximumFiniteHalfFloat = 65_504;
  const interleaved = new Uint16Array(liquidPerM.length * 2);
  const liquidRoundTripPerM = new Float32Array(liquidPerM.length);
  const iceRoundTripPerM = new Float32Array(icePerM.length);
  const liquidStats = { positiveValueCount: 0, zeroRoundedPositiveCount: 0,
    maximumInputRoundedToZeroPerM: 0, maximumSingleZeroRoundedOpticalDepthContributionAt20Km: 0,
    sumAcrossTexelsOfZeroRoundedOpticalDepthContributionsAt20Km: 0 };
  const iceStats = { positiveValueCount: 0, zeroRoundedPositiveCount: 0,
    maximumInputRoundedToZeroPerM: 0, maximumSingleZeroRoundedOpticalDepthContributionAt20Km: 0,
    sumAcrossTexelsOfZeroRoundedOpticalDepthContributionsAt20Km: 0 };
  for (let index = 0; index < liquidPerM.length; index += 1) {
    const liquidValue = liquidPerM[index]!;
    const iceValue = icePerM[index]!;
    if (!Number.isFinite(liquidValue) || liquidValue < 0 || liquidValue > maximumFiniteHalfFloat) {
      throw new RangeError('liquid extinction must be finite, non-negative, and within Float16 range');
    }
    if (!Number.isFinite(iceValue) || iceValue < 0 || iceValue > maximumFiniteHalfFloat) {
      throw new RangeError('ice extinction must be finite, non-negative, and within Float16 range');
    }
    if (liquidValue > 0) liquidStats.positiveValueCount += 1;
    if (iceValue > 0) iceStats.positiveValueCount += 1;
    const liquidHalf = THREE.DataUtils.toHalfFloat(liquidValue);
    const iceHalf = THREE.DataUtils.toHalfFloat(iceValue);
    const liquidRoundTrip = THREE.DataUtils.fromHalfFloat(liquidHalf);
    const iceRoundTrip = THREE.DataUtils.fromHalfFloat(iceHalf);
    if (!Number.isFinite(liquidRoundTrip) || !Number.isFinite(iceRoundTrip)) {
      throw new RangeError('extinction values must remain finite in Float16');
    }
    interleaved[index * 2] = liquidHalf;
    interleaved[index * 2 + 1] = iceHalf;
    liquidRoundTripPerM[index] = liquidRoundTrip;
    iceRoundTripPerM[index] = iceRoundTrip;
    if (liquidValue > 0 && liquidRoundTrip === 0) {
      liquidStats.zeroRoundedPositiveCount += 1;
      liquidStats.maximumInputRoundedToZeroPerM = Math.max(liquidStats.maximumInputRoundedToZeroPerM, liquidValue);
      const opticalDepthContribution = liquidValue * HALF_FLOAT_DIAGNOSTIC_PATH_LENGTH_M;
      liquidStats.maximumSingleZeroRoundedOpticalDepthContributionAt20Km = Math.max(
        liquidStats.maximumSingleZeroRoundedOpticalDepthContributionAt20Km, opticalDepthContribution,
      );
      liquidStats.sumAcrossTexelsOfZeroRoundedOpticalDepthContributionsAt20Km += opticalDepthContribution;
    }
    if (iceValue > 0 && iceRoundTrip === 0) {
      iceStats.zeroRoundedPositiveCount += 1;
      iceStats.maximumInputRoundedToZeroPerM = Math.max(iceStats.maximumInputRoundedToZeroPerM, iceValue);
      const opticalDepthContribution = iceValue * HALF_FLOAT_DIAGNOSTIC_PATH_LENGTH_M;
      iceStats.maximumSingleZeroRoundedOpticalDepthContributionAt20Km = Math.max(
        iceStats.maximumSingleZeroRoundedOpticalDepthContributionAt20Km, opticalDepthContribution,
      );
      iceStats.sumAcrossTexelsOfZeroRoundedOpticalDepthContributionsAt20Km += opticalDepthContribution;
    }
  }
  return {
    interleaved,
    liquidRoundTripPerM,
    iceRoundTripPerM,
    diagnosticsByPhase: { liquid: liquidStats, ice: iceStats },
  };
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
}

function requireExtinction(values: Float32Array, expectedLength: number, label: string): void {
  if (!(values instanceof Float32Array) || values.length !== expectedLength) {
    throw new RangeError(`${label} must be a Float32Array of the required size`);
  }
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be finite and non-negative`);
  }
}

function layerIndexAt(altitudeM: number, edgesM: Float32Array): number {
  if (!Number.isFinite(altitudeM)) throw new RangeError('altitudeM must be finite');
  if (altitudeM < edgesM[0]! || altitudeM > edgesM[edgesM.length - 1]!) {
    throw new RangeError('altitudeM is outside the cloud optical volume');
  }
  if (altitudeM === edgesM[edgesM.length - 1]) return edgesM.length - 2;
  let lower = 0;
  let upper = edgesM.length - 1;
  while (lower + 1 < upper) {
    const middle = (lower + upper) >>> 1;
    if (altitudeM < edgesM[middle]!) upper = middle;
    else lower = middle;
  }
  return lower;
}

// DataArrayTexture の正規化UVに対する LinearFilter と同じ、端を複製するxy双線形標本。
function sampleChannel(
  values: Float32Array, width: number, height: number, layer: number,
  u: number, v: number,
): number {
  const x = Math.min(Math.max(u, 0), 1) * width - 0.5;
  const y = Math.min(Math.max(v, 0), 1) * height - 0.5;
  const x0raw = Math.floor(x);
  const y0raw = Math.floor(y);
  const tx = x - x0raw;
  const ty = y - y0raw;
  const x0 = Math.min(Math.max(x0raw, 0), width - 1);
  const x1 = Math.min(Math.max(x0raw + 1, 0), width - 1);
  const y0 = Math.min(Math.max(y0raw, 0), height - 1);
  const y1 = Math.min(Math.max(y0raw + 1, 0), height - 1);
  const planeOffset = layer * width * height;
  const a = values[planeOffset + y0 * width + x0]!;
  const b = values[planeOffset + y0 * width + x1]!;
  const c = values[planeOffset + y1 * width + x0]!;
  const d = values[planeOffset + y1 * width + x1]!;
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

// CPU側の層選択と双線形標本。xyは連続、zは高度境界で離散的に切り替わる。
export function sampleCloudOpticalVolumeCpu(
  data: CloudOpticalVolumeData, u: number, v: number, altitudeM: number,
): CloudOpticalVolumeSample {
  validateCloudOpticalVolumeData(data);
  return sampleValidatedCloudOpticalVolume(data, u, v, altitudeM);
}

function sampleValidatedCloudOpticalVolume(
  data: CloudOpticalVolumeData, u: number, v: number, altitudeM: number,
): CloudOpticalVolumeSample {
  const { width, height, layerEdgesM, liquidExtinctionPerM, iceExtinctionPerM } = data;
  if (!Number.isFinite(u) || !Number.isFinite(v)) throw new RangeError('uv must be finite');
  const layer = layerIndexAt(altitudeM, layerEdgesM);
  return {
    liquidExtinctionPerM: sampleChannel(liquidExtinctionPerM, width, height, layer, u, v),
    iceExtinctionPerM: sampleChannel(iceExtinctionPerM, width, height, layer, u, v),
  };
}

// 場の寸法・層境界・相別の消散配列の形を検査する。
export function validateCloudOpticalVolumeData(data: CloudOpticalVolumeData): void {
  requirePositiveInteger(data.width, 'width');
  requirePositiveInteger(data.height, 'height');
  if (!(data.layerEdgesM instanceof Float32Array) || data.layerEdgesM.length < 2) {
    throw new RangeError('layerEdgesM must contain at least two Float32 boundaries');
  }
  for (let index = 0; index < data.layerEdgesM.length; index += 1) {
    const edge = data.layerEdgesM[index]!;
    if (!Number.isFinite(edge) || edge < 0 || (index > 0 && edge <= data.layerEdgesM[index - 1]!)) {
      throw new RangeError('layerEdgesM must be non-negative, finite, and strictly increasing');
    }
  }
  const texelCount = data.width * data.height * (data.layerEdgesM.length - 1);
  if (!Number.isSafeInteger(texelCount)) throw new RangeError('cloud optical volume dimensions are too large');
  requireExtinction(data.liquidExtinctionPerM, texelCount, 'liquidExtinctionPerM');
  requireExtinction(data.iceExtinctionPerM, texelCount, 'iceExtinctionPerM');
}

// texture().depth(int(layer)) はearth-surfaceと同じ離散層アクセスを行い、層間補間はしない。
export function sampleCloudOpticalVolumeNode(
  volume: THREE.DataArrayTexture, uv: Vec2Node, layer: FloatNode,
): { readonly liquidExtinctionPerM: FloatNode; readonly iceExtinctionPerM: FloatNode } {
  const depth = (volume.image as { readonly depth: number }).depth;
  const sample = texture(volume, uv).depth(int(clamp(layer, 0, depth - 1))).level(float(0));
  return { liquidExtinctionPerM: sample.r, iceExtinctionPerM: sample.g };
}

export class CloudOpticalVolume {
  public readonly texture: THREE.DataArrayTexture;
  public readonly width: number;
  public readonly height: number;
  public readonly depth: number;
  // 単一mipのGPUデータ本体と、所有者が保持するCPUの相別配列・層境界の合計。
  public readonly estimatedGpuBaseLevelBytes: number;
  public readonly cpuBackingBytes: number;
  public readonly storageFormat: CloudOpticalVolumeStorageFormat;
  public readonly halfFloatDiagnosticsByPhase: CloudOpticalVolumeHalfFloatEncoding['diagnosticsByPhase'] | null;
  private readonly data: CloudOpticalVolumeData;
  private disposed = false;

  // 入力を複製し、GPU資源をこの所有者の寿命へ閉じる。相別RG textureへ選択形式で渡す。
  public constructor(
    source: CloudOpticalVolumeData,
    options: { readonly storageFormat?: CloudOpticalVolumeStorageFormat } = {},
  ) {
    validateCloudOpticalVolumeData(source);
    this.storageFormat = options.storageFormat ?? 'rg32f';
    if (this.storageFormat !== 'rg32f' && this.storageFormat !== 'rg16f') {
      throw new RangeError('unsupported cloud optical volume storage format');
    }
    this.width = source.width;
    this.height = source.height;
    this.depth = source.layerEdgesM.length - 1;
    const halfEncoding = this.storageFormat === 'rg16f'
      ? encodeCloudOpticalVolumeHalfFloat(source.liquidExtinctionPerM, source.iceExtinctionPerM)
      : null;
    this.halfFloatDiagnosticsByPhase = halfEncoding?.diagnosticsByPhase ?? null;
    this.data = {
      width: source.width,
      height: source.height,
      layerEdgesM: source.layerEdgesM.slice(),
      liquidExtinctionPerM: halfEncoding?.liquidRoundTripPerM ?? source.liquidExtinctionPerM.slice(),
      iceExtinctionPerM: halfEncoding?.iceRoundTripPerM ?? source.iceExtinctionPerM.slice(),
    };
    let interleaved: Float32Array | Uint16Array;
    if (halfEncoding !== null) {
      interleaved = halfEncoding.interleaved;
    } else {
      const fullFloatInterleaved = new Float32Array(source.width * source.height * this.depth * 2);
      for (let index = 0; index < source.liquidExtinctionPerM.length; index += 1) {
        fullFloatInterleaved[index * 2] = source.liquidExtinctionPerM[index]!;
        fullFloatInterleaved[index * 2 + 1] = source.iceExtinctionPerM[index]!;
      }
      interleaved = fullFloatInterleaved;
    }
    this.estimatedGpuBaseLevelBytes = interleaved.byteLength;
    this.cpuBackingBytes = this.data.layerEdgesM.byteLength
      + this.data.liquidExtinctionPerM.byteLength + this.data.iceExtinctionPerM.byteLength
      + interleaved.byteLength;
    const texture = new THREE.DataArrayTexture(interleaved, source.width, source.height, this.depth);
    texture.name = `generated-cloud-optical-volume-${this.storageFormat}`;
    texture.format = THREE.RGFormat;
    texture.type = this.storageFormat === 'rg16f' ? THREE.HalfFloatType : THREE.FloatType;
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    this.texture = texture;
  }

  public get layerEdgesM(): Float32Array { return this.data.layerEdgesM.slice(); }

  // CPU 側の層選択と双線形標本。
  public sampleCpu(u: number, v: number, altitudeM: number): CloudOpticalVolumeSample {
    this.requireActive();
    return sampleValidatedCloudOpticalVolume(this.data, u, v, altitudeM);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.texture.dispose();
  }

  private requireActive(): void {
    if (this.disposed) throw new Error('Cloud optical volume is disposed');
  }
}
