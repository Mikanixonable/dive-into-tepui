// enemy-lab のスライダーの値を書き込む窓口。cloud-lab と同じ仕掛け(tools/cloud-lab-apply-tuning.cjs)で、
// 書き込み先だけが違う — ゲームの開発サーバ経由で実行中のゲームが読む git 管理外の上書きファイル
// (試すだけ。target: 'overrides')と、コードベースの既定値(src/physics/assembly-tuning.ts の
// ASSEMBLY_TUNING_DEFAULTS。target: 'defaults')。
'use strict';
const path = require('node:path');
const { createApplyTuningHandler } = require('./cloud-lab-apply-tuning.cjs');
const { setupOverridesReadAt } = require('./cloud-tuning-overrides-file.cjs');

const TUNING_PATH = path.resolve(__dirname, '../src/physics/assembly-tuning.ts');
const OVERRIDES_PATH = path.resolve(__dirname, '../.local/assembly-tuning-overrides.json');
const BLOCK_START = 'export const ASSEMBLY_TUNING_DEFAULTS = {';
const APPLY_ROUTE = '/__enemy-lab/apply-tuning';
// ゲームの開発サーバが配る上書きの読み口。
const OVERRIDES_ROUTE = '/__assembly-tuning/overrides';

// enemy-lab の開発サーバの setupMiddlewares へ渡す関数。書き込みの口を足す。
function setupApplyTuning(middlewares, devServer) {
  devServer.app.post(APPLY_ROUTE, createApplyTuningHandler(TUNING_PATH, OVERRIDES_PATH, BLOCK_START));
  return middlewares;
}

// ゲームの開発サーバの setupMiddlewares へ足す関数。上書きの読み口を足す。
function setupAssemblyOverridesRead(middlewares, devServer) {
  return setupOverridesReadAt(middlewares, devServer, OVERRIDES_ROUTE, OVERRIDES_PATH);
}

module.exports = { APPLY_ROUTE, OVERRIDES_ROUTE, setupApplyTuning, setupAssemblyOverridesRead };
