// 作曲用プレビュー(tools/bgm-lab)のためだけのビルド。ゲーム本体の webpack.config.js とは
// 別にしてあるのは、こちらは保存のたびに再読込したい(本体は実行中に再読込されると困る)ため。
// 出力先も分けてあり、docs/ には触れない。
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { openDevPageWhenReady } = require('./tools/open-dev-page.cjs');

module.exports = (env, argv) => ({
  cache: {
    type: 'filesystem',
    // モード間でキャッシュ名を分ける(webpack.config.js と同じ仕掛け) — production が書いた
    // モジュールを development が読むと、畳まれた依存のテンプレートが無く落ちることがある。
    name: `bgm-lab-${argv.mode ?? 'development'}`,
    cacheDirectory: path.resolve(__dirname, 'node_modules/.cache/webpack'),
  },
  entry: './tools/bgm-lab/main.ts',
  resolve: {
    extensions: ['.ts', '.js'],
  },
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
    filename: 'bgm-lab.[contenthash].js',
    path: path.resolve(__dirname, '.bgm-lab'),
    clean: true,
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './tools/bgm-lab/index.html',
    }),
  ],
  devServer: {
    static: './.bgm-lab',
    port: 8081,
    // 同じアドレスのタブが既にあれば再利用して開く(tools/open-dev-page.cjs)。
    open: false,
    onListening: openDevPageWhenReady,
    liveReload: true,
    hot: false,
  },
});
