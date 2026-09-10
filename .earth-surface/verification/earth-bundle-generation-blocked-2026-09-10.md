# Earth bundle generation blocked

検査時点: 2026-09-10 (JST)

最新の検査対象は`workspace3`である。大容量入力は`.earth-surface/raw-v3/`へ取得中で、ERA5は未取得である。

## 実施した事前検査

`tools/earth-surface/preflight.py --all` を実行した。各URLには HEAD だけを送り、入力本文は取得していない。
全URLは HTTP 200 だった。

| source | regions | Content-Length 合計 |
| --- | ---: | ---: |
| BMNG July 2004 | 8 | 2,413,623,195 bytes |
| ETOPO ice-surface | 288 | 5,230,677,335 bytes |
| ETOPO geoid | 288 | 4,863,909,366 bytes |
| GSHHG 2.3.7 | 1 | 149,157,845 bytes |
| ERA5 monthly 1991–2020 | local export | 未計測 |

HEAD で確認できた入力の合計は 12,657,367,741 bytes である。z0–z7 の 43,690 タイルについて、ESTN
terrain payload だけの圧縮前下限は 23,630,031,744 bytes（base を含む）。検査時の空き容量は
319,941,214,208 bytes で、この下限だけで容量不足にはならない。

検査結果の完全なJSONは [preflight-latest.json](preflight-latest.json) に保存した。

## 停止理由

1. ERA5 の `1991-01`〜`2020-12`、全UTC24時刻、`t2m` と `tcc` を含む NetCDF local export が workspace および `/Users/pandeaconica` 配下に存在しない。manifest は ERA5 をURL取得ではなく `explicit_local_export` として要求しているため、入力がない状態では `fetch-source.py` を実行できない。
2. `bake.py` の `--global` 入口は `RealDataRenderer` を使う。入力窓境界と共通encoder接続は実装したが、複数GeoTIFFの球面積再格子化、BMNGの線形RGB合成、GSHHG空間被覆、ERA5月平均再格子化は未接続のため `RendererUnavailable` で停止する。`--fixture-global` は決定性と契約を検査するためだけにあり、`dataKind: synthetic_fixture` を付けて本番データと分離する。したがって、現在のコードでは全世界 bundle を生成できない。
3. micromambaで `tools/earth-surface/environment.yml` を構築し、`osgeo`、`netCDF4`、`pyshp` (`shapefile`)、`gdalinfo`、`ogrinfo`は利用可能になった。ERA5取得用`cdsapi`も環境へ追加したが、CDSの認証情報と利用規約同意が無いためlocal exportはまだ生成できない。

ETOPO geoidの実GeoTIFFにはNoDataタグが無かったため、`sources.json`のgeoid契約を`noData: null`へ修正した。surface elevation側の`-99999`契約は維持している。

以上により、代表ソースのfetchとfixture bakeは実行したが、ERA5不在と合成未接続のため全タイル bake、package、Pages preview stagingは実行していない。fixtureはPython契約テストとPages fixture検査に使ったが、本番bundleとして扱っていない。Pages側にも1 GB（1,000,000,000 bytes）の容量とz0〜z7全43690タイルのcoverage gateを追加し、超過や部分bundleをプレビュー公開しない。

## 再開条件

ERA5 の契約を満たす NetCDF export を `.earth-surface/raw-v3/era5-monthly-1991-2020/global.nc`（または manifest の `inputFiles` に明示した場所）へ配置し、`tools/earth-surface/validate-source.py` で時間軸・変数・単位・座標順を検査してから、入力ファイルの SHA-256 とサイズを `sources.json` に固定する必要がある。`tools/earth-surface/request-era5.py`はCDS API認証後の取得に使える。加えて、source pyramidまたは同等のストリーミング再格子化、GSHHG空間インデックス、BMNG線形RGB合成を実装し、`RealDataRenderer`の実ソースwindow合成と気候map生成を接続する必要がある。その後にだけ `bake.py --global`、manifest/tile-index/hash検証、ローカルpackage、`npm run build && npm run earth-surface:dev-stage && npm run dev`を再開する。
