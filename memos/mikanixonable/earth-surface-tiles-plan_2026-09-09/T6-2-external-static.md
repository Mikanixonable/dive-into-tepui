# T6-2: 外部静的配信契約を保守する（本番任意）

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

## 目的

本番はGitHub Pagesとするが、将来の外部静的/CDNへ同じbundleを移せるよう、パッケージとHTTP契約を保守する。

## 実装範囲

1. fixture/全球bundleをearth/<datasetId>/へ版付き配置するlocal packageとreceiptを保守する。
2. 巨大bundleを通常のアプリbuildから分離する。
3. 公開後にmanifest、datasetId、12枚、base、tile-index、代表tileをremote-checkできるようにする。
4. 外部originを使う場合だけPages originへのGET/HEAD/OPTIONSをCORS許可する。
5. raw gzip本文はapplication/gzipで返し、Content-Encoding: gzipを付けない。
6. datasetId付きtile/base/climateはimmutable cache、manifestは短いcacheとする。

## 完了条件

- 認証情報が無いローカル環境でもpackageとlocal checkが再現できる。
- 外部originへのuploadは本番ゲートに含めず、未実施またはreceiptを明記する。

## 実装状況（2026-09-10）

`32a789ab` で版付きlocal package、receipt、GET/HEAD/OPTIONS、CORS、cache、raw gzip、remote-checkを実装した。
外部originへのuploadと実データbundleのremote-checkは未実施である。
