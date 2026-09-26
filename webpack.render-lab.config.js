// 描画テスト環境(tools/render-lab)のためだけのビルド。ゲーム本体の webpack.config.js とは
// 別にしてあるのは、出力先を docs/ から分けるため。撮影は本番ビルドを踏むので、クラス名を
// 残す minimizer だけは本体と同じものを置く(理由は webpack.config.js の同じ設定にある)。
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { EsbuildPlugin } = require('esbuild-loader');

module.exports = {
  entry: {
    'render-lab': './tools/render-lab/main.ts',
    // 製品と同じ全球雲場の worker 供給を使えるよう、固定名で出す。
    'cloud-global-field-worker': './src/game/cloud/cloud-global-field-worker.ts',
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
        // タンパク質の主鎖・構造・モーション JSON(数十MB)は本体と同じく別ファイルへ書き出し、
        // import 元へは URL 文字列を渡す。ここを落とすと fetch 先が生成されず、
        // タンパク質のケースだけが「asset が無い」で落ちる。
        test: /(Backbone|Structure|Motion)\.json$/,
        include: path.resolve(__dirname, 'src/assets/models'),
        type: 'asset/resource',
        generator: { filename: 'assets/[hash][ext]' },
      },
    ],
  },
  output: {
    // worker entry は実行時に固定 URL で new Worker するので contenthash を付けない。
    filename: ({ chunk }) => chunk?.name?.endsWith('-worker')
      ? '[name].js' : '[name].[contenthash].js',
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
      // worker entry はページへ読み込ませない — new Worker の固定 URL として出すだけ。
      chunks: ['render-lab'],
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
