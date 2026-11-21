#!/usr/bin/env node
// 重複コミット除去: patch-id ごとの正本を選び drop 集合を出力する。
// 入力: /tmp/pid-all.txt ("<sha>|<pid>", merge は |MERGE)
//      /tmp/commit-meta.txt ("<sha> <parents...> <ct>")
//      /tmp/mainline.txt (main first-parent 鎖の sha 一覧)
//      /tmp/ref-tips.txt (全 ref 先端 sha)
// 出力: /tmp/drop-shas.txt, /tmp/canonical-map.json, 統計
import { readFileSync, writeFileSync } from 'node:fs';

const meta = new Map();
for (const l of readFileSync('/tmp/commit-meta.txt', 'utf8').trim().split('\n')) {
  const sp = l.split(' ');
  meta.set(sp[0], { parents: sp.slice(1, -1), ct: +sp.at(-1) });
}
const mainline = new Set(readFileSync('/tmp/mainline.txt', 'utf8').trim().split('\n'));
const tips = new Set(readFileSync('/tmp/ref-tips.txt', 'utf8').trim().split('\n'));

const groups = new Map(); // pid -> sha[]
const skipped = { merge: 0, empty: 0, root: 0, tip: 0 };
for (const l of readFileSync('/tmp/pid-all.txt', 'utf8').trim().split('\n')) {
  const [sha, pid] = l.split('|');
  const m = meta.get(sha);
  if (pid === 'MERGE') { skipped.merge++; continue; }
  if (!m || m.parents.length === 0) { skipped.root++; continue; }
  if (tips.has(sha)) { skipped.tip++; continue; }
  if (!pid) { skipped.empty++; continue; }
  (groups.get(pid) ?? groups.set(pid, []).get(pid)).push(sha);
}

const drop = [];
const canonical = {};
let dupGroups = 0;
for (const [pid, shas] of groups) {
  if (shas.length < 2) { canonical[pid] = shas[0]; continue; }
  dupGroups++;
  // 正本: mainline 優先 → committer date 昇順 → sha 順
  shas.sort((a, b) =>
    (mainline.has(b) - mainline.has(a)) ||
    (meta.get(a).ct - meta.get(b).ct) ||
    a.localeCompare(b));
  canonical[pid] = shas[0];
  drop.push(...shas.slice(1));
}
writeFileSync('/tmp/drop-shas.txt', drop.join('\n') + '\n');
writeFileSync('/tmp/canonical-map.json', JSON.stringify(canonical));
console.log(`dup patch-id groups: ${dupGroups}`);
console.log(`commits to drop: ${drop.length}`);
console.log(`excluded: merge=${skipped.merge} root=${skipped.root} tip=${skipped.tip} empty-patch=${skipped.empty}`);
