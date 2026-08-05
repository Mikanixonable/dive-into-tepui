import { mkdir, writeFile } from 'node:fs/promises';
import { rmqr } from 'rmqr';

// The title is the source of truth.  The SVG is regenerated on every build so
// changing this string automatically changes the actual rMQR payload.
export const RMQR_TEXT = 'Dive into Tepui';
const OUTPUT = new URL('../src/assets/tepui-rmqr.svg', import.meta.url);

const data = await new rmqr().generate(RMQR_TEXT);
if (!data || !Number.isInteger(data.width) || !Number.isInteger(data.height) || data.width < 1 || data.height < 1) {
  throw new Error('rMQR encoder returned an invalid matrix');
}
if (data.qr.length !== data.height || data.qr.some((row) => row.length !== data.width)) {
  throw new Error('rMQR encoder returned a non-rectangular matrix');
}

const quiet = 2;
const cells = [];
for (let y = 0; y < data.height; y += 1) {
  for (let x = 0; x < data.width; x += 1) {
    if (data.qr[y][x]) cells.push(`<path d="M${x + quiet} ${y + quiet}h1v1h-1z"/>`);
  }
}
const width = data.width + quiet * 2;
const height = data.height + quiet * 2;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc" shape-rendering="crispEdges"><title id="title">${RMQR_TEXT}</title><desc id="desc">rMQR encoding of ${RMQR_TEXT}</desc><rect width="100%" height="100%" fill="#0a0a0a"/><g fill="#ff6a00">${cells.join('')}</g></svg>\n`;
await mkdir(new URL('../src/assets/', import.meta.url), { recursive: true });
await writeFile(OUTPUT, svg);
console.log(`Generated rMQR ${data.width}x${data.height} for ${JSON.stringify(RMQR_TEXT)}`);
