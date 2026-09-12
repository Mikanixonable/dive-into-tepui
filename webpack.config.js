const fs = require('fs');
const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { EsbuildPlugin } = require('esbuild-loader');
const { version } = require('./package.json');

const DEFAULT_EARTH_SURFACE_DATASET_ID = 'earth-2026-09-09-a';
const EARTH_SURFACE_DEV_PUBLIC_PATH = `/earth/${DEFAULT_EARTH_SURFACE_DATASET_ID}/`;
const EARTH_SURFACE_BUNDLE_ROOT = path.resolve(__dirname, '.earth-surface/bundle');
const EARTH_SURFACE_LOCAL_MANIFEST_PATH = path.join(EARTH_SURFACE_BUNDLE_ROOT, 'earth-surface.json');
const DEFAULT_EARTH_SURFACE_R2_BASE_URL = 'https://assets.mikanixonable.net/earth/earth-2026-09-09-a/';
const DEFAULT_EARTH_SURFACE_R2_MANIFEST_URL = `${DEFAULT_EARTH_SURFACE_R2_BASE_URL}earth-surface.json`;
const configuredEarthSurfaceBaseUrl = process.env.EARTH_SURFACE_BASE_URL?.trim() ?? '';
const configuredEarthSurfaceManifestUrl = process.env.EARTH_SURFACE_MANIFEST_URL?.trim() ?? '';
const localEarthSurfaceManifestUrl = `${EARTH_SURFACE_DEV_PUBLIC_PATH.slice(1)}earth-surface.json`;
const earthSurfaceManifestUrl = configuredEarthSurfaceManifestUrl
  || (configuredEarthSurfaceBaseUrl.length > 0
    ? `${configuredEarthSurfaceBaseUrl.replace(/\/+$/, '')}/earth-surface.json`
    : fs.existsSync(EARTH_SURFACE_LOCAL_MANIFEST_PATH)
      ? localEarthSurfaceManifestUrl
      : DEFAULT_EARTH_SURFACE_R2_MANIFEST_URL);

module.exports = {
  entry: {
    main: './src/main.ts',
    'earth-surface-terrain-worker': './src/render/earth-surface-terrain-worker.ts',
  },
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
        // 配信 bundle のバイナリは圧縮済みの実体をそのまま URL 化する。
        // .bin.gz を HTTP の Content-Encoding として扱う設定はここには置かない。
        test: /\.bin(?:\.gz)?$/,
        type: 'asset/resource',
      },
      {
        test: /\.cube$/,
        type: 'asset/source',
      },
      {
        // タンパク質の主鎖・構造・モーション JSON はバンドルへインライン化せず、
        // 別ファイルとして書き出して import 元へは URL 文字列を渡す(起動時ダウンロード量を
        // 抑えるため)。semantic など他の JSON は既定どおりバンドルへ含める。
        test: /(Backbone|Structure|Motion)\.json$/,
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
    filename: ({ chunk }) => chunk?.name === 'earth-surface-terrain-worker'
      ? '[name].js' : '[name].[contenthash].js',
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
      chunks: ['main'],
    }),
    new webpack.DefinePlugin({
      __APP_VERSION__: JSON.stringify(version),
      __EARTH_SURFACE_BASE_URL__: JSON.stringify(configuredEarthSurfaceBaseUrl),
      // ローカルbundleがあればそれを使い、無ければ公開済みR2のmanifestへ切り替える。
      // 明示した環境変数は、ローカルbundleの有無より優先する。
      __EARTH_SURFACE_MANIFEST_URL__: JSON.stringify(earthSurfaceManifestUrl),
    }),
  ],
  devServer: {
    static: [
      {
        directory: path.resolve(__dirname, 'docs'),
        publicPath: '/',
      },
      {
        directory: EARTH_SURFACE_BUNDLE_ROOT,
        publicPath: EARTH_SURFACE_DEV_PUBLIC_PATH,
        watch: false,
      },
    ],
    port: 'auto',
    liveReload: false,
    hot: false,
  },
};
