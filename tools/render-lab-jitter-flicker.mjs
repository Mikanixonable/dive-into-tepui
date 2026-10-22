// 固定カメラの nearby diffuse correction または最終画像を隣接フレームで比べ、全画面の揺れと画素粒度の揺れを測る。
// 8×8 ブロック平均差は大きな領域の同期した変化、画素差は粒状ノイズも含む変化の目安。
//
// 使い方: node tools/render-lab-jitter-flicker.mjs <fixed-camera-set-a> <fixed-camera-set-b> [--image=final]
// 既定は各組の on/correction/frame-16.png 〜 frame-31.png、--image=final は on/frame-16.png 〜 frame-31.png を読む。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const FIRST_FRAME = 16;
const LAST_FRAME = 31;
const BLOCK_SIZE = 8;
const USAGE = 'usage: node tools/render-lab-jitter-flicker.mjs <fixed-camera-set-a> <fixed-camera-set-b> [--image=final]';

function imageOf(directory, frame, imageKind) {
  const target = imageKind === 'final' ? [] : ['correction'];
  const filename = path.join(directory, 'on', ...target, `frame-${String(frame).padStart(2, '0')}.png`);
  if (!existsSync(filename)) throw new Error(`missing image: ${path.relative(root, filename)}`);
  const image = decodePng(readFileSync(filename));
  if (image.channels < 3) throw new Error(`expected RGB image: ${path.relative(root, filename)}`);
  return image;
}

function imagesOf(directory, imageKind) {
  return Array.from(
    { length: LAST_FRAME - FIRST_FRAME + 1 },
    (_, index) => imageOf(directory, FIRST_FRAME + index, imageKind),
  );
}

function assertSameDimensions(images, label) {
  const first = images[0];
  for (let index = 1; index < images.length; index++) {
    const image = images[index];
    if (image.width !== first.width || image.height !== first.height) {
      throw new Error(`${label}: frame ${FIRST_FRAME + index} is ${image.width}×${image.height}, expected ${first.width}×${first.height}`);
    }
  }
}

function pairRms(previous, current) {
  let pixelSquares = 0;
  for (let pixel = 0; pixel < previous.width * previous.height; pixel++) {
    const before = pixel * previous.channels;
    const after = pixel * current.channels;
    for (let channel = 0; channel < 3; channel++) {
      const difference = current.data[after + channel] - previous.data[before + channel];
      pixelSquares += difference * difference;
    }
  }

  let blockSquares = 0;
  let blockSamples = 0;
  for (let top = 0; top < previous.height; top += BLOCK_SIZE) {
    for (let left = 0; left < previous.width; left += BLOCK_SIZE) {
      const bottom = Math.min(top + BLOCK_SIZE, previous.height);
      const right = Math.min(left + BLOCK_SIZE, previous.width);
      const pixelCount = (bottom - top) * (right - left);
      const before = [0, 0, 0];
      const after = [0, 0, 0];
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const pixel = y * previous.width + x;
          const beforePixel = pixel * previous.channels;
          const afterPixel = pixel * current.channels;
          for (let channel = 0; channel < 3; channel++) {
            before[channel] += previous.data[beforePixel + channel];
            after[channel] += current.data[afterPixel + channel];
          }
        }
      }
      for (let channel = 0; channel < 3; channel++) {
        const difference = (after[channel] - before[channel]) / pixelCount;
        blockSquares += difference * difference;
        blockSamples++;
      }
    }
  }
  return {
    blockMeanRms: Math.sqrt(blockSquares / blockSamples),
    pixelRms: Math.sqrt(pixelSquares / (previous.width * previous.height * 3)),
  };
}

function main() {
  const args = process.argv.slice(2);
  const imageOption = args.filter((arg) => arg.startsWith('--image='));
  const directories = args.filter((arg) => !arg.startsWith('--'));
  if (directories.length !== 2 || imageOption.length > 1 || args.some((arg) => arg.startsWith('--') && arg !== '--image=final')) {
    throw new Error(USAGE);
  }
  const imageKind = imageOption.length === 0 ? 'correction' : 'final';
  const sets = directories.map((directory) => ({
    name: path.basename(directory), images: imagesOf(path.resolve(root, directory), imageKind),
  }));
  const { width, height } = sets[0].images[0];
  for (const set of sets) {
    assertSameDimensions(set.images, set.name);
    if (set.images[0].width !== width || set.images[0].height !== height) {
      throw new Error(`${set.name}: image dimensions differ from the first set (${width}×${height})`);
    }
  }

  console.log(`Image: ${imageKind}; ${width}×${height}; adjacent pairs ${FIRST_FRAME}→${FIRST_FRAME + 1} through ${LAST_FRAME - 1}→${LAST_FRAME}`);
  console.log('set | frames | 8×8 block-mean RGB RMS | pixel RGB RMS');
  const summaries = [];
  for (const set of sets) {
    let blockSquares = 0;
    let pixelSquares = 0;
    console.log(`\n${set.name}`);
    for (let index = 1; index < set.images.length; index++) {
      const metrics = pairRms(set.images[index - 1], set.images[index]);
      console.log(`${FIRST_FRAME + index - 1}→${FIRST_FRAME + index} | ${metrics.blockMeanRms.toFixed(4)} | ${metrics.pixelRms.toFixed(4)}`);
      blockSquares += metrics.blockMeanRms ** 2;
      pixelSquares += metrics.pixelRms ** 2;
    }
    summaries.push({
      name: set.name,
      blockMeanRms: Math.sqrt(blockSquares / (set.images.length - 1)),
      pixelRms: Math.sqrt(pixelSquares / (set.images.length - 1)),
    });
  }
  console.log('\nRMS across adjacent pairs:');
  for (const summary of summaries) {
    console.log(`${summary.name}: block-mean=${summary.blockMeanRms.toFixed(4)}, pixel=${summary.pixelRms.toFixed(4)}`);
  }
}

main();
