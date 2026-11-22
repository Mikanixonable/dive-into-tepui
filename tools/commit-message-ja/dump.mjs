// 翻訳バッチの生成 — targets.json のユニークメッセージを ~220件ずつのバッチへ分ける
// 使い方: node tools/commit-message-ja/dump.mjs
// 出力: in/batchNN.json {m0001: "..."} と idmap.json {m0001: [sha,...]}
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { A, B } = JSON.parse(readFileSync(join(here, 'targets.json'), 'utf8'));

const idmap = {}, inputs = {};
let n = 0;
const msgToId = new Map();
const add = (sha, msg, cls) => {
  if (!msgToId.has(msg)) {
    const id = `m${String(++n).padStart(4, '0')}`;
    msgToId.set(msg, id);
    inputs[id] = msg;
    idmap[id] = { cls, shas: [] };
  }
  idmap[msgToId.get(msg)].shas.push(sha);
};
A.forEach(({ sha, msg }) => add(sha, msg, 'A'));
B.forEach(({ sha, msg }) => add(sha, msg, 'B'));

const ids = Object.keys(inputs);
const SIZE = 220;
mkdirSync(join(here, 'in'), { recursive: true });
let batches = 0;
for (let i = 0; i < ids.length; i += SIZE) {
  const batch = {};
  for (const id of ids.slice(i, i + SIZE)) batch[id] = inputs[id];
  writeFileSync(join(here, 'in', `batch${String(++batches).padStart(2, '0')}.json`), JSON.stringify(batch, null, 1));
}
writeFileSync(join(here, 'idmap.json'), JSON.stringify(idmap, null, 0));
console.log(`${ids.length} unique messages -> ${batches} batches`);
