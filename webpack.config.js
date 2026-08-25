const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { EsbuildPlugin } = require('esbuild-loader');
const { version } = require('./package.json');

module.exports = {
  entry: './src/main.ts',
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: 'esbuild-loader',
        options: {
          target: 'es2015'
        },
        exclude: /node_modules/,
      },
      {
        test: /\.(png|jpe?g|svg|epk)$/,
        type: 'asset/resource',
      },
      {
        // タンパク質の構造・モーション JSON(数十MB)はバンドルへインライン化せず、
        // 別ファイルとして書き出して import 元へは URL 文字列を渡す(起動時ダウンロード量を
        // 抑えるため)。semantic/backbone など他の JSON は既定どおりバンドルへ含める。
        test: /(Structure|Motion)\.json$/,
        include: path.resolve(__dirname, 'src/assets/models'),
        type: 'asset/resource',
        generator: { filename: 'assets/[hash][ext]' },
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
      {
        test: /\.(woff|woff2|eot|ttf|otf)$/i,
        type: 'asset/resource',
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
      new EsbuildPlugin({
        target: 'es2015',
        keepNames: true,
      }),
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      title: 'dive-into-tepui',
      template: './public/index.html',
      favicon: './public/favicon.svg',
    }),
    new webpack.DefinePlugin({
      __APP_VERSION__: JSON.stringify(version),
    }),
  ],
  devServer: {
    static: './docs',
    port: 'auto',
    liveReload: false,
    hot: false,
  },
};
