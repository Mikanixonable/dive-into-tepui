// PostToolUse フック: src/**/*.ts を編集したときの義務(コメント方針の自己点検・仕様の先行確認)を
// 思い出させる。判定だけを行い、実際の基準は DEVELOP/CODING-RULE.md と DEVELOP/SPEC/ に従う。
// jq が無い環境(Git Bash)でも動くよう node で書いている。

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let path = '';
  try {
    const input = JSON.parse(raw);
    path = input?.tool_response?.filePath ?? input?.tool_input?.file_path ?? '';
  } catch {
    process.exit(0); // 入力が読めないときは黙って通す
  }

  const posix = String(path).replace(/\\/g, '/');
  if (!/(^|\/)src\/.*\.ts$/.test(posix)) process.exit(0);

  const message =
    `${posix} を変更した。\n` +
    '【コメントの自己点検】いま書いた/残したコメントを DEVELOP/CODING-RULE.md「コメント規約」の\n' +
    '基準で見直せ。大原則は「そのモジュールの責務外に言及しない」。「どう実装しているか」\n' +
    '「なにをしないか(否定形)」「誰が使うか」「以前どうだったか」「何を変えたか」「検討メモへの参照」\n' +
    'は消す。残すのは「なにをするか」「どう使うか」と、相当に非自明な実装の理由だけ\n' +
    '(モジュール5行/関数3行/関数内1行が目安)。\n' +
    '不足も同じく問題。追加/変更した関数・メソッドの直前に呼出規約のコメントがあるか(1行だけの\n' +
    'getter/setter は不要)、本文10行以上の関数に文脈コメントがあるかを確認せよ。検出は\n' +
    'node .claude/skills/comment-cleanup/scan-missing-comments.mjs <変更したファイル>。\n' +
    '【仕様の先行】DEVELOP/SPEC/ は「どう振舞うべきか」の正本で、コードより先行していなければ\n' +
    'ならない。プレイヤーから見える挙動・数値・操作を変えたなら、SPEC/ の該当ファイルが先に\n' +
    '更新されているかを確認せよ(手順は /modify-feature)。まだなら、コードを進める前に直す。\n' +
    'コードの現状を追認するだけの記述を文書へ書き足さないこと。\n' +
    '【規約への追従】DEVELOP/CODING-RULE.md(設計方針・命名規則・コメント規約)から変更範囲が\n' +
    '逸脱していないか確認せよ。大きな変更を終えた後は /refactor で一括点検する。';

  process.stdout.write(
    JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
    }),
  );
});
