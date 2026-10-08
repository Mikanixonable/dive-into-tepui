// 手順8-15の収束の積算のキャッシュ(OUTPUT/cache/<ケース>/<鍵>/)。CHUNK_PASSES パスごとに、帯を詰めた3枚のテクスチャの
// 値の和(kind 'sum')と二乗の和(kind 'sumsq')を単精度で置く。二乗の和は後から足されたので、和だけのキャッシュもある。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SCAN_PIXELS } from './screen-space-chain-runs.mjs';
import { CHUNK_PASSES } from './screen-space-chain-setup.mjs';
import { readFloats } from './screen-space-lab.mjs';

export const chunkFile = (cache, first, texture, kind = 'sum') =>
  path.join(cache, `${kind}-${String(first).padStart(4, '0')}-packed-${texture}.f32`);

// first から始まるチャンクの kind のファイルが3枚そろっているか。
export const chunkComplete = (cache, first, kind = 'sum') => [0, 1, 2]
  .every((texture) => {
    const file = chunkFile(cache, first, texture, kind);
    return existsSync(file) && readFileSync(file).byteLength === SCAN_PIXELS * 4 * 4;
  });

// パス first〜end − 1 の kind の値の平均(帯を詰めた3枚のテクスチャ)。end − first は CHUNK_PASSES の倍数。
export function cachedMean(cache, first, end, kind = 'sum') {
  const sums = Array.from({ length: 3 }, () => new Float64Array(SCAN_PIXELS * 4));
  for (let pass = first; pass < end; pass += CHUNK_PASSES) {
    for (let texture = 0; texture < 3; texture++) {
      const values = readFloats(chunkFile(cache, pass, texture, kind));
      if (values.length !== SCAN_PIXELS * 4) throw new Error(`invalid cached scan chunk ${pass}/${texture}`);
      const sum = sums[texture];
      for (let i = 0; i < sum.length; i++) sum[i] += values[i];
    }
  }
  return sums.map((values) => Float32Array.from(values, (value) => value / (end - first)));
}
