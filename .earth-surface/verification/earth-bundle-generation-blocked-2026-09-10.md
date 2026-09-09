# Earth bundle generation blocked

検査時点: 2026-09-10 (JST)

worktree は `/Users/pandeaconica/lab/dive-into-tepui-earth-bundle`、branch は
`codex/earth-bundle-generation`、開始点は `workspace3` の `d2abc1e6` である。

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
323,875,684,352 bytes で、この下限だけで容量不足にはならない。

検査結果の完全なJSONは [preflight-latest.json](preflight-latest.json) に保存した。

## 停止理由

1. ERA5 の `1991-01`〜`2020-12`、全UTC24時刻、`t2m` と `tcc` を含む NetCDF local export が workspace および `/Users/pandeaconica` 配下に存在しない。manifest は ERA5 をURL取得ではなく `explicit_local_export` として要求しているため、入力がない状態では `fetch-source.py` を実行できない。
2. `bake.py` の `--global` 入口は `unavailable_global_renderer` を渡しており、入力が揃っても BMNG/ETOPO/GSHHG/ERA5 の window adapter が未接続のため `GlobalInputError` で停止する。したがって、現在のコードでは全世界 bundle を生成できない。
3. システム Python には `osgeo`、`netCDF4`、`pyshp` (`shapefile`)、`Pillow` がなく、`gdalinfo`/`ogrinfo`/`gdal-config` もない。requirements の GDAL 3.10.3 は native GDAL がないため一時 venv の dry-run 段階で停止した。Homebrew の GDAL 導入は依存取得中に中断し、リポジトリ内への導入は行っていない。

以上により、実データ fetch、staging、全タイル bake、package、Pages staging は実行していない。fixture や偽データは本番 bundle として扱っていない。

## 再開条件

ERA5 の契約を満たす NetCDF export を `.earth-surface/raw/era5-monthly-1991-2020/global.nc`（または manifest の `inputFiles` に明示した場所）へ配置し、入力ファイルの SHA-256 とサイズを `sources.json` に固定する必要がある。加えて、GDAL/osgeo、netCDF4、pyshp、Pillow を同一の再現可能な環境へ導入し、`bake.py` の実ソース window renderer と気候map生成を接続する必要がある。その後にだけ `fetch-source.py`、`bake.py --global`、manifest/tile-index/hash 検証、package、Pages staging を再開する。
