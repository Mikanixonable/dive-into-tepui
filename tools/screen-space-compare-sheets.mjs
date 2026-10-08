// 候補比較の合成シート。種類ごとに候補を横に並べた1枚の PNG(1セル 480×270、間に黒い区切り)を書く。
// 走査解像度の画像は2倍の最近傍、全解像度の画像は 2×2 の平均で縮める。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng, encodeRgbPng } from './png.mjs';
import { BAND_COUNT, ZOOMS } from './screen-space-chain-bands.mjs';
import { imageFileOf, KINDS } from './screen-space-compare-kinds.mjs';
import { sceneDirOf } from './screen-space-chain-runs.mjs';

const CELL_WIDTH = 480, CELL_HEIGHT = 270, GAP = 4;

// PNG ファイルを 480×270 の RGB8 へ縮尺する。
function cellOf(file) {
  const { width, height, channels, data } = decodePng(readFileSync(file));
  const cell = new Uint8Array(CELL_WIDTH * CELL_HEIGHT * 3);
  const ratio = width / CELL_WIDTH;
  if (height / CELL_HEIGHT !== ratio || (ratio !== 0.5 && ratio !== 2)) throw new Error(`${file}: unexpected size ${width}×${height}`);
  for (let y = 0; y < CELL_HEIGHT; y++) for (let x = 0; x < CELL_WIDTH; x++) for (let c = 0; c < 3; c++) {
    let value;
    if (ratio === 0.5) {
      value = data[((y >> 1) * width + (x >> 1)) * channels + c];
    } else {
      let sum = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) sum += data[((2 * y + dy) * width + 2 * x + dx) * channels + c];
      value = Math.round(sum / 4);
    }
    cell[(y * CELL_WIDTH + x) * 3 + c] = value;
  }
  return cell;
}

// cells[行][列](480×270 の RGB8 か、画像の無い null)を黒い区切りで並べた PNG。
function sheetPng(cells) {
  const columns = cells[0].length, rows = cells.length;
  const width = columns * CELL_WIDTH + (columns - 1) * GAP, height = rows * CELL_HEIGHT + (rows - 1) * GAP;
  const rgb = new Uint8Array(width * height * 3);
  for (const [row, line] of cells.entries()) for (const [column, cell] of line.entries()) {
    if (cell === null) continue;
    const left = column * (CELL_WIDTH + GAP), top = row * (CELL_HEIGHT + GAP);
    for (let y = 0; y < CELL_HEIGHT; y++) {
      rgb.set(cell.subarray(y * CELL_WIDTH * 3, (y + 1) * CELL_WIDTH * 3), ((top + y) * width + left) * 3);
    }
  }
  return encodeRgbPng(width, height, rgb);
}

// ケース scene の合成シートを outDir に書き、sheets.json の中身 { name, file, columns, rows } の並びを返す。
// 帯の種類は「行 = 帯0〜3、列 = 候補」を倍率ごとに1枚、他の種類は1行。画像を持つ候補が無い種類は書かない。
export function writeSheets(scene, runs, outDir) {
  mkdirSync(outDir, { recursive: true });
  const sheets = [];
  const add = (name, rowLabels, columns, filesOf) => {
    if (columns.length === 0) return;
    const cells = rowLabels.map((_, row) => columns.map((run) => {
      const file = filesOf(run, row);
      return file === null ? null : cellOf(path.join(sceneDirOf(run, scene), file));
    }));
    writeFileSync(path.join(outDir, `${name}.png`), sheetPng(cells));
    sheets.push({ name, file: `${name}.png`, columns, rows: rowLabels });
  };
  const bandRows = Array.from({ length: BAND_COUNT }, (_, band) => `帯${band}`);
  for (const prefix of ['converged', 'one-pass']) {
    const kinds = KINDS.filter(({ id }) => id.startsWith(`${prefix}-band-`));
    for (const zoom of ZOOMS) {
      const columns = runs.filter((run) => imageFileOf(kinds[0], run, scene, zoom) !== null);
      add(`${prefix}-bands.x${zoom}`, bandRows, columns, (run, band) => imageFileOf(kinds[band], run, scene, zoom));
    }
  }
  for (const kind of KINDS.filter(({ zoomable }) => !zoomable)) {
    const columns = runs.filter((run) => imageFileOf(kind, run, scene) !== null);
    add(kind.id, [kind.label], columns, (run) => imageFileOf(kind, run, scene));
  }
  writeFileSync(path.join(outDir, 'sheets.json'), JSON.stringify({ scene, cell: [CELL_WIDTH, CELL_HEIGHT], gap: GAP, sheets }, null, 2));
  return sheets;
}
