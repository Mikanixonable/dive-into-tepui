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
5. ERA5の時間平均、単位変換、経度wrap、緯度順、12枚への再格子化を固定する。
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

`--global` はERA5、GDAL、netCDF4、pyshp、Pillowが揃っても、BMNG/ETOPO/GSHHG/ERA5のwindow合成が接続されるまで
`RendererUnavailable`で停止する。実データの入力窓境界と共通encoder接続は実装したが、複数GeoTIFFの球面積再格子化、
線形RGB合成、GSHHGの空間被覆、ERA5の月平均再格子化は未完了であり、入力が無い環境でfixtureを本番生成の代わりにはしない。

## 実データ事前検査（2026-09-10）

`tools/earth-surface/preflight.py` を追加した。これは本文を取得せずHEADだけを送り、URLの応答、Content-Length、
形式、依存コマンド、空き容量、全球出力の下限をJSONへ記録する。代表領域の検査結果は次のとおりだった。

- BMNG A1: `200 image/tiff 314,235,313 bytes`
- ETOPO ice-surface N90W180: `200 image/tiff 4,093,982 bytes`
- ETOPO geoid N90W180: `200 image/tiff 12,312,902 bytes`
- GSHHG 2.3.7: `200 application/zip 149,157,845 bytes`
- ERA5: URL取得ではなく、1991–2020・全UTC時刻・指定変数を含むNetCDFの明示的なlocal exportが必要

再検査時点ではPillowだけが利用可能だったが、micromambaで`tools/earth-surface/environment.yml`を作成した後はGDAL/osgeo、
netCDF4、pyshp、`gdalinfo`/`ogrinfo`も利用可能になった。空き容量は約320GBで、
地形payloadの下限だけなら保存できる。
全43,690タイルのESTN payloadだけで、圧縮前かつbaseを含めて23,630,031,744 bytes（約22.0GiB）が必要になるため、
入力・中間・JPEG・気候mapを含む本番生成はこの環境では開始しなかった。これはpreflight時点の記録であり、その後の実データ取得結果は下記のとおりである。

ETOPO geoid実ファイルにはNoDataタグが無かったため、source manifestのgeoid契約を`noData: null`へ修正した。代表のBMNG、
ETOPO ice-surface/geoid、GSHHGの取得器実行は成功した。続いてraw-v3へBMNG 8枚、ETOPO ice-surface 288枚、ETOPO geoid 288枚、GSHHG 1件を取得し、585件のreceiptと約12GiBの入力本文を得た。ERA5 local exportは未完了である。
ERA5取得用の`tools/earth-surface/request-era5.py`はCDS APIの認証済み環境で実行する。

micromambaでの環境再現は次のコマンドで行う。

```sh
brew install micromamba
MAMBA_ROOT_PREFIX=.earth-surface/mamba micromamba create -f tools/earth-surface/environment.yml
```

この状態はfixture成功へ読み替えず、実データゲートをblockedとする。ERA5 local exportを配置し、複数ソースの窓合成を接続した後、次を実行してから
`earth-surface:bake --global` を再開する。

```sh
python3 tools/earth-surface/preflight.py --all --output .earth-surface/verification/preflight.json
python3 tools/earth-surface/fetch-source.py --source ... --region ...
python3 tools/earth-surface/bake.py --global --raw-root .earth-surface/raw-v3 --output /tmp/earth-real-bundle
```

事前検査の実測JSONは [`../../.earth-surface/verification/preflight.json`](../../.earth-surface/verification/preflight.json)
へ保存した（commit `ed53a902`）。この環境で取得したのはHEAD応答だけで、巨大な入力本文は取得していない。
したがってこのコミットはデータ生成完了を意味せず、fixtureを本番bundleへ読み替えていない。

全入力取得後に実行した`bake.py --global`は、最初に
`.earth-surface/raw-v3/era5-monthly-1991-2020/global.nc`が無いため終了した。ERA5を配置しても、現在の`RealDataRenderer`はGeoTIFFの窓境界と共通encoderまでで止まり、球面積再格子化、線形RGB合成、GSHHG被覆、ERA5気候map合成が未接続である。このため次の対策は、まずCDS認証済み環境でERA5をexport・検証し、その後にストリーミング可能なsource pyramidまたは同等の再格子化器を実装してから、z0〜z2の実データpilot、全z0〜z7生成の順で再開することである。
