// PostToolUse フック: src/**/*.ts を編集したときの義務(コメント方針の自己点検・設計文書の同期)を
// 思い出させる。判定だけを行い、実際の基準は .claude/skills/comment/SKILL.md と
// .claude/skills/develop-docs/SKILL.md に従う。
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
    '【コメントの自己点検】いま書いた/残したコメントを .claude/skills/comment/SKILL.md(/comment)の\n' +
    '基準で見直せ。大原則は「そのモジュールの責務外に言及しない」。「どう実装しているか」\n' +
    '「なにをしないか(否定形)」「誰が使うか」「以前どうだったか」「何を変えたか」「検討メモへの参照」\n' +
    'は消す。残すのは「なにをするか」「どう使うか」と、相当に非自明な実装の理由だけ\n' +
    '(モジュール5行/関数3行/関数内1行が目安)。\n' +
    '不足も同じく問題。追加/変更した関数・メソッドの直前に呼出規約のコメントがあるか(1行だけの\n' +
    'getter/setter は不要)、本文10行以上の関数に文脈コメントがあるかを確認せよ。検出は\n' +
    'node .claude/skills/comment-cleanup/scan-missing-comments.mjs <変更したファイル>。\n' +
    '【設計文書の同期】必要か判定せよ:\n' +
    '- ファイルの場所・名前・責務・公開メソッド名・キー割り当てが動いたか → CLAUDE.md(旧名を grep して残骸を消す)\n' +
    '- per-frame の呼び出し(追加・削除・改名・順序・実行条件)が動いたか → DEVELOP/CALLSTACK.md\n' +
    '- クラスの new 位置・状態(フィールド)の所有・参照共有・キャッシュが動いたか → DEVELOP/OWNERSHIP.md\n' +
    '- プレイヤーから見える挙動・数値が変わったか → DEVELOP/SPEC.md\n' +
    '手順は .claude/skills/develop-docs/SKILL.md(/develop-docs)。更新は同じ変更セットに含める。' +
    '不要と判断した場合はその理由を述べること。\n' +
    'プロジェクト全体・数十ファイルに及ぶ横断的な規則そのものが変わったときだけ ' +
    '.claude/skills/refactor-fixed/SKILL.md も書き換える(追記でなく全体を整合させる)。' +
    '2〜3モジュール間の責務調整は上の設計文書だけで足りる。';

  process.stdout.write(
    JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
    }),
  );
});
