// 描画テスト環境(tools/render-lab)のためだけのビルド。ゲーム本体の webpack.config.js とは
// 別にしてあるのは、出力先を docs/ から分けるため。撮影は本番ビルドを踏むので、クラス名を
// 残す minimizer だけは本体と同じものを置く(理由は webpack.config.js の同じ設定にある)。
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { EsbuildPlugin } = require('esbuild-loader');

module.exports = {
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
        // タンパク質の構造・モーション JSON(数十MB)は本体と同じく別ファイルへ書き出し、
        // import 元へは URL 文字列を渡す。ここを落とすと fetch 先が生成されず、
        // タンパク質のケースだけが「asset が無い」で落ちる。
        test: /(Structure|Motion)\.json$/,
        include: path.resolve(__dirname, 'src/assets/models'),
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
    open: true,
    liveReload: true,
    hot: false,
  },
};
