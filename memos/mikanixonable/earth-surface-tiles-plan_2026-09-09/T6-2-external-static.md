# T6-2: 外部静的モード

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

このファイルは、T6のうちこの配信境界だけを実装するときに読む作業単位である。
共通の固定前提は親計画の§2、依存関係は§3を参照する。


**変更対象**: `tools/earth-surface/publish-static.mjs`（新規）、`remote-check.mjs`（新規）、
`earth-surface-source.ts`、CI設定。

1. fixture/全球bundleを`earth/<datasetId>/`へ版付き配置し、upload一覧、bytes、manifest hashのreceiptを出す。
2. 巨大bundleの生成/uploadを通常のアプリbuildから分離する。公開前にlocal `earth-surface:check`を通す。
3. 公開後にmanifest、datasetId、12枚、base、tile-index、代表tileの到達性をremote-checkする。
4. 外部originはPages originへGET/HEAD/必要なOPTIONSをCORS許可する。raw gzip本文は`application/gzip`で返し、`Content-Encoding: gzip`を付けない。
5. datasetId付きのタイルはimmutable cache、manifestは短いcacheまたはdatasetId変更で更新する。同じURLを上書きしない。
