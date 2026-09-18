// PostToolUse フック: 規則・検査・例外のファイルを編集したときに、検査を通すために緩めていないかを
// 問い直させる。判定だけを行い、規律そのものは DEVELOP/ARCHITECTURE.md「違反が出たとき」に従う。

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
    '検査を通すために規則の文面・判定・例外・許可リストを緩めたのなら、戻してコードを直せ。書き換えてよいのは、\n' +
    'ユーザーが決めた規則の変更を反映するとき(判定は同じ変更で規則に合わせる)と、消えた違反を許可リストから\n' +
    '消すときだけ。規則か検査が目的を外していると判断したなら、理由を添えてユーザーに問え\n' +
    '(DEVELOP/ARCHITECTURE.md「違反が出たとき」)。';

  process.stdout.write(
    JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
    }),
  );
});
