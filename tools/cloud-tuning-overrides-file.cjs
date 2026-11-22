// 生成モデルの調整値の上書きファイル(git 管理外)。cloud-lab の開発サーバがスライダーの値を書き、
// ゲームの開発サーバ(webpack.config.js)が GET ルートで配る — ゲームは実行中に拾って雲場へ
// 反映する。追跡されるコードを書き換えずに、ゲームで調整値の見た目を確かめるための経路。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const OVERRIDES_PATH = path.resolve(__dirname, '../.local/cloud-tuning-overrides.json');
// ゲームの開発サーバが配る上書きの読み口。
const OVERRIDES_ROUTE = '/__cloud-tuning/overrides';

// 上書きファイルを書く(ディレクトリが無ければ作る)。中身は id → 数値の JSON。
function writeOverrides(values, overridesPath = OVERRIDES_PATH) {
  fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
  fs.writeFileSync(overridesPath, `${JSON.stringify(values, null, 2)}\n`);
}

// 上書きファイルを読む。無い・壊れているときは空の表を返す(ゲームは既定値で動く)。
function readOverrides(overridesPath = OVERRIDES_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

// ゲームの開発サーバの GET の受け口を作る。毎回ファイルを読み直すので、書き込みは
// webpack のリビルドを起こさずに届く。ブラウザのキャッシュを当てにしないよう no-store で返す。
function setupOverridesRead(middlewares, devServer) {
  return setupOverridesReadAt(middlewares, devServer, OVERRIDES_ROUTE, OVERRIDES_PATH);
}

// 任意の route と上書きファイルの対で、同じ GET の受け口を足す。敵の実験環境の上書きもこれで配る。
function setupOverridesReadAt(middlewares, devServer, route, overridesPath) {
  devServer.app.get(route, (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(readOverrides(overridesPath));
  });
  return middlewares;
}

module.exports = {
  OVERRIDES_PATH, OVERRIDES_ROUTE, writeOverrides, readOverrides, setupOverridesRead, setupOverridesReadAt,
};
