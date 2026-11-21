// 翻訳テーブルの構築と機械検査
// 使い方: node tools/commit-message-ja/build-table.mjs
// 入力: in/batchNN.json(元), out/batchNN.json(訳), idmap.json, targets.json
// 出力: msgmap.json {sha: 新メッセージ}
// 検査: キー集合・プレフィックス保存・trailer verbatim・B の件名不変・CJK 混入
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CJK = /[぀-ヿ一-鿿]/;
const TRAILER_KEY = /^(Co-authored-by|Signed-off-by|Reviewed-by|Generated with|Refs:|BREAKING CHANGE|Change-Id)/i;
const PREFIX = /^((feat|fix|docs|chore|refactor|test|perf|ci|build|style|revert|merge|tools|spec|ui|assets|game|ship|render|physics|input|memo|cloud|testability)(\([^)]*\))?!?:)/;

const { A, B } = JSON.parse(readFileSync(join(here, 'targets.json'), 'utf8'));
const idmap = JSON.parse(readFileSync(join(here, 'idmap.json'), 'utf8'));

const orig = {}, trans = {};
for (const f of readdirSync(join(here, 'in'))) Object.assign(orig, JSON.parse(readFileSync(join(here, 'in', f), 'utf8')));
for (const f of readdirSync(join(here, 'out'))) Object.assign(trans, JSON.parse(readFileSync(join(here, 'out', f), 'utf8')));

const trailers = (m) => m.split('\n').filter((l) => TRAILER_KEY.test(l));
const errors = [], warns = [];

const missing = Object.keys(orig).filter((id) => !(id in trans));
const extra = Object.keys(trans).filter((id) => !(id in orig));
if (missing.length) errors.push(`missing ids: ${missing.slice(0, 10)} (${missing.length})`);
if (extra.length) errors.push(`extra ids: ${extra.slice(0, 10)} (${extra.length})`);

for (const [id, om] of Object.entries(orig)) {
  const tm = trans[id];
  if (tm === undefined) continue;
  const [os, ts] = [om.split('\n', 1)[0], tm.split('\n', 1)[0]];
  const op = os.match(PREFIX), tp = ts.match(PREFIX);
  if (op && (!tp || tp[1] !== op[1])) errors.push(`${id}: prefix changed "${op[1]}" -> "${ts.slice(0, 40)}"`);
  const [ot, tt] = [trailers(om), trailers(tm)];
  if (ot.join('') !== tt.join('')) errors.push(`${id}: trailer lines differ\n  orig: ${ot}\n  new:  ${tt}`);
  if (idmap[id].cls === 'B' && os !== ts) errors.push(`${id}: B subject changed "${os}" -> "${ts}"`);
  if (!CJK.test(tm)) warns.push(`${id}: no CJK in output: ${ts.slice(0, 60)}`);
}

const msgmap = {};
for (const [id, { shas }] of Object.entries(idmap)) {
  if (trans[id] === undefined) continue;
  for (const sha of shas) msgmap[sha] = trans[id];
}
const uncovered = [...A, ...B].map((x) => x.sha).filter((s) => !(s in msgmap));
if (uncovered.length) errors.push(`uncovered shas: ${uncovered.length}`);

writeFileSync(join(here, 'msgmap.json'), JSON.stringify(msgmap));
console.log(`errors: ${errors.length}`);
errors.slice(0, 40).forEach((e) => console.log('  ' + e));
console.log(`warns(no CJK): ${warns.length}`);
warns.slice(0, 40).forEach((w) => console.log('  ' + w));
console.log(`msgmap entries: ${Object.keys(msgmap).length}`);
