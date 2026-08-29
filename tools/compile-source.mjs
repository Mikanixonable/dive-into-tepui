// src/ の TypeScript を一時ディレクトリへ CommonJS として起こし、Node から require できる
// ようにする。焼き込みスクリプトが実行時と同じ実装・同じレジストリを使うためのもので、
// 生成物は呼び出し側が dispose() で消す。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// src/ の指定モジュール(`physics/cr3bp` のように src/ からの相対パスで指定)を、解決済みの
// 依存ごとコンパイルして読み込む。返り値の modules のキーは基底名の camelCase
// ('game/celestial/solar-system/earth-system' → earthSystem)。天体テクスチャの import は
// webpack が URL 文字列へ変換するので、node では実ファイルのパスを返すローダーで代える。
export function loadSourceModules(names) {
  const outDir = mkdtempSync(join(tmpdir(), 'tepui-physics-'));
  const entries = names.map((name) => join(repoRoot, 'src', `${name}.ts`));
  const program = ts.createProgram(entries, {
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    target: ts.ScriptTarget.ES2022,
    outDir,
    rootDir: repoRoot,
    resolveJsonModule: true,
    skipLibCheck: true,
    esModuleInterop: true,
  });
  const emitted = program.emit();
  if (emitted.emitSkipped) {
    rmSync(outDir, { recursive: true, force: true });
    throw new Error('compile-source: src/ のコンパイルに失敗した');
  }

  const require = createRequire(import.meta.url);
  require.extensions['.jpg'] = (module, filename) => { module.exports = filename; };
  const modules = {};
  for (const name of names) {
    const key = name.split('/').pop().replace(/-(.)/g, (_, c) => c.toUpperCase());
    modules[key] = require(join(outDir, 'src', `${name}.js`));
  }
  return { ...modules, dispose: () => rmSync(outDir, { recursive: true, force: true }) };
}
