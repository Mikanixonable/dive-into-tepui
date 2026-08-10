// 極小テストランナー。src/physics/*.ts (純関数、DOM/THREE 非依存) を
// tsconfig.test.json で CommonJS にコンパイルし node で実行する回帰テスト用。
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

export async function runAll(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`  ok  - ${c.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL - ${c.name}`);
      console.error(`    ${(err as Error).message}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}
