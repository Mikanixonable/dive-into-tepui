// 敵の実験環境(tools/enemy-lab)のためだけのビルド。ゲーム本体の webpack.config.js とは
// 別にして、保存のたびに再読込でき、出力も docs/ から分ける。開発サーバは調整値の書き込み口
// (tools/enemy-lab-apply-tuning.cjs)を持つ。
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { setupApplyTuning } = require('./tools/enemy-lab-apply-tuning.cjs');

module.exports = (env, argv) => ({
  cache: {
    type: 'filesystem',
    name: `enemy-lab-${argv.mode ?? 'development'}`,
    cacheDirectory: path.resolve(__dirname, 'node_modules/.cache/webpack'),
  },
  entry: './tools/enemy-lab/main.ts',
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: 'esbuild-loader',
        options: { target: 'es2020' },
        exclude: /node_modules/,
      },
    ],
  },
  output: {
    filename: 'enemy-lab.[contenthash].js',
    path: path.resolve(__dirname, '.enemy-lab'),
    clean: true,
  },
  plugins: [new HtmlWebpackPlugin({ template: './tools/enemy-lab/index.html' })],
  devServer: {
    static: './.enemy-lab',
    port: 8084,
    open: true,
    liveReload: true,
    hot: false,
    setupMiddlewares: setupApplyTuning,
  },
});
