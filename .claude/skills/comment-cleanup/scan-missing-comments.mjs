// コメントが不足している関数・メソッドを一覧する。コメントのクリンナップ(SKILL.md)の検出手順。
// 使い方: node .claude/skills/comment-cleanup/scan-missing-comments.mjs [--threshold=10] [対象ファイル/ディレクトリ...=src]
//
// 検出するのは次の2種:
//   [呼出規約なし] 直前に1行もコメントがない関数・メソッド(1行だけの getter/setter は除く)
//   [文脈コメントなし] 本文が指定行数以上あり、本文中に1行もコメントがない関数・メソッド

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const ts = createRequire(import.meta.url)('typescript');

const args = process.argv.slice(2);
const bodyThreshold = Number(args.find((a) => a.startsWith('--threshold='))?.slice(12) ?? 10);
const targets = args.filter((a) => !a.startsWith('--'));

const files = [];
const collect = (p) => {
  if (fs.statSync(p).isDirectory()) {
    for (const e of fs.readdirSync(p)) collect(path.join(p, e));
  } else if (p.endsWith('.ts') || p.endsWith('.tsx')) files.push(p);
};
for (const t of targets.length ? targets : ['src']) collect(t);

// 宣言としての関数(コールバックの無名関数は対象外)を、名前と「コメントを探し始める位置」つきで返す
const declaredFunction = (node) => {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return { fn: node, anchor: node, name: node.name ? node.name.getText() : 'constructor' };
  }
  // const f = () => {} / class の arrow function フィールド
  const init = (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) ? node.initializer : undefined;
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
    const anchor = ts.isVariableDeclaration(node) ? node.parent.parent : node;
    return { fn: init, anchor, name: node.name.getText() };
  }
  return null;
};

const hasOwnLineLeadingComment = (text, anchor) => {
  const ranges = ts.getLeadingCommentRanges(text, anchor.getFullStart()) ?? [];
  // 前の行の末尾コメント(行内に先行コードがあるもの)は「直前のコメント」に数えない
  return ranges.some((r) => /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', r.pos) + 1, r.pos)));
};

const bodyStats = (text, sf, body) => {
  const start = sf.getLineAndCharacterOfPosition(body.getStart(sf)).line;
  const end = sf.getLineAndCharacterOfPosition(body.getEnd()).line;
  const lines = text.split(/\r?\n/).slice(start + 1, end);
  let count = 0;
  let comments = 0;
  let inBlock = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === '') continue;
    if (inBlock) {
      comments++;
      if (t.includes('*/')) inBlock = false;
    } else if (t.startsWith('//')) comments++;
    else if (t.startsWith('/*')) {
      comments++;
      if (!t.includes('*/')) inBlock = true;
    } else count++;
  }
  return { count, comments };
};

let missingLeading = 0;
let missingContext = 0;
for (const file of files.sort()) {
  const name = file.split(path.sep).join('/');
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

  const visit = (node) => {
    const found = declaredFunction(node);
    if (found && found.fn.body && ts.isBlock(found.fn.body)) {
      const { fn, anchor, name: fnName } = found;
      const line = sf.getLineAndCharacterOfPosition(anchor.getStart(sf)).line + 1;
      const { count, comments } = bodyStats(text, sf, fn.body);
      // 1行だけの getter/setter と空の本文は自明なので、呼出規約のコメントを求めない
      const trivial = count === 0 || ((ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
        && sf.getLineAndCharacterOfPosition(node.getStart(sf)).line === sf.getLineAndCharacterOfPosition(node.getEnd()).line);
      if (!trivial && !hasOwnLineLeadingComment(text, anchor)) {
        missingLeading++;
        console.log(`${name}:${line} [呼出規約なし] ${fnName} (本文${count}行)`);
      }
      if (count >= bodyThreshold && comments === 0) {
        missingContext++;
        console.log(`${name}:${line} [文脈コメントなし] ${fnName} (本文${count}行)`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

console.log(`=== 呼出規約なし ${missingLeading} 件 / 文脈コメントなし ${missingContext} 件 ===`);
