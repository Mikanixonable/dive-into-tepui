// 作曲用プレビュー(tools/bgm-lab)のためだけのビルド。ゲーム本体の webpack.config.js とは
// 別にしてあるのは、こちらは保存のたびに再読込したい(本体は実行中に再読込されると困る)ため。
// 出力先も分けてあり、docs/ には触れない。
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
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
    open: true,
    liveReload: true,
    hot: false,
  },
};
