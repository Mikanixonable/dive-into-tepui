// 地球表面の焼き込みテクスチャ(equirectangular PNG)を生成するツール。
// 色計算のロジックは src/render/earthcolor.ts(THREE 非依存の純粋関数)を
// 唯一の情報源として使う。Node 単体で .ts を import できないため、
// 既に devDependency として入っている TypeScript コンパイラの
// transpileModule API でその場に JS へ変換してから動的 import する
// (ts-node 等の新規パッケージは追加しない)。
//
// 実行: node tools/export-earth-texture.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// --- src/render/earthcolor.ts を JS にトランスパイルして動的 import ---
const earthColorSrcPath = join(repoRoot, 'src', 'render', 'earthcolor.ts');
const source = readFileSync(earthColorSrcPath, 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: 'earthcolor.ts',
});

const tmpDir = mkdtempSync(join(tmpdir(), 'tepui-earthcolor-'));
const tmpModulePath = join(tmpDir, 'earthcolor.mjs');
writeFileSync(tmpModulePath, outputText, 'utf8');
const { surfaceColor } = await import(pathToFileURL(tmpModulePath).href);
rmSync(tmpDir, { recursive: true, force: true });

// --- sRGB OETF ---
function linearToSrgb(c) {
  const clamped = c < 0 ? 0 : c > 1 ? 1 : c;
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

// --- equirectangular ラスタライズ ---
// three.js の SphereGeometry(phiStart=0, thetaStart=0) の実際の UV 規約に
// 合わせる(node_modules/three/src/geometries/SphereGeometry.js を参照):
//   theta = v * PI, phi = u * 2*PI
//   x = -cos(phi) * sin(theta)
//   y =  cos(theta)
//   z =  sin(phi) * sin(theta)
// これは旧・頂点色コードが使っていた頂点位置(Y = 北極)と同じ変換なので、
// 球にマッピングしたときの向き・鏡像は一致する。
const WIDTH = 2048;
const HEIGHT = 1024;
const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 3)); // 各行: フィルタバイト0 + RGB

let offset = 0;
for (let y = 0; y < HEIGHT; y++) {
  raw[offset++] = 0; // フィルタタイプ 0 (None)
  const v = (y + 0.5) / HEIGHT;
  const theta = v * Math.PI;
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);
  for (let x = 0; x < WIDTH; x++) {
    const u = (x + 0.5) / WIDTH;
    const phi = u * 2 * Math.PI;
    const px = -Math.cos(phi) * sinTheta;
    const py = cosTheta;
    const pz = Math.sin(phi) * sinTheta;
    const { r, g, b } = surfaceColor(px, py, pz);
    raw[offset++] = Math.round(linearToSrgb(r) * 255);
    raw[offset++] = Math.round(linearToSrgb(g) * 255);
    raw[offset++] = Math.round(linearToSrgb(b) * 255);
  }
  if (y % 128 === 0) process.stdout.write(`row ${y}/${HEIGHT}\n`);
}

// --- PNG エンコード (手書き: 署名 + IHDR + IDAT + IEND) ---
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ihdrData = Buffer.alloc(13);
ihdrData.writeUInt32BE(WIDTH, 0);
ihdrData.writeUInt32BE(HEIGHT, 4);
ihdrData[8] = 8; // bit depth
ihdrData[9] = 2; // color type: RGB (truecolor)
ihdrData[10] = 0; // compression
ihdrData[11] = 0; // filter
ihdrData[12] = 0; // interlace

const idatData = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  SIGNATURE,
  chunk('IHDR', ihdrData),
  chunk('IDAT', idatData),
  chunk('IEND', Buffer.alloc(0)),
]);

const outPath = join(repoRoot, 'src', 'assets', 'earth.png');
writeFileSync(outPath, png);
console.log(`Wrote ${outPath} (${png.length} bytes)`);
