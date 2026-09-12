// テストは webpack を通さず tsc/node で走る。tsc は焼き込みアセットの JSON を型付けも出力も
// しないので、コンパイル結果(tests/dist/)の中を指す require はそのままでは解決できない。
// tests/dist 配下の src/assets/ を指す require を、リポジトリ上の実ファイルへ振り直し、
// webpack がアセットへ与える変換と、webpack だけが持つ require.context を node で再現する。
// 読み込むのは import した側なので、この副作用モジュールをテスト本体より先に評価する。
import Module, { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// __dirname = <repo>/tests/dist/tests
const DIST_ASSETS = resolve(__dirname, '..', 'src', 'assets');
const REPO_ASSETS = resolve(__dirname, '..', '..', '..', 'src', 'assets');

// コンパイル結果の中の src/assets/ を指す絶対パスを、リポジトリ上の同じ位置へ振り直す。
// それ以外のパスはそのまま返す。
function repoAsset(target: string): string {
  if (!target.startsWith(DIST_ASSETS)) return target;
  return join(REPO_ASSETS, relative(DIST_ASSETS, target));
}

interface ResolverHost {
  _resolveFilename(request: string, parent: { filename?: string } | undefined, ...rest: unknown[]): string;
}

const host = Module as unknown as ResolverHost;
const resolveFilename = host._resolveFilename;

host._resolveFilename = function (request, parent, ...rest): string {
  const from = parent?.filename;
  if (from !== undefined && request.startsWith('.')) {
    const target = resolve(dirname(from), request);
    const mapped = repoAsset(target);
    if (mapped !== target) return mapped;
  }
  return resolveFilename.call(this, request, parent, ...rest);
};

// 画像は webpack の asset/resource ローダーが最終出力 URL の文字列へ、.cube は asset/source
// ローダーが中身のテキストへ変換する。node には同じ変換が無いので、実ファイルのパスと中身を
// それぞれ返すローダーを立てる。
// webpack 用に `require` がグローバル宣言されているので、node のローダー登録はここで作る。
const nodeRequire = createRequire(__filename);
for (const extension of ['.jpg', '.png']) {
  nodeRequire.extensions[extension] = (module, filename) => {
    module.exports = filename;
  };
}
nodeRequire.extensions['.cube'] = (module, filename) => {
  module.exports = readFileSync(filename, 'utf8');
};

// 差し込んだソースから代役を引くための、globalThis 上の名前。
const CONTEXT_FACTORY = '__repoRequireContext';

// webpack の require.context の代役を、それを呼ぶモジュールの位置 dir に対して作る。
// 返る関数は request の指すディレクトリを走査し、keys() が './<ファイル名>' を正規表現で
// 絞ってソートした列を、鍵での呼び出しがそのファイルの require 結果を返す context を作る。
function requireContextIn(
  dir: string,
): (request: string, recursive: boolean, pattern: RegExp) => WebpackRequireContext {
  return (request, recursive, pattern) => {
    const base = repoAsset(resolve(dir, request));
    const keys = readdirSync(base).map((name) => `./${name}`).filter((key) => pattern.test(key)).sort();
    return Object.assign((key: string): string => nodeRequire(join(base, key)) as string, { keys: () => keys });
  };
}

(globalThis as unknown as Record<string, unknown>)[CONTEXT_FACTORY] = requireContextIn;

// 差し替えたソースを評価する口。node のローダーが受け取るモジュールが持つ。
interface CompilableModule {
  _compile(code: string, filename: string): unknown;
}

// tsc の CommonJS 出力が先頭へ置くディレクティブ。
const STRICT_DIRECTIVE = '"use strict";';

// require.context を呼ぶモジュールは、代役をそのモジュールの require へ束縛してから評価する。
// 差し込み先はディレクティブの後ろで、**改行は足さない** — 前へ置くと strict モードが外れ、
// 改行を足すと例外とスタックの行番号が実ファイルからずれる。
const compileJs = nodeRequire.extensions['.js'];
nodeRequire.extensions['.js'] = (module, filename) => {
  const source = readFileSync(filename, 'utf8');
  if (!source.includes('require.context(')) return compileJs(module, filename);
  const bind = `require.context=globalThis.${CONTEXT_FACTORY}(__dirname);`;
  const directive = source.startsWith(STRICT_DIRECTIVE) ? STRICT_DIRECTIVE : '';
  const compilable = module as unknown as CompilableModule;
  return compilable._compile(`${directive}${bind}${source.slice(directive.length)}`, filename);
};
