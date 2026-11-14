// 雲の実験環境(tools/cloud-lab)のためだけのビルド。ゲーム本体の webpack.config.js とは
// 別にしてあるのは、出力先を docs/ から分けるため。撮影は本番ビルドを踏むので、クラス名を
// 残す minimizer だけは本体と同じものを置く(理由は webpack.config.js の同じ設定にある)。
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { EsbuildPlugin } = require('esbuild-loader');

module.exports = {
  cache: {
    type: 'filesystem',
    name: 'cloud-lab',
    cacheDirectory: path.resolve(__dirname, 'node_modules/.cache/webpack'),
  },
  // main が実験環境(index.html)、separate が実写の分離環境(separate.html)、
  // render-capture が描画経路の多スケール撮影(render-capture.html)。
  entry: {
    main: './tools/cloud-lab/main.ts',
    separate: './tools/cloud-lab/separate-main.ts',
    'render-capture': './tools/cloud-lab/render-capture-main.ts',
  },
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
      {
        test: /(Backbone|Structure|Motion)\.json$/,
        include: path.resolve(__dirname, 'src/assets/models'),
        type: 'asset/resource',
        generator: { filename: 'assets/[hash][ext]' },
      },
    ],
  },
  output: {
    filename: 'cloud-lab.[name].[contenthash].js',
    path: path.resolve(__dirname, '.cloud-lab'),
    // separated/ は cloud-lab:separate の生成物で、cloud-lab:compare が別のビルドをまたいで読む。
    // compare/ と shots/ は前の実行の表と絵で、次の実行の比較の根拠になる。reference/ は
    // cloud-lab:reference が取り込んだ台風の実写で、compare が比較の相手に読む。
    // reference-timeseries/ は cloud-lab:reference-timeseries が取り込んだひまわりの時系列で、
    // compare が実物の動きの相手に読む。history/ は compare が残す数値レポートの履歴で、
    // 変更の前後の差分を引く根拠になる。history-polar-masked/ は極帯マスク後の距離で
    // 履歴を計算し直した複製で、同じく残す。render-capture/ は描画経路の多スケール撮影で、
    // Slice B/C が実写・特徴量と突き合わせる根拠になる。reference-fine/ は Slice B の
    // 微細スケール実写参照で、Slice C が特徴量の相手に読む。reference-cloudtop/ は
    // MODIS Terra の雲頂高度の参照で、compare が雲頂の距離の相手に読む。ビルドの掃除で消さない。
    clean: { keep: /^(separated|compare|shots|reference|reference-timeseries|reference-fine|reference-fine-timeseries|reference-cloudtop|reference-cirrus|history|history-polar-masked|render-capture|render-capture-timeseries|render-capture-cirrus)[\\/]/ },
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
      template: './tools/cloud-lab/index.html',
      chunks: ['main'],
    }),
    new HtmlWebpackPlugin({
      template: './tools/cloud-lab/separate.html',
      filename: 'separate.html',
      chunks: ['separate'],
    }),
    new HtmlWebpackPlugin({
      template: './tools/cloud-lab/render-capture.html',
      filename: 'render-capture.html',
      chunks: ['render-capture'],
    }),
  ],
  devServer: {
    static: './.cloud-lab',
    port: 8083,
    open: true,
    liveReload: true,
    hot: false,
  },
};
