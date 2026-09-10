// 実データが利用できない環境へ、月次RGBA気候入力の決定的なfallbackを供給する。
import * as THREE from 'three/webgpu';
import { configureClimateTexture } from './climate-map';
import {
  MonthlyClimateMap, MONTHS_PER_YEAR, type ClimateUvAt, type MonthlyClimateTexture,
} from './monthly-climate-map';

export const DEVELOPMENT_CLIMATE_WIDTH = 512;
export const DEVELOPMENT_CLIMATE_HEIGHT = 256;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function byte(value: number): number {
  return Math.round(clamp01(value) * 255);
}

// 開発用の月次気候RGBAを生成する。R=気温、G=雲量、B=正高、A=陸地被覆率。
export function developmentClimateRgba(monthIndex: number): Uint8Array {
  const phase = (monthIndex / MONTHS_PER_YEAR) * Math.PI * 2;
  const pixels = new Uint8Array(DEVELOPMENT_CLIMATE_WIDTH * DEVELOPMENT_CLIMATE_HEIGHT * 4);
  for (let y = 0; y < DEVELOPMENT_CLIMATE_HEIGHT; y += 1) {
    const latitude = Math.PI * (0.5 - (y + 0.5) / DEVELOPMENT_CLIMATE_HEIGHT);
    const absLatitude = Math.abs(latitude);
    for (let x = 0; x < DEVELOPMENT_CLIMATE_WIDTH; x += 1) {
      const longitude = Math.PI * 2 * ((x + 0.5) / DEVELOPMENT_CLIMATE_WIDTH - 0.5);
      const landSignal = 0.5
        + 0.28 * Math.sin(longitude * 1.7 + Math.cos(latitude) * 0.4)
        + 0.18 * Math.sin(longitude * 3.1 - latitude * 1.5)
        + 0.08 * Math.cos(latitude * 5 + 0.7);
      const landFraction = smoothstep(0.43, 0.61, landSignal);
      const equatorialCloud = Math.exp(-((latitude / 0.22) ** 2));
      const midlatitudeCloud = Math.exp(-(((absLatitude - 0.72) / 0.24) ** 2));
      const subtropicalDry = Math.exp(-(((absLatitude - 0.42) / 0.15) ** 2));
      const wave = 0.5 + 0.5 * Math.sin(longitude * 2.2 + Math.sin(latitude * 2) + phase);
      const cloudFraction = clamp01(
        0.02 + 0.62 * equatorialCloud + 0.32 * midlatitudeCloud + 0.12 * wave
        - 0.35 * subtropicalDry - 0.1 * landFraction,
      );
      const elevation = landFraction * (150 + 2500 * (0.5 + 0.5 * Math.sin(
        longitude * 2.4 - latitude * 3.1,
      ))) - (1 - landFraction) * 80;
      const temperature = 298 - 46 * absLatitude / Math.PI + 3 * Math.sin(longitude + phase)
        - 0.006 * Math.max(elevation, 0);
      const offset = (y * DEVELOPMENT_CLIMATE_WIDTH + x) * 4;
      pixels[offset] = byte((temperature - 180) / 150);
      pixels[offset + 1] = byte(cloudFraction);
      pixels[offset + 2] = byte((elevation + 1000) / 10000);
      pixels[offset + 3] = byte(landFraction);
    }
  }
  return pixels;
}

class StaticClimateTexture implements MonthlyClimateTexture {
  public readonly texture: THREE.DataTexture;
  private disposed = false;

  public constructor(data: Uint8Array) {
    this.texture = new THREE.DataTexture(
      data, DEVELOPMENT_CLIMATE_WIDTH, DEVELOPMENT_CLIMATE_HEIGHT,
      THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    configureClimateTexture(this.texture);
    this.texture.needsUpdate = true;
  }

  public get generation(): number { return this.texture.version; }

  public request(): void {}

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.texture.dispose();
  }
}

// 実データの代わりに同じ月次・UV契約を使う気候mapを構築する。
export function createDevelopmentClimateMap(uvAt?: ClimateUvAt): MonthlyClimateMap {
  const maps = Array.from({ length: MONTHS_PER_YEAR }, (_, month) => (
    new StaticClimateTexture(developmentClimateRgba(month))
  ));
  return new MonthlyClimateMap(maps, uvAt);
}
