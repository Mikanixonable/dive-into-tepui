// PostToolUse フック: 横断的な責務境界のうち、機械的に検出できる違反を
// 編集直後に指摘する。判定するのは以下の4つだけで、基準そのものは
// DEVELOP/CODING-RULE.md が正本。
//
//   1. game.ts / main.ts に配線と呼び出し順以外のものが入った
//   2. sync が update を呼ぶ / 論理値を書き換える
//   3. update が THREE・DOM に触る / sync を呼ぶ
//   4. physics/ が THREE・game/・フローティングオリジンに依存した
//
// 構文解析はせず、メソッド単位のブロックを波括弧の対応で切り出して正規表現で見る。
// 取りこぼしはあるが、誤検出したときも「見直せ」と言うだけで作業は止めない。

// Game に置いてよいメンバー(生成・配線・呼び出し順・フレーム位相・自身の状態の切替)。
const GAME_ALLOWED_MEMBERS = new Set([
  'constructor', 'update', 'sync', 'render', 'handleInput',
  'pause', 'resume', 'setActivePlayer', 'perfCounts',
]);

// sync の中にあってはいけないもの(論理値の前進・積分・寿命判定・update 呼び出し)。
const SYNC_FORBIDDEN = [
  [/\.update\s*\(/, 'sync から update を呼んでいる'],
  [/\b\w+\s*\.\s*age\s*\+=/, 'sync で経過時間を進めている'],
  [/\b(this\.)?\w*[Tt]ime\s*\+=/, 'sync で時刻を進めている'],
  [/\bstep(Orbit|Env|Attitude|Sim|Prediction)\w*\s*\(/, 'sync で積分している'],
  [/\.filter\s*\(\s*\(?\s*\w+\s*\)?\s*=>[^\n]*\+=/, 'sync で寿命を進めながら間引いている'],
];

// update の中にあってはいけないもの(THREE/DOM への反映・sync 呼び出し)。
const UPDATE_FORBIDDEN = [
  [/\.sync\w*\s*\(/, 'update から sync を呼んでいる'],
  [/\.position\s*\.\s*(set|copy)\b/, 'update で THREE の position を書いている'],
  [/\.quaternion\s*\.\s*(set|copy)\b/, 'update で THREE の quaternion を書いている'],
  [/\.rotation\s*\.\s*[xyz]\s*=/, 'update で THREE の rotation を書いている'],
  [/\.visible\s*=/, 'update で THREE の visible を書いている'],
  [/\.style\s*\.\s*\w+\s*=/, 'update で DOM のスタイルを書いている'],
  [/\.innerHTML\s*=/, 'update で DOM の内容を書いている'],
];

// physics/ に入ってはいけない依存。
const PHYSICS_FORBIDDEN = [
  [/from\s+['"][^'"]*three/, 'physics/ が THREE.js に依存している'],
  [/from\s+['"][^'"]*\.\.\/game\//, 'physics/ が game/ に依存している(ゲームバランス・表示調整の持ち込み)'],
  [/[Ff]loating[Oo]rigin/, 'physics/ がフローティングオリジン(描画のための平行移動)に触れている'],
];

// open の位置から対応する閉じ波括弧までを返す(文字列・コメント中の括弧は数えない)。
function blockAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) break; i++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === quote) break;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
}

// name にマッチするメソッド定義の本文を順に返す。
function methodBodies(src, namePattern) {
  const bodies = [];
  const decl = new RegExp(`^\\s{2}(?:private |protected |public |readonly |static )*(${namePattern})\\s*\\(`, 'gm');
  for (const m of src.matchAll(decl)) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    if (open >= 0) bodies.push({ name: m[1], body: blockAt(src, open) });
  }
  return bodies;
}

// src の全メソッド名(クラス直下の宣言)を返す。アクセサは値を読ませるだけなので除く。
function memberNames(src) {
  const decl = /^\s{2}(?:private |protected |public |readonly |static )*(\w+)\s*[(<]/gm;
  return [...src.matchAll(decl)].map((m) => m[1]);
}

// path/src を4つの境界に照らし、見つかった違反の説明を返す。
function findViolations(posix, src) {
  const out = [];

  if (/(^|\/)src\/physics\//.test(posix)) {
    for (const [re, msg] of PHYSICS_FORBIDDEN) {
      if (re.test(src)) out.push(`${msg}(physics/ の純度)`);
    }
  }

  if (/(^|\/)src\/game\/game\.ts$/.test(posix)) {
    const extra = memberNames(src).filter((n) => !GAME_ALLOWED_MEMBERS.has(n));
    if (extra.length > 0) {
      out.push(
        `Game/main にオーケストレーション以外のメンバーがある: ${extra.join(', ')}` +
        '(CODING-RULE 1.2 — どちらかの所有者へ寄せるか、その横断を責務とするモジュールを立てる)',
      );
    }
  }

  for (const { name, body } of methodBodies(src, 'sync\\w*')) {
    for (const [re, msg] of SYNC_FORBIDDEN) {
      if (re.test(body)) out.push(`${name}(): ${msg}(CODING-RULE 1.7 フレーム処理の位相)`);
    }
  }
  for (const { name, body } of methodBodies(src, 'update\\w*|behave')) {
    for (const [re, msg] of UPDATE_FORBIDDEN) {
      if (re.test(body)) out.push(`${name}(): ${msg}(CODING-RULE 1.7 フレーム処理の位相)`);
    }
  }

  return out;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', async () => {
  let path = '';
  try {
    const input = JSON.parse(raw);
    path = input?.tool_response?.filePath ?? input?.tool_input?.file_path ?? '';
  } catch {
    process.exit(0);
  }

  const posix = String(path).replace(/\\/g, '/');
  if (!/(^|\/)src\/.*\.ts$/.test(posix)) process.exit(0);

  let src = '';
  try {
    src = await (await import('node:fs/promises')).readFile(path, 'utf8');
  } catch {
    process.exit(0);
  }

  const violations = findViolations(posix, src);
  if (violations.length === 0) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `【責務境界の違反を検出】${posix}\n` +
          violations.map((v) => `- ${v}`).join('\n') +
          '\nDEVELOP/CODING-RULE.md の該当節を読み、コードを直せ。' +
          'ルールに例外を足して正当化しない。誤検出だと判断した場合はその理由を述べること。',
      },
    }),
  );
});
