// src/physics/ の TypeScript を一時ディレクトリへ CommonJS として起こし、Node から
// require できるようにする。焼き込みスクリプトが実行時と同じ物理実装・同じレジストリを
// 使うためのもので、生成物は呼び出し側が dispose() で消す。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// src/physics/ の指定モジュールを解決済みの依存ごとコンパイルして読み込む。
// 返り値の modules は指定した名前 → モジュールの実体。
export function loadPhysicsModules(names = ['cr3bp', 'halo', 'lagrange', 'solar-system']) {
  const outDir = mkdtempSync(join(tmpdir(), 'tepui-physics-'));
  const entries = names.map((name) => join(repoRoot, 'src', 'physics', `${name}.ts`));
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
    throw new Error('compile-physics: src/physics/ のコンパイルに失敗した');
  }

  const require = createRequire(import.meta.url);
  const modules = {};
  for (const name of names) {
    const key = name.replace(/-(.)/g, (_, c) => c.toUpperCase());
    modules[key] = require(join(outDir, 'src', 'physics', `${name}.js`));
  }
  return { ...modules, dispose: () => rmSync(outDir, { recursive: true, force: true }) };
}
