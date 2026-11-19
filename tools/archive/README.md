# archive — 一回性の生成・取り込みツール

焼き込み済みの生成物を `src/assets/` へ書き出す一回性のスクリプト置き場。成果物は
リポジトリにコミット済みで、ふだんは回さない。生成物を焼き直すときだけ使う。

- `export-*.mjs`: コミット済みの生データ(`assets-src/`)や依存ライブラリから生成物を焼く。
- `fetch-*.mjs`: 外部 API・配布物から `assets-src/` へ生データを取り込む。実行のたびに接続する。

実行は `package.json` のスクリプト経由(`npm run export-coastline` など)。
ここにあるスクリプトは `tools/` 直下の共有モジュール(`png.mjs`・`orbit-family.mjs`・
`compile-source.mjs`・`chrome-session.mjs`)を `../` 経由で読む。
