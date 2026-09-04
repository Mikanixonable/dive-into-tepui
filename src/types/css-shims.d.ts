// webpack の style-loader/css-loader が CSS を副作用として取り込む。値を返さないので、
// tsc へは形の無い取り込みとして宣言する。
declare module '*.css';
