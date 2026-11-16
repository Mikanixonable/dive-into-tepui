// 描画テスト環境(tools/render-lab)のためだけのビルド。ゲーム本体の webpack.config.js とは
// 別にしてあるのは、出力先を docs/ から分けるため。撮影は本番ビルドを踏むので、クラス名を
// 残す minimizer だけは本体と同じものを置く(理由は webpack.config.js の同じ設定にある)。
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { EsbuildPlugin } = require('esbuild-loader');
const { openDevPageWhenReady } = require('./tools/open-dev-page.cjs');

module.exports = (env, argv) => ({
  cache: {
    type: 'filesystem',
    // production(撮影)と development(server)でキャッシュ名を分ける — 片方のモードが書いた
    // モジュールをもう片方が読むと、innerGraph で畳んだ依存のテンプレートが無く
    // No template for dependency で落ちる(webpack.config.js と同じ仕掛け)。
    name: `render-lab-${argv.mode ?? 'development'}`,
    cacheDirectory: path.resolve(__dirname, 'node_modules/.cache/webpack'),
  },
  entry: './tools/render-lab/main.ts',
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
      {
        test: /\.(png|jpe?g)$/,
        type: 'asset/resource',
      },
      {
        test: /\.cube$/,
        type: 'asset/source',
      },
      {
        // 船モジュールの統合 GLB バイナリは main JS へ埋め込まず、起動時に fetch する。
        test: /\.(glb|gltf)$/,
        type: 'asset/resource',
        generator: { filename: 'assets/[hash][ext]' },
      },
    ],
  },
  output: {
    filename: 'render-lab.[contenthash].js',
    path: path.resolve(__dirname, '.render-lab'),
    clean: true,
  },
  optimization: {
    minimizer: [
      new EsbuildPlugin({
        target: 'es2020',
        keepNames: true,
      }),
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './tools/render-lab/index.html',
    }),
  ],
  devServer: {
    static: './.render-lab',
    port: 8082,
    // 同じアドレスのタブが既にあれば再利用して開く(tools/open-dev-page.cjs)。
    open: false,
    onListening: openDevPageWhenReady,
    liveReload: true,
    hot: false,
  },
});
