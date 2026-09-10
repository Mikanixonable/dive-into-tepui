// Earth surfaceの開発・Pages fixtureへ入れる、契約範囲内の決定的なRGBA気候入力を生成する。
import { encodeRgbaPng } from '../png.mjs';

export const FIXTURE_CLIMATE_WIDTH = 1024;
export const FIXTURE_CLIMATE_HEIGHT = 512;

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function byte(value) {
  return Math.round(clamp01(value) * 255);
}

// 月ごとの気候RGBAを生成する。R=気温、G=雲量、B=正高、A=陸地被覆率。
export function fixtureClimateRgba(monthIndex) {
  const phase = (monthIndex / 12) * Math.PI * 2;
  const pixels = new Uint8Array(FIXTURE_CLIMATE_WIDTH * FIXTURE_CLIMATE_HEIGHT * 4);
  for (let y = 0; y < FIXTURE_CLIMATE_HEIGHT; y += 1) {
    const latitude = Math.PI * (0.5 - (y + 0.5) / FIXTURE_CLIMATE_HEIGHT);
    const absLatitude = Math.abs(latitude);
    for (let x = 0; x < FIXTURE_CLIMATE_WIDTH; x += 1) {
      const longitude = Math.PI * 2 * ((x + 0.5) / FIXTURE_CLIMATE_WIDTH - 0.5);
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
      const offset = (y * FIXTURE_CLIMATE_WIDTH + x) * 4;
      pixels[offset] = byte((temperature - 180) / 150);
      pixels[offset + 1] = byte(cloudFraction);
      pixels[offset + 2] = byte((elevation + 1000) / 10000);
      pixels[offset + 3] = byte(landFraction);
    }
  }
  return pixels;
}

export function fixtureClimatePng(monthIndex) {
  return encodeRgbaPng(
    FIXTURE_CLIMATE_WIDTH, FIXTURE_CLIMATE_HEIGHT, fixtureClimateRgba(monthIndex),
  );
}
