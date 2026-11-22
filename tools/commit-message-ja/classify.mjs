// コミットメッセージ日本語化 — 対象の分類とダンプ
// 使い方: node tools/commit-message-ja/classify.mjs
// 出力: tools/commit-message-ja/targets.json { A:[{sha,msg}], B:[{sha,msg}] }
//   A = メッセージ全体が英語(件名・本文ともに CJK なし) → 全体を翻訳
//   B = 件名は日本語・本文(trailer を除く)が英語のみ     → 本文を翻訳
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

const CJK = /[぀-ヿ一-鿿]/;
const BOT_AUTHOR = /dependabot|github-actions|copilot/i;
const TRAILER_KEY = /^(Co-authored-by|Signed-off-by|Reviewed-by|Generated with|Refs:|BREAKING CHANGE|Change-Id)/i;

const log = execFileSync(
  'git', ['log', '--all', '--format=%H%x1f%aN%x1f%aE%x1f%B%x1e'],
  { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }
);

const bodyWithoutTrailers = (msg) =>
  msg.split('\n').slice(1).filter((l) => !TRAILER_KEY.test(l)).join('\n').trim();

const A = [], B = [];
let excluded = 0, skipped = 0;
const seenMsg = new Set();

for (const rec of log.split('').filter((r) => r.trim())) {
  const [sha0, author, email, msg] = rec.split('');
  const sha = sha0.trim();
  const subject = msg.split('\n', 1)[0];

  const isExcluded = /^Merge /i.test(subject) || BOT_AUTHOR.test(author) ||
    BOT_AUTHOR.test(email) || /\bdependabot\b/i.test(subject);
  if (isExcluded) { excluded++; continue; }

  // 同一メッセージの重複コミット(履歴書き換え由来の分身)は翻訳を1回にする。
  // ただしテーブルは SHA 単位で引くので重複自体は登録する。dump 時に uniq する。
  if (!CJK.test(msg)) {
    A.push({ sha, msg });
    seenMsg.add(msg);
  } else if (CJK.test(subject) && bodyWithoutTrailers(msg).length > 0 &&
             !CJK.test(bodyWithoutTrailers(msg))) {
    B.push({ sha, msg });
  } else {
    skipped++;
  }
}

mkdirSync(here, { recursive: true });
writeFileSync(join(here, 'targets.json'), JSON.stringify({ A, B }, null, 0));

const chars = (xs) => xs.reduce((s, x) => s + x.msg.length, 0);
console.log(`excluded(merge/bot): ${excluded}`);
console.log(`A (fully EN): ${A.length} commits, ${chars(A)} chars, ${seenMsg.size} unique msgs`);
console.log(`B (JP subject + EN body): ${B.length} commits, ${chars(B)} chars`);
console.log(`skipped (mixed/other): ${skipped}`);
