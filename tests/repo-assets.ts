// テストは webpack を通さず tsc/node で走る。tsc は焼き込みアセットの JSON を型付けも出力も
// しないので、コンパイル結果(tests/dist/)の中を指す require はそのままでは解決できない。
// tests/dist 配下の src/assets/ を指す require を、リポジトリ上の実ファイルへ振り直す。
// 読み込むのは import した側なので、この副作用モジュールをテスト本体より先に評価する。
import Module from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

// __dirname = <repo>/tests/dist/tests
const DIST_ASSETS = resolve(__dirname, '..', 'src', 'assets');
const REPO_ASSETS = resolve(__dirname, '..', '..', '..', 'src', 'assets');

interface ResolverHost {
  _resolveFilename(request: string, parent: { filename?: string } | undefined, ...rest: unknown[]): string;
}

const host = Module as unknown as ResolverHost;
const resolveFilename = host._resolveFilename;

host._resolveFilename = function (request, parent, ...rest): string {
  const from = parent?.filename;
  if (from !== undefined && request.startsWith('.')) {
    const target = resolve(dirname(from), request);
    if (target.startsWith(DIST_ASSETS)) return join(REPO_ASSETS, relative(DIST_ASSETS, target));
  }
  return resolveFilename.call(this, request, parent, ...rest);
};
