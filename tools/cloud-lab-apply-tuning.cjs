// cloud-lab のスライダーの値を書き込む窓口。webpack の開発サーバだけが組み込む(webpack.cloud-lab.config.js)。
// 書き込み先は 2 つ — ゲームの開発サーバ経由で実行中のゲームが読む git 管理外の上書きファイル
// (試すだけ。target: 'overrides')と、コードベースの既定値(src/render/earth-weather/cloud-tuning.ts の
// CLOUD_TUNING_DEFAULTS。target: 'defaults')。既定値で書き換えるのは右辺の数値だけで、コメントと他のコードには触れない。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { OVERRIDES_PATH, writeOverrides } = require('./cloud-tuning-overrides-file.cjs');

const TUNING_PATH = path.resolve(__dirname, '../src/render/earth-weather/cloud-tuning.ts');
const BLOCK_START = 'export const CLOUD_TUNING_DEFAULTS = {';
const BLOCK_END = '} as const;';
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
// 受け取る本体の上限 [byte]。調整値は 200 個ほどの数値で足りる。
const MAX_BODY_BYTES = 64 * 1024;
const ROUTE = '/__cloud-lab/apply-tuning';

// source の既定値表のうち values のキーの右辺を数値へ置き換える。表に無いキーがあれば missing へ挙げ、
// 何も書き換えない。changed は { key, from, to } の一覧で、右辺が式(6 * 3600 など)でも数値に畳まれる。
function rewriteTuningDefaults(source, values, blockStart = BLOCK_START) {
  const start = source.indexOf(blockStart);
  const end = start < 0 ? -1 : source.indexOf(BLOCK_END, start);
  if (end < 0) throw new Error(`${blockStart} の範囲が見つからない`);
  const bodyStart = start + blockStart.length;
  let body = source.slice(bodyStart, end);
  const changed = [];
  const missing = [];
  for (const [key, value] of Object.entries(values)) {
    if (!KEY_PATTERN.test(key) || typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`不正な項目: ${key}`);
    }
    const line = new RegExp(`^(  ${key}:\\s*)(.*?)(,\\s*(?://.*)?)$`, 'm');
    const match = line.exec(body);
    if (match === null) {
      missing.push(key);
      continue;
    }
    changed.push({ key, from: match[2], to: String(value) });
    body = body.replace(line, (_, head, __, tail) => `${head}${String(value)}${tail}`);
  }
  return { source: missing.length > 0 ? source : source.slice(0, bodyStart) + body + source.slice(end), changed, missing };
}

// 本体を上限つきで読み切る。
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('本体が大きすぎる'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function reply(response, status, body) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

// 開発サーバの POST の受け口を作る。blockStart は既定値表の書き出しの行(既定は雲の表)。敵の実験環境も同じ窓口を使う。本体は { target, values }。target が 'defaults' なら tuningPath の既定値表へ、
// 'overrides' なら overridesPath の上書きファイルへ values を書く(空の表は上書きの解除になる)。
// application/json だけを受け(別のサイトからの単純な POST では送れない)、Host と Origin が
// この開発サーバのものと一致するときだけ書く。値のキーは既定値表に実在するものだけ受ける。
function createApplyTuningHandler(tuningPath, overridesPath, blockStart = BLOCK_START) {
  return (request, response) => {
    const host = request.headers.host ?? '';
    const origin = request.headers.origin;
    const contentType = String(request.headers['content-type'] ?? '');
    if (!contentType.startsWith('application/json') || (origin !== undefined && new URL(origin).host !== host)) {
      reply(response, 403, { error: '受け付けない要求' });
      return;
    }
    readBody(request).then((text) => {
      const { target, values = {} } = JSON.parse(text);
      if (target !== 'defaults' && target !== 'overrides') {
        throw new Error(`知らない書き込み先: ${String(target)}`);
      }
      const result = rewriteTuningDefaults(fs.readFileSync(tuningPath, 'utf8'), values, blockStart);
      if (result.missing.length > 0) {
        reply(response, 409, { error: `既定値の表に無い項目: ${result.missing.join(', ')}` });
        return;
      }
      if (target === 'defaults') fs.writeFileSync(tuningPath, result.source);
      else writeOverrides(values, overridesPath);
      reply(response, 200, { target, changed: result.changed });
    }).catch((error) => reply(response, 400, { error: String(error.message ?? error) }));
  };
}

// webpack-dev-server の setupMiddlewares へ渡す関数。
function setupApplyTuning(middlewares, devServer) {
  devServer.app.post(ROUTE, createApplyTuningHandler(TUNING_PATH, OVERRIDES_PATH));
  return middlewares;
}

module.exports = { ROUTE, rewriteTuningDefaults, createApplyTuningHandler, setupApplyTuning };
