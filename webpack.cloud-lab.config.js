// 雲の実験環境(tools/cloud-lab)のためだけのビルド。ゲーム本体の webpack.config.js とは
// 別にしてあるのは、出力先を docs/ から分けるため。撮影は本番ビルドを踏むので、クラス名を
// 残す minimizer だけは本体と同じものを置く(理由は webpack.config.js の同じ設定にある)。
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { EsbuildPlugin } = require('esbuild-loader');

module.exports = {
  // main が実験環境(index.html)、separate が実写の分離環境(separate.html)。
  entry: {
    main: './tools/cloud-lab/main.ts',
    separate: './tools/cloud-lab/separate-main.ts',
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
    ],
  },
  output: {
    filename: 'cloud-lab.[name].[contenthash].js',
    path: path.resolve(__dirname, '.cloud-lab'),
    // separated/ は cloud-lab:separate の生成物で、cloud-lab:compare が別のビルドをまたいで
    // 読む。ビルドの掃除で消さない。
    clean: { keep: /^separated[\\/]/ },
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
  ],
  devServer: {
    static: './.cloud-lab',
    port: 8083,
    open: true,
    liveReload: true,
    hot: false,
  },
};
