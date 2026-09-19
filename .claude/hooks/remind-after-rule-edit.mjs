// PostToolUse フック: 規則・検査・例外のファイルを編集したときに、検査を通すために緩めていないかを
// 問い直させる。判定だけを行い、規律そのものは DEVELOP/ARCHITECTURE.md「規則に合わないとき」に従う。

const RULE_FILES = [
  'DEVELOP/ARCHITECTURE.md',
  'DEVELOP/CODING-RULE.md',
  'tools/check-boundaries.mjs',
  'tools/boundary-allowlist.json',
  '.claude/hooks/check-boundaries.mjs',
  'eslint.config.mjs',
  'eslint-suppressions.json',
];

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let path = '';
  try {
    const input = JSON.parse(raw);
    path = input?.tool_response?.filePath ?? input?.tool_input?.file_path ?? '';
  } catch {
    process.exit(0);
  }

  const posix = String(path).replace(/\\/g, '/');
  if (!RULE_FILES.some((f) => posix === f || posix.endsWith(`/${f}`))) process.exit(0);

  const message =
    `【規則・検査の変更】${posix} を変更した。\n` +
    '規則の文面と判定を書き換えてよいのは、ユーザーが始めた再設計の中だけ(判定は同じ変更で規則に合わせる)。\n' +
    '例外(exempt)を足したなら、規則どおりに分けた形とそれで何が損なわれるかを理由に書き、報告に挙げよ。\n' +
    '許可リストは、消えた違反を消すときだけ触る(DEVELOP/ARCHITECTURE.md「規則に合わないとき」)。';

  process.stdout.write(
    JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
    }),
  );
});
