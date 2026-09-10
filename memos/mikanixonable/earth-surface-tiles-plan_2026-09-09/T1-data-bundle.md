# T1: 実データから全球bundleを生成する

親計画: [earth-surface-tiles-plan_2026-09-09.md](../earth-surface-tiles-plan_2026-09-09.md)

## 目的

BMNG、ETOPO、GSHHG、ERA5から、初回公開用の全世界z0〜z7 bundleを決定的に生成する。
16地域は生成器の制御点として使い、全球生成の一部だけを意味しない。

## 実装範囲

変更対象は assets-src/earth-surface、tools/earth-surface、必要なデータ生成テストとする。

1. source manifestへ製品版、変数、単位、期間、CRS、鉛直基準、NoData、再格子化、
   入力SHA-256、帰属、生成器バージョンを固定する。ETOPOはice-surface elevationとgeoidだけを登録する。
2. 取得器へ再開、Content-Length、SHA-256、HTML応答拒否、形式、CRS、寸法、NoDataの検査を実装する。
3. GDALのwindowed readとchunk処理を使う。全球配列を一度にメモリへ展開しない。
4. GSHHGの複数ring、穴、日付変更線、南極ice-frontを扱う。
5. ERA5月平均（daily means）の単位変換、経度wrap、緯度順、12枚への再格子化を固定する。24時刻を保持するhour-of-day exportは使わない。
6. 全世界z0〜z7を生成し、次の制御点を必ず検査する。
   赤道、60度、両極、経度±180度、海岸、青い陸、氷、負標高陸、海底、
   ヒマラヤ、グリーンランド、南極、カスピ海、死海。
7. 色JPEG、ESTN地形、法線、GSHHG陸地被覆率、12か月1024×512 RGBA気候map、
   iceUnknown範囲、生成ログを出す。
8. earth-surface.json、tile-index.json、attribution.json、base ESTBを生成する。
9. ESTB/ESTNのheader、payload長、little-endian、NoData、hash、z=0対応を検査する。
10. tile-indexには全世界の利用可能タイルを明示する。欠落は意図した疎なデータではなく生成失敗として扱う。

## 完了条件

- 同一入力manifestから同一hashの出力を再生成できる。
- 全世界z0〜z7のtile-index件数が生成ログと一致する。
- 16制御点で有限値、画素方向、海陸判定、経度wrap、極、負標高が確認できる。
- source/output hash、帰属、生成環境をmanifestとログに残す。
- 入力データが取得できない環境では、fixtureを成功扱いにせず、実データゲートを未達成として記録する。

## 受け入れ検証

Python unit test、npm run earth-surface:test、npm run earth-surface:check、入力/出力hash、
NoData数、有限値、制御点解析画像、生成容量、生成時間を確認する。

## 注意

BMNG/ETOPOは数十GB級、ERA5は取得条件に依存し、GSHHGはfixture JSONより複雑である。
生成用の入力・中間・出力容量を先に確保する。

## 実装状況（2026-09-10）

`7b88aad7` で、入力manifestの版を検査するfixture source adapter、決定的な色・地形・気候エンコーダ、
`--fixture-global`の小規模生成入口を追加した。`87b6c8b5` と `d91ab5d3` ではERA5 local exportのNetCDF軸・単位・期間・変数、
取得済み入力のreceiptとSHA-256を検査するvalidatorと再現可能なenvironment.ymlを追加した。
`cb3161f5` ではCopernicusの `(0 - 1)` cloud fraction単位表記を取得時検査でも受け入れるようにした。
`6b707e54` では `tools/earth-surface/fixture-global.json` と `--fixture-global` の実行例を固定した。
fixtureのmanifestは `dataKind: synthetic_fixture` と明示され、本番データへ読み替えられない。

`--global` の実データ経路を接続した。`real_source.py` がGeoTIFFを行単位で読み、ETOPOは球面セル面積、BMNGは線形RGB、
ERA5は経度wrap・緯度順を含む球面セル面積で再格子化する。GSHHGはGDALのsupersample rasterizeで階層1〜5を符号合成し、
ガターのwrapと極端を埋める。実タイルは共通の`bake_region`、ESTN/JPEG encoderへ渡る。

## 実データ事前検査（2026-09-10）

`tools/earth-surface/preflight.py` を追加した。これは本文を取得せずHEADだけを送り、URLの応答、Content-Length、
形式、依存コマンド、空き容量、全球出力の下限をJSONへ記録する。代表領域の検査結果は次のとおりだった。

- BMNG A1: `200 image/tiff 314,235,313 bytes`
- ETOPO ice-surface N90W180: `200 image/tiff 4,093,982 bytes`
- ETOPO geoid N90W180: `200 image/tiff 12,312,902 bytes`
- GSHHG 2.3.7: `200 application/zip 149,157,845 bytes`
- ERA5: CDS認証なしでNCAR GDEX ds633.1公開ミラーの年別NetCDFを取得し、1991–2020月平均へ統合する

再検査時点ではPillowだけが利用可能だったが、micromambaで`tools/earth-surface/environment.yml`を作成した後はGDAL/osgeo、
netCDF4、pyshp、`gdalinfo`/`ogrinfo`も利用可能になった。空き容量は約320GBで、
地形payloadの下限だけなら保存できる。
全43,690タイルのESTN payloadだけで、圧縮前かつbaseを含めて23,630,031,744 bytes（約22.0GiB）が必要になるため、
入力・中間・JPEG・気候mapを含む本番生成はこの環境では開始しなかった。これはpreflight時点の記録であり、その後の実データ取得結果は下記のとおりである。

ETOPO geoid実ファイルにはNoDataタグが無かったため、source manifestのgeoid契約を`noData: null`へ修正した。代表のBMNG、
ETOPO ice-surface/geoid、GSHHGの取得器実行は成功した。続いてraw-v3へBMNG 8枚、ETOPO ice-surface 288枚、ETOPO geoid 288枚、GSHHG 1件を取得し、585件のreceiptと約12GiBの入力本文を得た。
ERA5取得用の`tools/earth-surface/fetch-era5-gdex.py`は、CDS API認証を必要としないNCAR GDEX公開ミラーから2変数を年単位で取得し、検証可能な`global.nc`へ統合する。CDS APIから取得する場合は従来の`request-era5.py`も利用できる。

ERA5は60個の年別ファイルを取得し、360か月・721×1440格子の`global.nc`（1,072,030,912 bytes）へ統合した。全入力validatorは585件の既存receiptと統合ERA5 receiptを検証し、source manifest hashを固定した。

micromambaでの環境再現は次のコマンドで行う。

```sh
brew install micromamba
MAMBA_ROOT_PREFIX=.earth-surface/mamba micromamba create -f tools/earth-surface/environment.yml
```

この状態はfixture成功へ読み替えず、実データゲートを分けて記録する。ERA5取得・入力検証・単一実タイル生成は完了したが、全量bundle生成は未完了である。

```sh
python3 tools/earth-surface/preflight.py --all --output .earth-surface/verification/preflight.json
python3 tools/earth-surface/fetch-source.py --source ... --region ...
python3 tools/earth-surface/bake.py --global --raw-root .earth-surface/raw-v3 --output /tmp/earth-real-bundle
```

事前検査の実測JSONは [`../../.earth-surface/verification/preflight.json`](../../.earth-surface/verification/preflight.json)
へ保存した（commit `ed53a902`）。この環境で取得したのはHEAD応答だけで、巨大な入力本文は取得していない。
したがってこのコミットはデータ生成完了を意味せず、fixtureを本番bundleへ読み替えていない。

## 再挑戦の実測と残る制約（2026-09-10）

- 最初のGDEX取得はurllibのタイムアウトで失敗した。curlの再試行・途中ファイル・並列取得へ切り替え、60ファイルを取得して統合した。
- TCCに公開ファイル由来の`1.0000048`があったため、±1e-5以内だけを1へclampし、それを超える範囲は失敗させる。
- source idの版番号ドットをvalidatorが拒否していたため、`gshhg-2.3.7`を受け入れる正規表現へ修正した。
- z0の実タイルは約123秒（厳密経路）、低LODのGDAL平均経路では約60秒で生成でき、ESTN/JPEGまで成功した。
- 気候mapは1024×512、月平均ERA5 12枚の配列生成まで成功した。海域は気候標高を0mにし、契約の[-1000,9000]mへclampする。
- 低LODではsource pixel数が多すぎるため、z0〜z1だけGDALのC平均を使う。これはsRGB空間平均を含む近似であり、高LODの球面面積・線形RGB経路と同一の精度ではない。全LODで科学的精度を優先する場合は、緯度sin重み付きsource pyramidを先に生成し、この近似経路を廃止する。
- `--max-zoom 0`のz0 pilotを生成し、tile-index、base ESTB、12枚の気候map、manifestを検査する。pilotが成功しても、圧縮前の地形payloadだけで約22GiBある全z0〜z7生成とPages配置は別ゲートとして実測する。

preflightを3回のHEAD再試行付きへ変更した後、全URL検査は`ready_for_acquisition`となった。入力容量のHEAD合計は
13,773,197,955 bytes、空き容量は276,125,216,768 bytes、地形payload下限は23,630,031,744 bytesだった。
実測JSONは [`../../.earth-surface/verification/preflight-latest.json`](../../.earth-surface/verification/preflight-latest.json)、
ERA5単体は [`../../.earth-surface/verification/era5-validation.json`](../../.earth-surface/verification/era5-validation.json)、
全入力は [`../../.earth-surface/verification/source-validation-latest.json`](../../.earth-surface/verification/source-validation-latest.json) に保存した。

`--max-zoom 0`の実bundleは`.earth-surface/bundle`へ生成し、`earth-surface:check`（2タイル、12気候map）、
`earth-surface:package`、`earth-surface:dev-stage`を通過した。`npm run dev`（http://127.0.0.1:8082）から
manifest、tile-index、`tiles/0/0/0.jpg`、`climate/01.png`をHTTP 200で取得した。これはz0 pilotの完了であり、
全z0〜z7の生成・Pagesプレビュー・実WebGPU画面の完了ではない。
