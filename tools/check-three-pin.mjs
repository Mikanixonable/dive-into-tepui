// three を、反転深度の描画順を打ち消す回避策(src/render/pipeline/reversed-sort.ts)が
// 前提としている版へ留め置くための検査。RenderList.sort が custom sort のあとで無条件に
// .reverse() する振る舞いが消えると、打ち消しが余計になって描画順が黙って逆さになる。
// 例外は出ないので、版か振る舞いのどちらかが動いた時点で ci を落とす。
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const PINNED_VERSION = '0.185.1';
const REVERSE_SNIPPET = 'if(reversedDepth){this.opaque.reverse();';
const RECOVERY = 'memos/hedalu244/better_graphics/how_to_update_three.md の手順に従うこと。';

const version = JSON.parse(readFileSync(path.join(root, 'node_modules/three/package.json'), 'utf8')).version;
const renderList = readFileSync(path.join(root, 'node_modules/three/src/renderers/common/RenderList.js'), 'utf8');
const hasReverse = renderList.replace(/\s+/g, '').includes(REVERSE_SNIPPET);

const failures = [];
if (version !== PINNED_VERSION) failures.push(`three が ${PINNED_VERSION} ではなく ${version} になっている。`);
if (!hasReverse) failures.push('RenderList.sort の無条件 .reverse() が無くなっている。回避策を撤去する時期。');

if (failures.length > 0) {
  console.error(`${failures.join('\n')}\n${RECOVERY}`);
  process.exit(1);
}
console.log(`three ${version}: 反転深度の描画順の回避策はまだ要る。`);
