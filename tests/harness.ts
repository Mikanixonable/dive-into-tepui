// 極小テストランナー。src/ を tsconfig.test.json で CommonJS にコンパイルし
// node で実行する回帰テスト用。ケースの登録先は層をまたいで1つ。
// 外部依存なし(素の node:assert のみ)。

export type TestFn = () => void | Promise<void>;

interface Case {
  name: string;
  fn: TestFn;
}

const cases: Case[] = [];

export function test(name: string, fn: TestFn): void {
  cases.push({ name, fn });
}

// filter を渡すと、名前にそれを含むケースだけを走らせる。1件も選ばれなかったときは
// 「全部通った」と見分けが付かないので失敗にする。
export async function runAll(filter?: string): Promise<void> {
  const selected = filter === undefined ? cases : cases.filter((c) => c.name.includes(filter));
  if (selected.length === 0) {
    console.error(`no test matched ${JSON.stringify(filter)}`);
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const c of selected) {
    try {
      await c.fn();
      console.log(`  ok  - ${c.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL - ${c.name}`);
      console.error(`    ${(err as Error).message}`);
    }
  }
  console.log(`\n${selected.length - failed}/${selected.length} passed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}
