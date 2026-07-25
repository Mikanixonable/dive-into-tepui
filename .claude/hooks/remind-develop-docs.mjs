// PostToolUse フック: src/**/*.ts を編集したら DEVELOP/ の設計文書の更新義務を思い出させる。
// 判定だけを行い、実際の更新内容は .claude/skills/develop-docs/SKILL.md に従う。
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
    `${posix} を変更した。設計文書の同期が必要か判定せよ:\n` +
    '- ファイルの場所・名前・責務・公開メソッド名・キー割り当てが動いたか → CLAUDE.md(旧名を grep して残骸を消す)\n' +
    '- per-frame の呼び出し(追加・削除・改名・順序・実行条件)が動いたか → DEVELOP/CALLSTACK.md\n' +
    '- クラスの new 位置・状態(フィールド)の所有・参照共有・キャッシュが動いたか → DEVELOP/OWNERSHIP.md\n' +
    '- プレイヤーから見える挙動・数値が変わったか → DEVELOP/SPEC.md\n' +
    '手順は .claude/skills/develop-docs/SKILL.md(/develop-docs)。更新は同じ変更セットに含める。' +
    '不要と判断した場合はその理由を述べること。';

  process.stdout.write(
    JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
    }),
  );
});
