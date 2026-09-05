// src/ の TypeScript を一時ディレクトリへ CommonJS として起こし、Node から require できる
// ようにする。焼き込みスクリプトが実行時と同じ実装・同じレジストリを使うためのもので、
// 生成物は呼び出し側が dispose() で消す。
import { mkdtempSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoAssets = join(repoRoot, 'src', 'assets');

// 起こした先の src/assets/ を指す require を、リポジトリ上の実ファイルへ振り直す。焼き込み
// アセットは tsc が出力しないので、そのままでは解決できない。webpack が URL 文字列へ変える
// 画像は、node では実ファイルのパスを返して同じ形にする。一度だけ仕掛ければどの outDir にも効く。
let assetsRedirected = false;
function redirectAssets() {
  if (assetsRedirected) return;
  assetsRedirected = true;
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    const from = parent?.filename;
    if (from !== undefined && request.startsWith('.')) {
      const target = resolve(dirname(from), request);
      const marker = `${join('src', 'assets')}`;
      const at = target.indexOf(marker);
      if (at >= 0 && target.startsWith(repoRoot)) {
        return join(repoAssets, relative(join(target.slice(0, at), 'src', 'assets'), target));
      }
    }
    return resolveFilename.call(this, request, parent, ...rest);
  };
  // 画像アセットの import は、webpack なら URL 文字列になる。ここではパスをそのまま返す。
  for (const extension of ['.jpg', '.png']) {
    createRequire(import.meta.url).extensions[extension] = (module, filename) => {
      module.exports = filename;
    };
  }
}

// src/ の指定モジュール(`physics/cr3bp` のように src/ からの相対パスで指定)を、解決済みの
// 依存ごとコンパイルして読み込む。返り値の modules のキーは基底名の camelCase
// ('game/celestial/solar-system/earth-system' → earthSystem)。
export function loadSourceModules(names) {
  // 出力先はリポジトリの中へ置く — 外の一時ディレクトリからだと、起こしたモジュールが
  // require する three などの依存をどこからも解決できない。
  const outDir = mkdtempSync(join(repoRoot, 'node_modules', '.tepui-source-'));
  const entries = names.map((name) => join(repoRoot, 'src', `${name}.ts`));
  const program = ts.createProgram(entries, {
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    target: ts.ScriptTarget.ES2022,
    outDir,
    rootDir: repoRoot,
    // 焼き込みアセットの JSON は型を持たせない — 読ませると src/assets/ の 110MB を
    // 構文解析することになる。中身の型は実行時に validate する側が持つ。
    resolveJsonModule: false,
    skipLibCheck: true,
    esModuleInterop: true,
  });
  const emitted = program.emit();
  if (emitted.emitSkipped) {
    rmSync(outDir, { recursive: true, force: true });
    throw new Error('compile-source: src/ のコンパイルに失敗した');
  }

  redirectAssets();
  const require = createRequire(import.meta.url);
  const modules = {};
  for (const name of names) {
    const key = name.split('/').pop().replace(/-(.)/g, (_, c) => c.toUpperCase());
    modules[key] = require(join(outDir, 'src', `${name}.js`));
  }
  return { ...modules, dispose: () => rmSync(outDir, { recursive: true, force: true }) };
}
