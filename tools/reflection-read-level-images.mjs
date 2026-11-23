import { encodeRgbPng } from './png.mjs';
import { PIXELS } from './reflection-chain-common.mjs';
import { HEIGHT, WIDTH } from './screen-space-lab.mjs';

export function grayLevelPng(levels, lmax) {
  const rgb = new Uint8Array(PIXELS * 3);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const level = levels[pixel];
    const value = level < 0 ? 0 : Math.round(255 * level / Math.max(lmax, 1));
    rgb[pixel * 3] = level < 0 ? 0 : value;
    rgb[pixel * 3 + 1] = level < 0 ? 24 : value;
    rgb[pixel * 3 + 2] = level < 0 ? 64 : value;
  }
  return encodeRgbPng(WIDTH, HEIGHT, rgb);
}

export function overPng(currentLevels, balancedLevels) {
  const rgb = new Uint8Array(PIXELS * 3);
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const difference = Math.max(-3, Math.min(3, currentLevels[pixel] - balancedLevels[pixel])) / 3;
    const amount = Math.abs(difference);
    const low = Math.round(128 - 128 * amount);
    const high = Math.round(128 + 127 * amount);
    rgb[pixel * 3] = difference > 0 ? high : low;
    rgb[pixel * 3 + 1] = low;
    rgb[pixel * 3 + 2] = difference < 0 ? high : low;
  }
  return encodeRgbPng(WIDTH, HEIGHT, rgb);
}
