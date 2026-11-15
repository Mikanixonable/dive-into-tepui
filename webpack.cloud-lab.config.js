// 雲の実験環境(tools/cloud-lab)のためだけのビルド。ゲーム本体の webpack.config.js とは
// 別にしてあるのは、出力先を docs/ から分けるため。撮影は本番ビルドを踏むので、クラス名を
// 残す minimizer だけは本体と同じものを置く(理由は webpack.config.js の同じ設定にある)。
const path = require('path');
const net = require('net');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { EsbuildPlugin } = require('esbuild-loader');

// 既定ポート preferred が埋まっていたら空きポートを返す。devServer.port の被りは
// EADDRINUSE で起動自体が落ちるので、設定側で先に空きを探す。
function preferredPort(preferred) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => {
      const any = net.createServer();
      any.once('listening', () => {
        const { port } = any.address();
        any.close(() => resolve(port));
      });
      any.listen(0);
    });
    probe.once('listening', () => probe.close(() => resolve(preferred)));
    probe.listen(preferred);
  });
}

const config = {
  cache: {
    type: 'filesystem',
    name: 'cloud-lab',
    cacheDirectory: path.resolve(__dirname, 'node_modules/.cache/webpack'),
  },
  // main が実験環境(index.html — GPU の写しのほか、天気モデルの全球の面を正距円筒で
  // 眺める「天気図」の写しを持つ)、separate が実写の分離環境(separate.html)、
  // render-capture が描画経路の多スケール撮影(render-capture.html)、
  // motion が生成雲の動きの計測用の読み出し(motion.html)、
  // weather-probe が気象状態の浮動小数の読み出し(weather-probe.html)、translucent が半透明雲の
  // 教師比較用の物理量の読み出し(translucent.html)。
  entry: {
    main: './tools/cloud-lab/main.ts',
    separate: './tools/cloud-lab/separate-main.ts',
    'render-capture': './tools/cloud-lab/render-capture-main.ts',
    motion: './tools/cloud-lab/motion-main.ts',
    'weather-probe': './tools/cloud-lab/weather-probe-main.ts',
    translucent: './tools/cloud-lab/translucent-main.ts',
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
    // motion-compare/ は cloud-lab:motion-compare が残す生成雲の動きの表で、感度・ablation・
    // 修正前後の差分を引く根拠になる。ビルドの掃除で消さない。
    clean: { keep: /^(separated|compare|shots|reference|reference-timeseries|reference-motion|reference-fine|reference-fine-timeseries|reference-cloudtop|reference-cirrus|history|history-polar-masked|render-capture|render-capture-timeseries|render-capture-cirrus|motion-compare)[\\/]/ },
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
    new HtmlWebpackPlugin({
      template: './tools/cloud-lab/motion.html',
      filename: 'motion.html',
      chunks: ['motion'],
    }),
    new HtmlWebpackPlugin({
      template: './tools/cloud-lab/weather-probe.html',
      filename: 'weather-probe.html',
      chunks: ['weather-probe'],
    }),
    new HtmlWebpackPlugin({
      template: './tools/cloud-lab/translucent.html',
      filename: 'translucent.html',
      chunks: ['translucent'],
    }),
  ],
  devServer: {
    static: './.cloud-lab',
    open: true,
    liveReload: true,
    hot: false,
  },
};

// 8083 を優先し、埋まっていたら別の空きポートで出す(同時起動や前の server の残りを
// 許すため — 出たポートは webpack-dev-server の起動ログに出る)。
module.exports = preferredPort(8083).then((port) => {
  if (port !== 8083) {
    console.warn(`[cloud-lab] ポート 8083 は使用中。代わりに http://localhost:${port}/ で出します。`);
  }
  config.devServer.port = port;
  // 同じキャッシュ名を分かち合う server どうしは互いのパックを読み違える(片方が古い
  // モジュールを拾う)ので、ポートごとに分ける。
  config.cache.name = `cloud-lab-${port}`;
  return config;
});
