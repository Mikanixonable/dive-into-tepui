// 生成モデルの調整値の上書きファイル(git 管理外)。cloud-lab の「ゲームで試す」が書き、ゲームの開発ビルド
// (webpack.config.js)が cloud-tuning-overrides.ts の代わりに読む。追跡されるコードを書き換えずに、
// ゲームで調整値の見た目を確かめるための経路。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const OVERRIDES_PATH = path.resolve(__dirname, '../.local/cloud-tuning-overrides.js');

// 上書きの一覧(id → 数値)を、ゲームが読む ES モジュールの文面にする。
function renderOverrides(values) {
  return `// cloud-lab が書く、調整値の上書き(git 管理外)。\nexport const CLOUD_TUNING_OVERRIDES = ${JSON.stringify(values, null, 2)};\n`;
}

// 上書きファイルを書く(ディレクトリが無ければ作る)。
function writeOverrides(values, overridesPath = OVERRIDES_PATH) {
  fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
  fs.writeFileSync(overridesPath, renderOverrides(values));
}

// 開発ビルドが差し替え先として読めるよう、無ければ空の上書きファイルを作る。
function ensureOverridesFile(overridesPath = OVERRIDES_PATH) {
  if (!fs.existsSync(overridesPath)) writeOverrides({}, overridesPath);
  return overridesPath;
}

module.exports = { OVERRIDES_PATH, renderOverrides, writeOverrides, ensureOverridesFile };
