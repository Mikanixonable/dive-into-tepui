# 地球地形 R2 データ修復プラン

調査・修復作業の記録と、本番配信データの差し替え手順のメモ。ローカル側の修正は
commit `d39fcf801`(devin/dev)で済んでいて、残るのは配信データの入れ替えだけ。

## 背景: 何が壊れていたか

配信中 `earth-2026-09-09-a` の地形バイナリ(`base/earth.bin.gz` と z5–z7 全タイル)が、
v1→v3 変換時にテクセルを `(nx, ny, roughness, 255)` の並びで書き出していた。
宣言レイアウトは `normal-xyz-rgb8-roughness-a8` なので、

- B(法線Zのスロット)に roughness が入り、法線Z が欠落
- A(roughness のスロット)が 255 固定

シェーダは宣言どおり読むため、法線が全地表で一方向へ傾き(昼夜境界が経度依存で
不自然に硬くなる原因)、水面判定 `a < 0.05` が全滅し、大陸が青すぎる見え方の
原因にもなっていた。

変換元の v1 bundle(`~/lab/.earth-surface/bundle`, schema 1, 4ch float16)は完全で、
deployed の R/G が v1 の nx/ny と ±1、B が roughness と完全一致することを確認済み。

## すでに済んでいるもの

- `tools/earth-surface/convert-legacy-terrain.mjs` — v1(f16×4) → v3(u8 RGBA) 変換ツール
- `tools/earth-surface/contract.mjs` — テクセル標本検査を追加(法線の単位長・A の
  roughness)。同種の破綻はこれ以降 `earth-surface:check` で弾かれる
- 回帰テスト(`test_contract.mjs` / `test_convert_legacy.mjs`)
- `.earth-surface/bundle-v3/` — v1 原本から再生成済み(43,008 タイル + base、
  manifest/color/climate も揃っている)。ゲーム上での見た目も確認済み(大陸の色、
  海のグリント、昼夜境界のグラデーションすべて正常)

## 本番差し替えの手順(未実施)

配信は `assets.mikanixonable.net/earth/earth-2026-09-09-a/` (R2)。
manifest の sources.json ハッシュは deploy 時点で正しかったので、
**地形 `.bin.gz` だけを正しいバイトへ差し替えれば manifest 側の更新は要らない**
(sha256 はファイルごとの内容ではなく sources.json 全体に対して掛かっているので、
念のため差し替え後に manifest と整合するかは要確認)。

案A: 同じ dataset ID で地形ファイルだけ上書き
1. `.earth-surface/bundle-v3/tiles/**/*.bin.gz` と `base/earth.bin.gz` を
   `earth/earth-2026-09-09-a/` 配下へ R2 へアップロード(43,009 ファイル)
2. CDN キャッシュがあれば対象パスの purge
3. 本番 URL の manifest を fetch して `schemaVersion: 3` と `layout` を確認、
   任意タイルの `.bin.gz` を取得して A≠255・B が法線Z 分布であることを spot-check
4. ゲームを本番 base URL で開いて目視確認

案B: 新しい dataset ID で配り直す(推奨)
1. `.earth-surface/bundle-v3/` を `earth/earth-2026-11-14-a/` などへ一式アップロード
2. `src/` 側のデフォルト `EARTH_SURFACE_BASE_URL` / manifest URL を新 ID へ更新
3. 旧 `earth-2026-09-09-a` は残したままロールバック用にする

同 ID 上書き(案A)は URL 変更が要らないが、クライアント側キャッシュや途中状態の
混在が起き得る。データそのものが壊れていた履歴があるので、新 ID(案B)のほうが
後追いしやすい。

## 確認用コマンド

```
# ローカル bundle の全量契約検査(済)
npm run earth-surface:check -- --input .earth-surface/bundle-v3

# アップロード後の spot-check 例
curl -s https://assets.mikanixonable.net/earth/earth-2026-09-09-a/earth-surface.json
curl -s https://assets.mikanixonable.net/earth/earth-2026-09-09-a/tiles/7/140/60.bin.gz | gunzip | xxd | head
```

## 既知の残課題

- 実際の R2 へのアップロード手段(rclone / wrangler / 管理画面)は未確認。
  `tools/earth-surface/` に publish 系スクリプトはないので手順は要調査。
- `.earth-surface/bundle-v3/` は git 管理外の生成物なので、作業マシンを変えるなら
  v1 bundle から `convert-legacy-terrain.mjs` で再生成可能。
