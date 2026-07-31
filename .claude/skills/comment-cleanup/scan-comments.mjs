// 連続する複数行コメントを一覧する。コメントのクリンナップ(SKILL.md)の検出手順。
// 使い方: node .claude/skills/comment-cleanup/scan-comments.mjs [対象ディレクトリ=src] [最小行数=2]

import fs from 'fs';
import path from 'path';

const root = process.argv[2] ?? 'src';
const minLines = Number(process.argv[3] ?? 2);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.mjs')) files.push(p);
  }
})(root);

let blocks = 0;
let total = 0;
for (const file of files.sort()) {
  const name = file.split(path.sep).join('/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let run = [];
  let start = 0;
  let inBlockComment = false;

  const flush = () => {
    if (run.length >= minLines) {
      blocks++;
      total += run.length;
      console.log(`${name}:${start + 1} (${run.length}行)`);
      for (const [i, l] of run.entries()) console.log(`  ${start + 1 + i}| ${l}`);
      console.log('');
    }
    run = [];
  };

  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    let isComment = false;
    if (inBlockComment) {
      isComment = true;
      if (t.includes('*/')) inBlockComment = false;
    } else if (t.startsWith('/*')) {
      isComment = true;
      if (!t.includes('*/')) inBlockComment = true;
    } else if (t.startsWith('//')) {
      isComment = true;
    }
    if (isComment) {
      if (run.length === 0) start = i;
      run.push(line);
    } else flush();
  }
  flush();
}

console.log(`=== ${blocks} ブロック / ${total} 行 ===`);
