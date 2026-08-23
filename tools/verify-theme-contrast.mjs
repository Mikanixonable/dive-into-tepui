// 全テーマのSemantic色が、標準テキストのコントラスト基準を満たすか確認する。
// theme.ts はブラウザ向けのため、ここではTypeScriptの単一ファイル変換後に評価する。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);

const source = fs.readFileSync(new URL('../src/game/theme.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const module = { exports: {} };
new Function('exports', 'module', 'require', output)(module.exports, module, require);

const issues = module.exports.allThemeContrastIssues();
if (issues.length > 0) {
  for (const issue of issues) {
    console.error(`${issue.themeId}/${issue.pair}: ${issue.ratio.toFixed(2)}:1 < ${issue.minimum}:1`);
  }
  process.exitCode = 1;
} else {
  console.log(`Theme contrast check passed: ${module.exports.THEME_PRESETS.length} themes.`);
}
