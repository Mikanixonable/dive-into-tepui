// three/addons の LTC 係数表(64×64 RGBA×2枚)を半精度で焼き、
// src/render/pipeline/lighting/ltc-table.ts へ書き出す。
//
// 実行時に three/addons を読むと素の three(three.module.js)がバンドルへ丸ごと入るため、
// 表だけを生成物として切り出す。表が変わるのは three を更新したときだけで、そのときは
// このスクリプトを回し直す。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RectAreaLightTexturesLib } from 'three/examples/jsm/lights/RectAreaLightTexturesLib.js';

const lib = RectAreaLightTexturesLib.init();
const half1 = lib.LTC_HALF_1.image.data;
const half2 = lib.LTC_HALF_2.image.data;

// Uint16Array をリトルエンディアンの base64 へ。読み戻し(ltc-table.ts)と対で保つ。
function toBase64(halves) {
  return Buffer.from(halves.buffer, halves.byteOffset, halves.byteLength).toString('base64');
}

const outPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../src/render/pipeline/lighting/ltc-table.ts',
);

writeFileSync(outPath, `// 生成物。tools/export-ltc-table.mjs が three/addons の RectAreaLightTexturesLib から
// 焼き出した LTC 係数表(64×64 RGBA 半精度×2枚)。手で編集しない。
// 表 1 は逆変換行列の係数、表 2 は正規化係数(x)とフレネル項(y)。
import * as THREE from 'three/webgpu';

export const LTC_TABLE_SIZE = 64;

const LTC_1_BASE64 = '${toBase64(half1)}';

const LTC_2_BASE64 = '${toBase64(half2)}';

// base64(リトルエンディアン)の表 1 枚を、元と同じフィルタ設定の DataTexture へ載せる。
function decodeTable(base64: string): THREE.DataTexture {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const texture = new THREE.DataTexture(
    new Uint16Array(bytes.buffer), LTC_TABLE_SIZE, LTC_TABLE_SIZE,
    THREE.RGBAFormat, THREE.HalfFloatType, THREE.UVMapping,
    THREE.ClampToEdgeWrapping, THREE.ClampToEdgeWrapping,
    THREE.LinearFilter, THREE.NearestFilter, 1,
  );
  texture.needsUpdate = true;
  return texture;
}

// 係数表 2 枚を新しいテクスチャとして返す。解放は呼び出し側が行う。
export function createLtcTables(): { readonly ltc1: THREE.DataTexture; readonly ltc2: THREE.DataTexture } {
  return { ltc1: decodeTable(LTC_1_BASE64), ltc2: decodeTable(LTC_2_BASE64) };
}
`);

console.log(`Wrote ${outPath} (${half1.length + half2.length} halfs)`);
