const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const TerserPlugin = require('minimizer-webpack-plugin');

module.exports = {
  entry: './src/main.ts',
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  output: {
    filename: '[name].[contenthash].js',
    path: path.resolve(__dirname, 'docs'),
    clean: true,
  },
  optimization: {
    minimizer: [
      // three.js/WebGPU の TSL ノード実装は StandardNodeLibrary#addMaterial() で
      // マテリアルクラスの `.name`(コンストラクタ名)をキーにノード実装を登録し、
      // NodeMaterial.build() 側では `material.type`(コンストラクタ内のリテラル
      // 文字列。ミニファイの影響を受けない)で引き直す。既定の Terser 設定は
      // クラス名をマングルする(keep_classnames/keep_fnames が既定 false)ため、
      // 本番ビルドのみ両者が食い違い、getMaterialNodeClass() が null を返して
      // 全マテリアルが照明モデルを持たない素の NodeMaterial にフォールバックする
      // (地球が陰影のない白色で発光して見えるバグの原因)。クラス名を残して回避する。
      new TerserPlugin({
        terserOptions: {
          compress: { passes: 2 },
          keep_classnames: true,
          keep_fnames: true,
        },
      }),
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      title: 'dive-into-tepui',
      template: './public/index.html',
    }),
  ],
  devServer: {
    static: './docs',
    port: 8070,
  },
};
