# 地球地表の標高陰影・地域タイル配信計画

作成日: 2026-09-09。改訂日: 2026-09-09（残作業の実装順を再整理）。手順1・1.5・2および4〜7の初期実装を反映し、残りの実装と検証を対象とする。
以下は実装済みの範囲、残作業、これから作るものと実装手順である。ファイル・行番号は計画検査時点の
参照であり、着手時にコードから位置を引き直す。

## 目的

地球へ接近したとき、地域の色模様と山肌の陰影から地形を読み取れるようにする。
全球画像の解像度に GPU 使用量を比例させず、写っている地域に必要な詳細だけを読み込む。
実在の画像・標高を使用し、太陽の向きに応じて地形の明暗が変わる地表を作る。

最初の手順で `DEVELOP/SPEC/RENDERING.md` の「地球の描画」の地表に関する冒頭を、
海・湖の反射に関する既存の要求と整合させて、次の文面へ更新する。

> - 写実表示の地球は、実在の地表の色と標高に基づく斜面の向きを持つ。山地は太陽の方向に
>   応じて明暗が変わり、地表の反射と陰影は他の天体・艦艇と同じ光源・反射モデルに従う。
> - 地球へ接近すると、見ている地域の地表が段階的に詳しく見える。詳細が届くまでの間も
>   全球の地表が見え、通信が失敗しても地表が欠けたり、視点操作やゲーム進行が止まったりしない。
> - 地表の模様と斜面の向きは地球上の位置に固定され、自転・視点移動・投影方式の切り替えで
>   地理的な位置がずれない。極域と経度の境界でも連続して見える。
> - 詳細度の変化で地表の明るさや陰影が跳ねず、遠くの細部がちらつかない。
> - 液体の海・湖の表面には海底・湖底の起伏による陰影を付けず、陸と氷の地形には斜面の
>   陰影を付ける。水域と陸域の区別に海抜の正負を用いない。

アルゴリズム、配信形式、キャッシュ容量、今回の実装範囲はこの計画に置く。
SPEC へ実装の識別子や性能上の打ち切り条件を書き込まない。

## 決めたこと

| 項目 | 採用する内容・理由 | 覆す場合に影響する手順 |
| --- | --- | --- |
| 対象 | 地球の写実表示。戦闘ビューとマップビューの両方。月・他天体への展開は今回含めない | 1・4・5・6 |
| 形状 | 基準楕円体のメッシュを使い、標高は陰影に反映する。山の輪郭、地形による遮蔽・落影、衝突、高度計、重力は今回の変更範囲に含めない | 1・3・5・6 |
| 画像 | NASA Blue Marble Next Generation の **2004年7月 Base Map**。雲を除いた合成画像で、地形陰影・海底陰影を加えた版を使わない | 2・3・6 |
| 標高 | NOAA ETOPO 2022 v1 の **15秒角 ice-surface elevation product** と同格子の geoid。描画の楕円体高は`ice-surface + geoid`、気候マップの標高は水域を除いたice-surfaceの正高を使う。氷床・棚氷は表面標高として扱い、海底面へ切り替えない | 2・3・5・6 |
| 水域 | GSHHG 2.3.7 の full resolution の階層ポリゴンから海・湖の被覆率を焼き、地表の水域と気候マップの陸らしさの両方に使う。南極は ice-front を使う | 2・3・5・6 |
| 気候マップ | 地形・海陸の静的地理入力はETOPO/GSHHGへ統一し、気温・雲量は全球を覆うERA5月平均平年値（1991–2020）から同じ12か月スロットへ焼く。各月の`earth-climate-MM.png`をRGBA8で生成し、R=2m気温、G=総雲量、B=水域を除いたETOPO ice-surface正高、A=GSHHG陸地被覆率とする。GEBCO由来の標高・海陸判定は使わない | 2・3・5・6・7 |
| 見せる細かさ | 全球を同じ格子で覆い、最高段は赤道で約611 m/texel。数百m～km規模の地域差・山地を対象とし、建物や道路の再現は達成目標に含めない | 2・3・4・6 |
| 配信 | 原データを取得・加工し、版を固定した自前の静的タイルとして配る。原データ提供者へプレイ中に加工要求を送らない | 2・3・7 |
| 画像の基準 | 同じ7月画像から全球ベース画像と詳細タイルを生成し、全球で共通の測光倍率を使う | 3・5・6 |
| モード | 模式図では詳細の要求を停止し、地形法線を幾何法線へ戻す。写実へ戻したときは残っているキャッシュを利用する | 4・5・6 |
| 地理座標 | 楕円体上の位置から外向き楕円体法線を求め、その法線を正距円筒のUVへ変換する共通関数を、地表のベース・タイル・roughness・気候マップと雲の場の読み書きで共有する | 1.5・4・5・6 |
| 法線空間 | タイルのRGBは天体固定の実楕円体法線。描画時は自転とカメラだけを含む`bodyToView`でview spaceへ変換し、`normalNode`へ直接渡す。模式図では同じ変換経路で幾何楕円体法線を選ぶ | 1.5・4・5・6 |
| 水域の粗さ | 写実表示の地球では青色比による旧推定を使わず、GSHHGの水域被覆率と新しい地表資源のroughnessだけを使う。月など他天体の既存経路は変えない | 3・5・6 |
| LODとメッシュ | 形状LODは現行の`SPHERE_LOD_LADDER`を再利用し、常に1段だけの楕円体メッシュを描く。テクスチャLODは別のCPU四分木とページ表で地域ごとに選ぶ。地域ごとのパッチメッシュや追加draw callは作らない。継ぎ目を減らす代わりに、可視判定・ページ表・2:1隣接制約を実装する | 1.5・4・5・6 |
| 表面APIの境界 | `CelestialSurface`は天体共通のライフサイクルとベース画像契約だけを持ち、地球固有の楕円体UV・四分木・気候・roughnessは`EarthSurface`/`EarthSurfaceMaterial`へ閉じ込める。月や他天体へEarth分岐を追加しない | 1.5・4・5・6 |
| 粗さ | `roughness`を直接扱い、水=0.05、非水域陸=0.80、明示的に分類できる氷=0.35の固定クラス値をマニフェストへ置く。GSHHG被覆率で水陸境界だけ連続化し、色の青さや標高閾値から氷を推定しない。ETOPOのice-surfaceは標高の選択であり、氷の面積マスクを提供するものとはみなさない。GSHHG L5で分類できない氷床は`iceUnknown`として陸の値を使う。波・濡れ・季節の変化は今回の対象外。値は物理測定値ではなく、同じ光源で比較する初期校正値として扱う | 3・4・5・6 |
| 実行環境 | このMacBook Pro（Apple M4 Pro、48GB RAM、16-core GPU、Metal 4）を基準機とし、ブラウザ名・版・実描画サイズを記録する。1920×1080と内蔵ディスプレイ解像度の両方で計測し、追加GPU 128MiBは初期目安であって品質を犠牲にして絶対上限にはしない | 1.5・4・6 |
| 公開範囲 | 本計画の実装成果はゲームへの組み込み、ローカル配信での検証、公開用データ一式まで。外部ストレージの契約・公開、main への取り込みは別の作業指示で行う | 7 |

仕様の選択はユーザーから一任されている。上表は採用する内容を明示するもので、実装途中で
同じ選択を繰り返しユーザーへ問い直すための保留事項ではない。

### 採用によって犠牲にするもの

気候の見た目を緯度だけの式から実際の分布へ近づけるため、12か月のERA5平年値を使う。これで
大陸・海岸・高地・季節の分布は改善するが、天気予報や特定年の再現にはならない。ERA5は1991–2020、
BMNGは2004年7月、ETOPOは別の測量時点であり、時代は完全には一致しない。12枚の気候画像とその
取得・前処理が増え、海面温度・局地的な雲の細部は低解像度のまま残る。この計画では「同じ時代の
気象を再現すること」より、全球で欠測がなく、気温と雲量が同じ平年値から出ることを優先する。

ETOPOのice-surfaceを選ぶことで南極・棚氷の見える地形は正しくなる一方、氷厚、融解、季節海氷の
変化は表現しない。ETOPO単体から氷の面積を確定できないため、GSHHG L5で明示できない氷床は氷の
roughnessへ分類せず、陸の固定値へ戻す。水域はGSHHGで決めるため、海抜の正負や海底深度を海陸判定へ流用できない。

LODは地域パッチを増やさず1枚の楕円体メッシュと仮想テクスチャを選ぶ。これによりdraw callと
ジオメトリの亀裂を抑えられるが、可視四分木・ページ表・祖先フォールバックを実装する負担と、
ページ表が粗いときの細部の取りこぼしを受け入れる。粗さは水域・非水域陸・氷の固定値にする。
色の青さで光沢を作らない代わりに、波、濡れ、積雪量、植生の季節変化は犠牲にする。将来それらが
必要になったときだけ、クラス値へ別の動的オーバーレイを重ねる。

縮小の必須経路はタイル基底レベルの線形フィルタと親子LODの線形混合とする。手作りの最大4点サンプラは
持たない。ハードウェアmipmapは手順1.5の実測で配列層の更新・ガター・バックエンド対応が確認できた場合
だけ追加し、mipmapがない経路でも同じ合成画像を合格にする。斜視の異方性を完全には制御しない代わりに、
ページ表のLOD選択と親タイルフォールバックでちらつきを抑える。

### LODの実装契約

形状LODとテクスチャLODを同じ値で選ばない。形状LODは天体全体の輪郭誤差を`screen-lod.ts`の
`SPHERE_LOD_LADDER`で決め、`CelestialSurface`と同じく一段だけを表示する。テクスチャLODは画面内の
地域ごとに選び、形状メッシュの段を増やすために地域パッチを作らない。

テクスチャの木はz=0の2枚（x=0..1, y=0）を根にし、各ノードを4分割してz=7まで持つ。ノードのキーは
`(z, x, y)`で、タイル内側は256×256画素、xは周期、yは極でクランプする。各ノードは次の状態を持つ。

```text
unloaded → requested → decoded → uploaded → visible
                         ↘ failed
visible → fadingOut → retired
```

`decoded`では色JPEGと`normal-material.bin.gz`がそろい、`uploaded`では色配列と法線配列の同じ層へ
書き込まれていることを条件にする。ページ表を先に更新しない。`visible`または遷移元のノードは
LRUの対象外とし、遷移完了後にだけ解放する。

各ノードの画面誤差は、楕円体上の四隅・中央・経度境界の保守的な点をviewへ投影して求める。
透視投影では各点の深度、直交投影では投影スケールを使う。東西・南北の両方向に隣り合う点を
投影し、画面上の辺長の最大値を使うため、`projectedTileWidthPx`は名前に反して両軸を含む。
日付変更線をまたぐノードは経度をunwrapしてから投影する。

```text
errorPx = max(projectedTileWidthPx, projectedTileHeightPx) / 256
errorPx > 2px かつ z < 7 なら分割候補
errorPx < 1px なら統合候補
```

視錐台または楕円体の地平線の外側に完全にあるノードは除外する。地平線をまたぐノードは残す。
隣接ノードのz差は最大1段に保つ。まず`errorPx`で分割・統合候補を作り、辺を共有するキーを
正規化（xは周期、極では経度を180°ずらして反転）してキューへ入れる。キューからz差が2以上の辺を
取り出し、粗い側を分割できるなら分割し、常駐層またはz上限で分割できないなら細かい側を親へ戻す。
差が1以下になるまで繰り返す。分割は可視子とその隣接子の色・法線がそろったフレームでだけcommitし、
待機中は親を表示する。これをCPU側のfrontier（現在表示する葉の集合）としてページ表へ焼く。

ページ表はz=7のタイルセルと同じ256×128のRGBA8テクスチャにする。最近傍サンプリングのみを許可し、
各セルを次のように解釈する。

```text
R: 現在のタイルのDataArrayTexture層 (255は全球ベース)
G: 親タイルのDataArrayTexture層
B: Rに対応する現在のタイルのz (0..7。R=255なら255)
A: 親から現在のタイルへの遷移率 (0..255)
```

粗いノードは、そのノードが覆うすべてのz=7セルへ同じ値を書き込む。シェーダはまず
`cx=floor(u*256)`、`cy=floor(v*128)`を求め、ページ表を最近傍で読み、`B`を丸めてzを復元する。
現在ノードのローカル座標は `tu=fract(u*2^(z+1))`、`tv=fract(v*2^z)` とし、配列の画素座標は
`(gutter + 0.5 + 256*tu) / 260`（vも同様）で求める。x周期のfractは`u=0/1`で同じ値にする。
親は現在ノードの整数座標を2で割って得たキー（z-1）から同じ式で標本化する。RとGを色・法線配列から読み、
Aで混ぜる。RまたはGが255なら別の全球ベースを読む。子が未取得のセルはページ表を書き換えず、
すでに表示中の親ノードのエントリを残す。したがってR=Gにして未取得の子を表すことはしない。
ページ表のセル更新は、色・法線・roughnessが同じ層へ公開された後にまとめて行う。

常駐層が足りない場合は、表示中ノード、遷移元、必要な親を固定し、画面中心から遠い葉を親へ戻して
frontierを128層以下にする。選択集合を粗くしても通信要求だけを増やさない。ページ表の更新、GPU層の
割り当て、タイル状態の変更はフレーム境界で一括して適用する。

### 追加レビュー: LOD以外で不足していた実装計画

| 不足していた具体性 | そのまま実装すると起きる問題 | この計画での修正方針 |
| --- | --- | --- |
| ソースマニフェストの構造 | 同じURLでも取得時期・変数・再格子化方法が変わり、再生成結果を比較できない | `sources.json`にデータセットID、変数、期間、CRS、NoData、再格子化、入力ハッシュ、帰属を必須化し、ERA5の2m気温・総雲量を別変数として固定する |
| タイルマニフェストとバイナリ境界 | JPEGと法線の対応、圧縮後の本文長、Float16の解釈が実装者ごとに分かれる | `earth-surface.json`と32bytesヘッダーをデータ契約へ追加し、クライアントは検証後だけ`decoded`へ進める |
| 法線生成の近傍規則 | 海岸・NoData・極で海底の勾配や不連続な法線が混ざる | GSHHG被覆率→有効な陸上中央差分→無効時は幾何法線→親段の面積重み平均、という順序を固定する |
| 地表Contextの所有権と同期順 | 地球の姿勢確定前にLODを選び、雲・地表・影で別の半軸を読む | `EarthSurface`がtiles・material・Contextを所有し、位置・姿勢・半軸・`bodyToView`確定後に1回だけ同期する |
| GPUアップロードの公開単位 | 色だけ新しくなり、古い法線や未初期化層が表示される | 色と地形を同じ層へ投入してからページ表をフレーム境界で更新する。通常画像とタイルは同じ優先度付きキューを使う |
| GPU機能と配列層更新の接点 | WebGPUの実装差やThree.js内部APIに依存し、層を更新できない環境で起動時に失敗する | `EarthSurfaceGpuAdapter`へ層書込み・ページ表更新・機能検査を閉じ込め、`maxTextureArrayLayers >= 128`、RGBA8線形化、RGBA16F線形標本化を手順1.5で確認する。不成立時は全球ベースだけへ固定する |
| CPUデコードとメモリ解放の契約 | HTTP要求数だけ制限しても、JPEG展開やgzip展開が同時に走り、p95と192MiB目安を越える | HTTP 6、デコード2、展開待機8組を別々に数え、各バッファの予約/解放をメトリクスへ出す。`AbortSignal`と世代番号をデコーダまで渡す |
| JPEGの色変換・向き | ブラウザのICC/EXIF処理で同じタイルの色やUVが環境ごとに変わる | 生成JPEGをベースラインJPEG（EXIF/ICCなし、回転なし）に固定し、`createImageBitmap`の色空間変換・premultiplyを明示する。対応しない場合は同一デコーダーへフォールバックする |
| 氷の面積マスク | ETOPOのice-surfaceを氷の分類データと誤解し、グリーンランド等を標高閾値で氷扱いする | 氷クラスはGSHHG L5で明示できる領域だけとし、その他を`iceUnknown`として陸のroughnessへ戻す。氷の分類範囲をマニフェストと検証画像へ記録する |
| HTTP失敗と版混在の扱い | 404や壊れた本文を再試行し続け、古いdatasetIdのタイルが残る | URLにdatasetIdを含め、404・形式不一致は版内で永久失敗、世代番号で遅着を拒否し、レスポンスのハッシュを検査する |
| 検証時の観測手段 | LODのちらつき・ページ表の誤り・GPU層の枯渇を画像だけでは判定できない | render-labへ選択z、frontier数、要求数、fallback率、GPU層使用数、`errorPx`の最大値を表示・保存する |

この表は懸念の列挙だけで終わらせず、後続の手順1.5、2、3、4、5、6の達成条件へ対応付ける。
実装中に別形式を採用する場合は、コードを書く前にこの契約と同じ検証可能性を持つことを確認する。

`sources.json`は少なくとも次の構造を持つ。`variable`ごとに単位・期間・集約方法を持たせるため、
URLだけを差し替えて同じdatasetIdを再利用できないようにする。

```json
{
  "schemaVersion": 1,
  "datasetId": "earth-2026-09-09-a",
  "sources": [
    {
      "id": "era5-monthly-1991-2020",
      "product": "monthly_averaged_reanalysis_by_hour_of_day",
      "variables": [
        {"id": "2m_temperature", "unit": "K", "aggregation": "utc_month_mean"},
        {"id": "total_cloud_cover", "unit": "fraction", "aggregation": "utc_month_mean"}
      ],
      "period": {"start": "1991-01", "end": "2020-12"},
      "crs": "EPSG:4326",
      "regrid": "spherical_cell_area_weighted_mean",
      "noData": null,
      "inputSha256": [],
      "attribution": []
    }
  ]
}
```

ETOPO/BMNG/GSHHGも同じ`id`、CRS、NoData、再格子化、入力ハッシュの項目を持つ。
`earth-surface.json`はこれを参照し、生成物の`datasetId`と入力ハッシュが一致しない場合を拒否する。

### 並行する地球グラフィックス計画との境界

`memos/mikanixonable/earth-graphics-implementation-plans_2026-09-09.md` は、地表計画が生成する
共有入力を使って雲・気象・発光・時間変化する水面を実装する別計画である。本計画はその計画へ
`earth-climate-MM.png`群を含むETOPO/GSHHG由来の地理資源とERA5気候資源、`datasetId`を渡す。雲側でGEBCOの取得、
独自の海陸マスク、別の標高資源を生成しない。動的な雲・水面の振舞いとSPEC上の責務は並行計画に残す。

共有する`EarthSurfaceContext`は次の読み取り専用契約にする。地表タイルの配信・GPU常駐はこのContextへ
移さない。

```text
EarthSurfaceContext
  datasetId
  earthSurfaceUv / ellipsoidAxes
  landFraction / waterFraction       # GSHHGの面積被覆率
  orthometricElevation               # ETOPO ice-surface、海底・湖底は0m
  staticIceMask                      # GSHHG L5で明示できる範囲だけ。その他はiceUnknown
  iceClassificationCoverage          # 氷として確定したセルの範囲。標高から推定しない
  coastOrIslandBoundary
  climateMonthTextures[12]           # ERA5のR=2m気温、G=総雲量、B=orthometricElevation、A=landFraction
```

`landFraction`と`waterFraction`、`orthometricElevation`は標高閾値から相互に導出しない。並行計画が
`landSeaMask`や`elevation`という別名を使う場合は、このContextで一度だけ変換し、雲側に変換式を複製しない。

### データの根拠と取得条件

この分野専用の文献調査スキルはないため、提供機関・製作者の一次資料を確認した。
下表はデータ取得契約の根拠であり、実装者が別文書を読まなければ手順を理解できない形にはしない。
確認日は2026-09-08～09。取得ツールは URL に加えてサイズ・SHA-256・元データの版・帰属を記録する。

| 入力 | 固定する契約 | 一次資料 |
| --- | --- | --- |
| BMNG | 全球86400×43200、15秒角相当、Plate Carrée / WGS84、2004年7月。21600×21600の8領域 A1～D2。海域と極域を含む。`world.200407.*` を使い、`world.topo.*` と `world.topo.bathy.*` は採用しない | [NASA Base Map](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/)、[製作者の技術資料](https://assets.science.nasa.gov/content/dam/science/esd/eo/content-feature/bluemarble/bmng.pdf) |
| ETOPO | 15°×15°の288領域、EPSG:4326、標高はm、EGM2008基準。**ice-surface elevation product** と geoid を対応させ、楕円体高は `ice-surface + geoid` で求める。原データには海底・湖底もあるが、気候用標高へは水域画素を渡さない | [NOAA製品ページ](https://www.ncei.noaa.gov/products/etopo-global-relief-model)、[User Guide](https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/docs/1.2%20ETOPO%202022%20User%20Guide.pdf) |
| 水域境界 | GSHHG 2.3.7 の ESRI Shapefile。L1～L4の包含関係で海・陸・湖・湖中島を区別し、南極はL5のice-frontを選ぶ。経度境界で分割されたポリゴンを扱う | [GSHHG配布元](https://www.soest.hawaii.edu/pwessel/gshhg/) |
| 気候入力 | ERA5の`monthly_averaged_reanalysis_by_hour_of_day`から、変数`2m_temperature`（K）と`total_cloud_cover`（0..1）を、UTCの1991–2020各月・全24時刻で算術平均し、月番号で12枚へ焼く。全球を一つの気候資料で覆うため、既存の`assets-src/climate/cloud-fraction/`にあるMODIS月平均雲量は比較検証用へ回し、実行時入力にはしない。標高と海陸はETOPO/GSHHGから同じ焼き込みで生成し、GEBCOの標高画像は入力契約から外す | [ERA5 monthly means](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels-monthly-means?tab=overview)、既存の気候入力マニフェスト、本計画のソースマニフェスト |

取得する URL の起点は次のとおり。配布ページから領域一覧を確定し、存在しないパスを推測で
大量取得しない。HTTP 200でもHTMLなら拒否し、GeoTIFF/ZIPの形式・CRS・寸法・欠測値を検査する。

```text
BMNG例:
https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/july/world.200407.3x21600x21600.A1_geo.tif
ETOPO ice-surface（surface_elev、氷床上は氷表面。bed_elevは使わない）:
https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/15s/15s_surface_elev_gtif/
ETOPO geoid一覧:
https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/15s/15s_geoid_gtif/
GSHHG:
https://www.soest.hawaii.edu/pwessel/gshhg/gshhg-shp-2.3.7.zip
```

気候マップの焼き込みでは、GSHHGの陸地被覆率を先に求め、ETOPOのice-surfaceから陸上画素だけを
面積平均する。ERA5の2m気温・総雲量は1991–2020の各月を同じ12か月スロットへ再格子化する。
再格子化は入力セルと出力セルの球面面積重み付き平均を使い、温度はKのまま、雲量は最後に0..1へ
検査する。欠測セルをゼロで埋めず、入力範囲を満たさない月は生成を失敗させる。
海・湖の底の値は気候用標高へ入れず0mとして扱い、海抜0m未満の陸地は陸地被覆率を保ったまま標高値を
残す。これにより、海底の深さが気温や雲の環境条件へ混ざらない。既存MODIS雲量は焼き込み結果の
比較検証にだけ使い、ERA5と混ぜて平均しない。

NASA Earth Observatory のクレジット、ETOPOのDOI・アクセス日、GSHHGのライセンス本文と
元データ・加工手順を、配信用データの `attribution.html` とソースマニフェストへ含める。
GSHHGはLGPLで配布されているため、加工マスクを含むデータ成果物の再配布条件をライセンス本文で
確認して同梱する。ゲームコードのライセンスとデータの条件を混同しない。

BMNGには合成由来の残留雲や季節境界があり、物理的なアルベドを直接測った画像でもない。
ETOPOの格子間隔も各地域の実効精度を保証しない。この計画は元データにない地形を生成しない。

### データの加工・タイル契約

1. **格子**: 地理緯度・経度の正距円筒。z=0で横2×縦1、z段では横 `2^(z+1)` ×縦 `2^z`。
   z=0～7、内側256×256texel。原点は西経180°・北緯90°、xは東向き、yは南向き。
   texelはセル中心に置く。経度は周期境界、極をまたぐ近傍は経度を180°ずらして反転させる。
2. **境界**: 各辺2texelの余白を隣接領域の同じ格子から取得し、配信寸法は260×260。
   地域を切り出してから端を複製する方法は使わない。生成処理は地球全体を一度にメモリへ展開せず、
   GDALの領域読み出しと領域ごとの作業ファイルで進める。
3. **色**: 260×260のベースラインJPEG、初期品質90、sRGB、EXIF回転・ICCプロファイルなしで出す。
   縮小・親子間の補間・平均の計算は線形RGBで行い、タイルごとに露出を正規化しない。クライアントは
   `createImageBitmap`の色空間変換とpremultiplyを明示し、デコーダー差を手順1.5で解析画像に記録する。
   全球ベースの`earth.jpg`も同じ画像から8192×4096で再生成する。
4. **地形データ**: ETOPO ice-surfaceとgeoidから求めた標高を事前処理で天体固定座標の法線へ変換する。
   配信するのは`normal-material.bin.gz`。ヘッダーにmagic・形式版・寸法・z/x/yを置き、本文は
   little-endian Float16のRGBA、RGB=単位法線XYZ、A=直接値のroughnessとする。GPUではRGBA16Fとして読む。
   法線を色画像としてデコードしない。位置を変形しない今回の描画で、生の全球DEMを二重保持しない。
   タイル投入は`EarthSurfaceGpuAdapter.uploadLayer(color, terrain, layer)`だけが行い、表示中の層を
   上書きしない。非公開の層へ色・地形を連続して書き、両方の完了を確認してからフレーム境界でswapする。
5. **水域**: ポリゴンとセルの球面面積交差を使って被覆率をラスタ化する。中心点判定や海抜の閾値は使わない。
   海・湖の法線は基準楕円体の法線とし、
   水底標高を差分へ混ぜない。海抜の低い陸地は陸として扱う。湖岸・海岸の陸側の勾配は、陸側だけの
   有効な近傍から求め、海底との差を崖として焼かない。
6. **氷**: 氷床・棚氷のroughnessは、GSHHGのice-front（L5）で明示されるセルだけを氷クラスへ置く。
   ETOPOのice-surfaceは表面標高の選択であり、標高差や白さから氷の面積を推定しない。BMNGの白さから
   氷を推定する処理は本番データへ入れない。GSHHGで分類できない氷床・海氷・季節積雪は`iceUnknown`として
   陸または水のクラスを使い、その範囲をマニフェストへ残す。氷のroughnessは固定クラス値とし、GSHHG被覆率で境界を連続化する。
7. **法線**: 地理緯度の東西・南北方向の距離をmで求め、楕円体高から斜面の向きを得る。
   東西と南北で同じ度→m倍率を使わない。高緯度では局所接平面に近傍を投影して勾配を求め、
   極でも退化しない天体固定XYZへ直して保存する。高さの誇張倍率は1。
   有効な東西近傍が両側にあれば`dzdx=(hE-hW)/(dE+dW)`、南北も同じ中央差分を使う。
   片側だけ有効なら一方向差分、両側とも無効なら基準楕円体法線へ戻し、局所東・北・上の基底で
   `normalize(-dzdx*east - dzdy*north + up)`を天体固定XYZへ変換する。
   [GDALの高緯度での勾配計算上の注意](https://gdal.org/en/stable/programs/gdaldem.html)も参照根拠とする。
8. **縮小**: 地形法線の各段は同じ領域の面積重み付きベクトル平均を正規化して生成する。
   roughnessと水域被覆率も同じ領域で縮小する。異なるzの境界で別の元データ・別の季節を混ぜない。
9. **ベース**: 画像に加え、全球の低解像度法線・roughnessを2048×1024で同梱する。
   これらの読み込みはゲーム初期化をブロックしない。詳細データが一切届かなくても全球が描ける。
   ベース地形はタイルと同じ本文形式で、magic=`ESTB`、z=255、x=y=0、寸法2048×1024とする。
10. **版**: マニフェストにdatasetId、形式版、格子、半軸、入力ハッシュ、測光倍率、段ごとの
    タイル数、ファイルサイズとハッシュの索引を持つ。索引はzごとに分けて遅延取得する。
    色・法線・粗さが一組そろったタイルだけを表示可能にする。
11. **地理UV**: 地表の実位置を `p = positionLocal * axes` とし、外向き楕円体法線を
    `n = normalize(p / axes²)` で求める。`u = atan(n.x, n.z)/(2π)+0.5`、
    `v = 0.5 - asin(n.y)/π` を、色・roughness・地形タイルの共通UVとする。実装では
    `earthSurfaceUv` の1つの関数だけを呼び、経度を畳むのはタイル索引を引く直前に限る。
    雲場の生成側は地理UVから楕円体上の放射方向へ逆変換し、生成時と描画時の写像を一致させる。
12. **法線の受け渡し**: `normal-material.bin.gz` のRGBは、半軸で変形した後の実楕円体表面の
   天体固定法線を保存する。GPU側は法線へ半軸の逆転置をもう一度掛けず、姿勢とview行列だけを
   含む`bodyToView`で変換した値を`normalNode`へ渡す。ゼロ勾配の幾何法線も同じ経路へ通し、
   模式図用の切り替えをシェーダグラフの再構築なしで行う。
13. **気候マップ**: `earth-climate-MM.png`（MM=01..12）は同じdatasetIdの生成物としてRGBA8/`NoColorSpace`
    で出す。RはERA5の1991–2020年同月平均2m気温、Gは同じ期間の総雲量、Bは水域を除いたETOPO
    ice-surfaceの正高、AはGSHHGの陸地被覆率とする。R/Bの線形符号化範囲は小領域試作後にマニフェストへ
    固定し、範囲外を黙ってclampしない。海底・湖底はB=0m、海抜0m未満の陸地は負値を保つ。雲・気象側は
    Aを陸らしさに使い、Bの標高閾値から海陸を再推定しない。GEBCOをフォールバックにも使わない。

14. **ページ表**: z=7のタイルセルと同じ256×128のRGBA8テクスチャを使い、最近傍サンプリングに固定する。
    R=現在の色・法線配列層、G=親層、B=Rに対応する現在のz（R=255ならBも255）、A=親子遷移率とし、
    255を全球ベースの予約値にする。
    CPU四分木のfrontierが変わったフレームだけ、色と法線が同じGPU層へ公開済みであることを確認して更新する。
15. **タイルファイル名とヘッダー**: 色は`earth/<datasetId>/{z}/{x}/{y}.jpg`、地形は同じキーの
    `earth/<datasetId>/{z}/{x}/{y}.normal-material.bin.gz`とする。地形本文の先頭32bytesはlittle-endian固定ヘッダー
    （magic=`ESTN`、formatVersion、headerBytes、width、height、z、x、y、channels=4、scalar=Float16、
    dataBytes）とし、以降は260×260×RGBA×Float16だけを置く。寸法・キー・本文長・ハッシュがマニフェストと
    一致しないファイルは`decoded`へ進めない。
    フィールド配置は`0:magic[4]、4:version u16、6:headerBytes u16、8:width u16、10:height u16、
    12:z u8、13:reserved u8、14:x u32、18:y u32、22:channels u8、23:scalar u8、24:dataBytes u32、
    28:reserved u32`で固定する。クライアントは本文を`DataView`でlittle-endianのu16列として検証し、
    実行環境に`Float16Array`がなくてもIEEE 754 binary16のビット列を変換せずGPUへ渡せるようにする。
16. **生成順序**: まずGSHHG被覆率を出し、次にETOPO ice-surface/geoidを同じセルへ読み、陸上だけの
    中央差分から法線を作る。東西・南北の有効な陸上近傍がないセルは幾何楕円体法線へ戻す。水域はその法線、
    海岸の部分セルは陸法線と幾何法線を被覆率で混ぜる。最後に面積重みで親段を縮小し、色・法線・roughness・
    被覆率を同じ入力窓から出す。
17. **マニフェスト**: `earth-surface.json`にはschemaVersion、datasetId、半軸、z/x/y格子、タイル内側と
    ガター、最高z、ページ表の寸法、GPU層容量、色・地形・気候のエンコード範囲、各ファイルのURL・MIME・
    `encodedBytes`（gzipを含む配信本文）・`payloadBytes`（展開後）・SHA-256を必須項目として置く。
    SHA-256は色JPEGの配信バイト列、地形の非圧縮32bytesヘッダー+本文へそれぞれ計算し、Content-Lengthが
    CDNで変わっても検証できるようにする。gzip版と`.bin`版は同じpayload hashを持つ。クライアントは
    マニフェストを検証してから要求を発行する。

### 実行時の要求・キャッシュ・描画

- **選択**: `LODの実装契約`に従い、描画直前のカメラと地球の当該フレームの姿勢・半軸、実drawing buffer寸法を使う。
  形状LODは天体全体、テクスチャLODは(z,x,y)ごとに選ぶ。四隅・中央を投影した`errorPx`で分割・統合し、
  視錐台と地平線で不可視の区画を除く。透視投影と直交投影を同じ投影行列から判定し、最高z=7で止める。
  frontierを2:1に整え、画面中心の`errorPx × projectedArea`が大きい区画、必要な粗い祖先、視野周縁の順に要求する。
  全子孫の先読みはしない。
- **地理座標**: メッシュの緯度パラメータをそのままEPSG:4326の緯度として使わない。
  `earthSurfaceUv`が楕円体上の位置から外向き楕円体法線を求め、ベース画像・タイル・roughness・
  気候マップ・雲の場が同じUVを読む。既存の球面UV関数を地表専用に複製しない。浮動原点からの巨大なworld
  座標を模様の座標に使わない。
- **気候入力**: `EarthSurfaceContext`が静的なGSHHG陸地被覆率・ETOPO ice-surface標高・datasetIdを
  一元管理し、`earth-climate-MM.png`は当月と翌月の2枚だけを遅延読込して補間する。雲・気象は
  AのGSHHG陸地被覆率を使い、旧GEBCO画像や標高閾値から別の海陸マスクを作らない。気候計算の海水域は
  標高0mとし、海底地形を気温・斜面補正へ入れない。
- **気候の時刻**: 月番号はゲームのシミュレーション時刻をUTCの暦へ変換し、月の日数で当月から翌月へ
  線形補間する。シミュレーション時刻が未設定のrender-labでは7月15日を固定する。12月から1月は周期で
  つなぎ、実在の特定年や天気を表す入力とは解釈しない。
- **要求上限**: 同時HTTP要求6、画像/gzipのデコード2、展開済み待機タイル8組、GPU投入は1フレーム1組を
  上限とする。各段の予約バイトを加算してから本文を受け取り、解放時に減算する。10秒でタイムアウト。
  失敗時の再試行は1秒・4秒後の2回まで、404と形式不一致はその版のセッション中は再試行しない。
  待機上限に達したら取得を止め、配列だけ増やさない。`AbortSignal`はHTTP、画像デコード、gzip展開の
  すべてへ渡し、世代番号が変わった本文はデコード完了後でも破棄する。
- **破棄**: 視点変更で不要になった要求はキャンセル可能にし、世代番号で遅着を拒否する。
  非表示・模式図では新規要求を止める。ゲーム終了時は要求、展開データ、GPU資源を解放する。
  HTTPキャッシュは版付きURLとサーバーのCache-Controlへ任せ、IndexedDB/Service Workerは追加しない。
- **GPU**: 固定長128層の `DataArrayTexture` を色RGBA8/sRGBと法線・roughness RGBA16Fで用意する。
  初期化時に`EarthSurfaceGpuAdapter`がWebGPUの2D配列、`maxTextureArrayLayers >= 128`、RGBA8の線形補間、
  RGBA16Fの線形補間を検査する。成立しない場合は詳細タイルを無効にして全球ベースだけを描き、個別画像へ
  逃げる実装は作らない。色配列は`SRGBColorSpace`、法線配列は`NoColorSpace`、必須経路のmag/min filterは
  `LinearFilter`を明示する。手順1.5でmipmapを採用できる場合だけmin filterを`LinearMipmapLinearFilter`へ
  切り替える。ページ表から常駐層を引き、取得完了時は非公開で確保済みの層だけ更新する。シェーダグラフを
  作り直さない。使用中と遷移元の祖先を固定し、残りをLRUで退避する。追加GPU確保128MiBは初期目安として
  記録するが、mipmapを含めた実測がこれを超えても精度要件を下げない。展開バッファ等の追加CPU保持は192MiBを目安にする。
- **縮尺の補間**: 必須経路はタイル基底レベルのLinearFilter、ページ表が選ぶz、親子2層の線形混合で構成する。
  経度のwrapをまたぐ微分を補正し、未取得なら常駐祖先、最後に全球ベースを読む。mipmapを追加する場合は
  各層の更新後に同じ層のmipmapを生成し、2texelガターで斜視・境界が合格することを確認する。
  手作りの異方性最大4点サンプラは初期実装へ入れない。
- **到着時の補間**: 新しい子は0.25秒で親から移行する。時間は壁時計の描画時間を使い、
  シミュレーションの時間加速へ連動させない。分割・統合の状態はノードごとに保持し、分割2px・
  統合1pxの間で往復しない。境界では粗い側へ連続的に寄せ、細かい側だけが完了した場合も
  区画境界の線が出ないようにする。色は線形、法線はベクトル補間後に正規化する。
- **法線の出力**: 保存した天体固定法線を、姿勢とカメラだけを含む`bodyToView`でview spaceへ変換して
  `normalNode`へ直接渡す。半軸を含むモデル行列の逆転置を追加で適用しない。模式図では同じグラフ内で
  幾何楕円体法線を選ぶ。ゼロ勾配で幾何法線との角度差が0.2°以下になることを必須条件にする。
  配信法線の補間とFloat16量子化の誤差をこの許容幅へ含める。
  Gバッファと通常の光源・影・大気の経路へ渡し、地表専用の照明を作らない。

### 配信と公開の境界

原データは `assets-src/earth-surface/raw/`、中間生成物・全タイルは `.earth-surface/` へ置き、
gitへ加えない。小さいベース資源、`earth-climate-01.png`～`earth-climate-12.png`、共有マニフェストだけを
アプリへ含める。
データ公開単位は `earth/<datasetId>/{z}/{x}/{y}/...` とし、HTTP GETで完結する静的ファイルにする。

開発時は `npm run earth-surface:serve` で `http://localhost:8084/` から配り、ゲームとrender-labは
同じマニフェストを読む。配信用成果物は別ディレクトリに書き出し、HTTPS配信・CORS・MIME・
キャッシュヘッダーの設定例も含める。圧縮タイルは標準の`Content-Encoding: gzip`で配り、fetchの
自動展開へ任せる。対応しない静的サーバー向けには同じ内容の`.bin`を生成し、アプリ側で二重展開しない。

本番のタイル公開URLはビルド入力 `EARTH_SURFACE_BASE_URL` で与える。これは配信先設定であり、
利用者向けの品質設定にはしない。公開ビルドでは未設定を検査で検出する。
全タイルを `docs/` やreleaseブランチへ詰め込む構成にはしない。
実際の公開オリジン・アカウントはこの作業で取得・作成していない。公開時はデータ配置とURLの
設定が必要であり、アプリだけmainへ取り込んだ状態を公開完了とは扱わない。

## 達成目標

1. 地球全域のz=0～7の画像・法線・roughnessタイルと、12か月分の`earth-climate-MM.png`が、同じ版・座標契約で再生成できる。
   最高段の全領域を含むこと、欠測・破損・入力版の混在をデータ検査で検出できる。
2. ヒマラヤ・アンデスの拡大で、太陽の方位を反転すると斜面の明暗が入れ替わる。
   ベース画像・詳細タイル・roughness・気候マップ・雲・雲影が同じ地理位置へ固定され、自転・移動・投影方式を
   変えても位置がずれない。赤道・北緯60°・北緯85°で同じ緯度経度の標識が一致する。
3. 太平洋・カスピ海の水面に水底の模様が陰影として現れず、海抜が負の陸地は陸のままになる。
   南極の氷床・棚氷では地形の陰影が見える。
4. 同じ解析的な入力から生成した隣接タイルの共通境界は、線形RGBの差2/255以下を目安、
   法線の角度差0.2°以下を初期目標として測定する。日付変更線と極をまたぐ場合も含む。
   JPEGの実データで2/255を越えても失敗扱いにせず、写真由来の境界とタイル処理由来の境界を区別して記録する。
5. 到着順を入れ替えたタイル、通信断、404、壊れた本文、素早い視点変更でも欠けた地表が出ない。
   dispose後の遅着はGPU・ページ表を変更せず、要求数・待機数・CPU/GPU保持量が上限を守る。
6. 写実/模式図、透視/直交、戦闘/マップを往復でき、模式図で詳細タイルの新規要求が発生しない。
   模式図の輪郭抽出へ地形法線の細部が混入せず、地形のない幾何楕円体の輪郭と一致する。
7. 色・法線・深度の画像を保存し、ゼロ勾配時に法線が幾何法線と0.2°以内で一致し、地形有効時にも
   深度と輪郭が同じであることを確認する。最高段より細かい実地形が見えるとは主張しない。ERA5の気候分布は
   平年値であり、特定年の天気を再現するとは主張しない。
8. 基準機（Apple M4 Pro、48GB RAM、16-core GPU、Metal 4）で、1920×1080と内蔵ディスプレイの
   実描画サイズを各300フレーム測る。追加CPU p95 2ms、追加GPU p95 3msは初期目安として記録し、
   未達でもGPU 128MiBを越えたことだけを理由に精度を落とさない。ブラウザ名・版・OS・測定値を保存し、
   キャッシュ選択・標本化・投入の費用と画像品質を同時に比較する。
9. 写実表示の地球で旧青色比によるroughness推定が使われず、色・水域被覆率・roughnessが同じ
   データ版から公開される。青い陸地と水域の境界を拡大しても、反射の帯がデータ境界だけに残らない。
10. 気候マップの標高と陸らしさがETOPO/GSHHGから生成され、GEBCOの標高・海陸判定が実行時に
    残らない。海底の深さが気温・地形性上昇流へ混ざらず、海抜0m未満の陸地は気候上も陸として扱う。

## 手順

各手順は独立してcommitできる単位で終える。段の途中で公開版へ反映しない。
検証結果や撮影画像は `.earth-surface/verification/` へ置き、人間の別のメモや既存の計測値を上書きしない。

### 実施済み: 手順1

`DEVELOP/SPEC/RENDERING.md`へ地表色・標高由来の法線、詳細未取得時の全球フォールバック、地理位置の固定、
LOD遷移の連続性、水域と陸・氷の陰影の違いを反映した。SPECへ実装識別子や容量制限は書き込んでいない。
コミットは`92dcc8ac`である。統合後の`npm run typecheck`も通過した。

### 手順1.5（残作業）: 座標・法線・GPU標本化の技術スパイク

座標変換、楕円体法線、四分木の`errorPx`選択、地平線・2:1隣接、frontier、ページ表、親子fade、GPU層の
予約・同時公開を実装した。対応するファイルは`src/render/earth-surface-coordinate.ts`、
`src/render/earth-surface-tiles.ts`、`src/render/earth-surface-gpu.ts`と、3つの解析テストである。
z=1以降のページ表セルが正しい粗いタイルを参照する回帰検査も含む。コミットは`ae362757`で、
`npm run typecheck`と`npm run test:render`（43/43）を通過した。

次の残作業を終えるまで手順1.5全体の達成とはしない。

| 残作業 | 完了条件 |
| --- | --- |
| `tests/render/earth-surface-material.test.ts` | `normalNode`・GBuffer復号・模式図の幾何法線を実GPUまたは検証可能な代替で確認する |
| `tools/render-lab/earth-surface-spike.ts`と個別の`package.json`入口 | 合成標識、親子fade、ガター、mipmap有無を画像で比較し、選択z・fallback・層数を保存する |
| JPEGデコード、sRGB/線形、実`DataArrayTexture`、WebGPU機能検査 | EXIF/ICCなし入力と非対応機能の全球ベース固定を実ブラウザで検証する |

### 手順2（残作業）: 元データ取得と小領域の再現可能な加工環境

ソース契約`assets-src/earth-surface/sources.json`、再開可能な検証付き取得器、fixtureを処理する
`tools/earth-surface/bake.py`、依存一覧、生成物除外、`earth-surface:fetch`・`earth-surface:bake`の入口を追加した。
ETOPO ice-surface/geoid、GSHHG、ERA5の版・変数・CRS・NoData・再格子化をmanifestへ固定し、GEBCOは除外した。
形式検査、GSHHG被覆率、海底を除いた法線、sRGB面積平均、ERA5の1991–2020全時刻検査、ESTN Float16とgzipを
fixtureで検証した。コミットは`65dbf4ff`（入口追加は`df2d52b7`）で、Pythonテスト15/15を通過した。

実データはまだ取得していないため、次を残す。

| 残作業 | 完了条件 |
| --- | --- |
| BMNG・ETOPO・GSHHGの実ファイルとERA5の固定NetCDF exportを取得 | 入力ハッシュと取得記録を確定し、HTML・破損・CRS・寸法・NoData不一致を拒否する |
| 北緯25～35°・東経80～90°、海岸・極域を含む計16領域を実加工 | 色、単位、向き、GSHHGマスク、法線、容量、所要時間を実測し、`.earth-surface/verification/`へ保存する |
| 実入力からのJPEG・気候マップ・タイル生成 | 小領域の出力が手順3の全球生成へそのまま渡せることを確認する |

### 手順3. 全球ピラミッド・法線・ベース資源を生成する

**目的**: 同じ地理基準のデータを、必要な縮尺で配れる形へ変換する。

| 変更が必要な箇所 | すること |
| --- | --- |
| `tools/earth-surface/bake.py` | 全球の領域処理、余白、親段、極の近傍、測光、GSHHG L5で明示できる範囲だけの氷クラスと`iceUnknown`、ERA5由来の12か月気候マップ、マニフェストを完成させる。生成順序と法線の有効近傍規則はデータ契約14～17へ従う |
| `tools/earth-surface/check.py` (新規) | 全領域の存在・入力ハッシュ・版・有限値・正規化・境界・水域・iceUnknown範囲・格子・32bytesヘッダー・本文長・payload hash・ページ表の予約層を検査する |
| `tools/earth-surface/test_bake.py` (新規) | 解析的な平面勾配、ゼロ標高、周期境界、極、湖中島、負標高の陸を使う検証を置く |
| `tools/earth-surface/serve.mjs` (新規) | `.earth-surface/` の静的データをポート8084で配る |
| `.earth-surface/bundle/` (生成物・git対象外) | `earth.jpg`、`earth-surface-base.bin.gz`、`earth-surface.json`、`earth-climate-01.png`～`earth-climate-12.png`を生成する。roughnessは地形バイナリへ含め、単独の`smoothness`画像は生成しない。ゲームへの取り込みは手順5で測光値と気候資源の変更を同じcommitで行う |
| `package.json` | `earth-surface:check` と `earth-surface:serve` を追加する |

**達成条件と検証**: `npm run typecheck`、`python3 -m unittest discover -s tools/earth-surface -p 'test_*.py'`、
`npm run earth-surface:bake`、新設する `npm run earth-surface:check`。
ヒマラヤ(28°N,86°E)、アンデス(20°S,69°W)、太平洋(0°,160°W)、カスピ海(42°N,51°E)、
海面下の陸(31°N,35.3°E)、南極(85°S,0°)、経度±180°で加工画像を確認する。気候マップは同じ地点で
陸地被覆率、ETOPO標高、平均気温、雲量を確認し、海底・湖底の値が標高へ混ざらないこと、海抜0m未満の
陸地が陸として残ることを検査する。
全段の平均色が共通の測光倍率へ収束すること、海底勾配が水面へ漏れないこと、親子の境界を確認する。
ベース地形の`ESTB/z=255`ヘッダー、gzip版と`.bin`版のpayload hash一致、氷として分類したセルと
`iceUnknown`セルの一覧も記録する。
この時点では生成資源を新しいゲーム描画へ接続しない。

### 手順4（初期実装済み・残作業）: タイル要求・常駐管理・GPU公開

ESTNの32bytesヘッダー、タイルキー、Float16本文、gzip、SHA-256、取得上限、AbortSignal、generationを検証する
`src/render/earth-surface-decode.ts`を追加した。`EarthSurfaceContext`が要求の世代とAbortControllerを管理し、
配信URL・地形・12か月気候マップの契約を共有できる。既存の`earth-surface-tiles.ts`と`earth-surface-gpu.ts`の
解析スパイクと合わせ、renderテストは初期実装時48/48、レビュー修正後49/49で通過した。実装コミットは`f7274288`である。
レビューで配信本文のコピー漏れと、デコード失敗時にHTTP bodyを解放しない問題を修正し、
`246eca7b`と`12255012`へ分けて記録した。

残作業は、デコード結果を四分木・常駐層・GPU公開へ接続する要求キュー、再試行・404・タイムアウト・LRU、
実`DataArrayTexture`と`EarthSurfaceMaterial`、`DeferredTexture`との投入予算統合、実GPU機能検査、
render-labのLODメトリクスである。現在はデコード結果を受け取っても地球へ表示する呼び出し元を持たない。

**残作業の達成条件**: 色と地形が同じ層へ公開されるまでページ表を変更しないこと、遅着・破棄・容量超過を
再現テストできること、実ブラウザでsRGB/線形・フィルタ・親子fade・ベースフォールバックを確認すること。

### 手順5（初期契約のみ実装・残作業）: 地球へ接続し、座標・測光・寿命を揃える

**目的**: すべての地球の写実表示と気候入力で、同じ地理資源・版・投影を使う。

`src/game/celestial/solar-system/earth-surface-source.ts`へ、datasetId、ベースURL、ベース資源、12か月気候
マップURLを共有する契約と不一致検査だけを追加した。`CelestialSurface`、Earth entity、雲場、実GPUへはまだ
接続していない。以下の表はその残作業である。

| 変更が必要な箇所 | すること |
| --- | --- |
| `src/render/celestial-surface.ts:79`・`:118`・`:134` | 天体共通のベースURL・測光・ライフサイクル契約を保つ。地球固有の処理はここへ分岐を足さず、`EarthSurface`ラッパーから接続する |
| `src/render/earth-surface-context.ts` (新規)・`src/render/earth-surface.ts` | 現在`earth-surface.ts`にある要求世代・AbortController管理をContextへ分離し、`EarthSurface`は地球の楕円体メッシュ、`earth-surface-tiles`、`EarthSurfaceMaterial`、Contextを束ねる表面実装にする |
| `src/assets/earth.jpg` | 手順3の生成物を測光値の変更と同じcommitで取り込む。地球のroughnessは単独画像へ分けない |
| `src/assets/earth-climate-01.png`～`earth-climate-12.png` (新規・更新) | 手順3でETOPO/GSHHGとERA5月平均から生成したRGBA気候マップを取り込む。GEBCO由来の既存画像とMODIS雲量は実行時資源にしない |
| `src/assets/earth-surface-base.bin.gz`・`src/assets/earth-surface.json` (新規) | 手順3のベース地形資源と小さいマニフェストを取り込む |
| `src/game/celestial/solar-system/earth-surface-source.ts` | 既存のdatasetId・URL契約を、manifest hash・tile index URL・気候チャンネル符号化まで検査できる契約へ拡張する |
| `src/types/earth-surface-shims.d.ts` (新規) | `*.bin.gz` のURL import型とビルド時に渡す配信URLの型を宣言する |
| `webpack.config.js`・`webpack.render-lab.config.js` | ベースバイナリのasset/resource対応を追加し、開発用配信URLを両環境へ同じ方法で渡す |
| `tools/export-earth-smoothness.mjs`・`tools/export-climate.mjs`・`package.json` | 旧青色比推定とGEBCO標高を読む独立生成を地表加工へ統合し、ERA5の月平均を12枚へ出す。既存MODIS雲量は比較検証用としてだけ保持する |
| `src/game/celestial/solar-system/earth-system.ts:198` | 地球に地表データと同じdatasetIdの気候マップ群を設定し、同じ画像から生成した測光値へ合わせる。旧`smoothnessUrl`とGEBCO由来の気候画像を併用しない |
| `src/render/cloud/field-projection.ts`・`src/render/cloud/climate-map.ts`・`src/render/cloud/generated-cloud-field.ts` | 雲場の生成が`earthSurfaceUv`と同じ楕円体投影を使うよう、放射方向と地理UVの相互変換を渡す。`ClimateMap`は当月・翌月のRGBAからR=2m気温、G=総雲量を補間し、AのGSHHG陸地被覆率と`EarthSurfaceContext`のETOPO標高を使う。標高から海陸を再推定しない |
| `src/render/cumulus-shell.ts`・`src/render/pipeline/cloud-scattering.ts`・`src/render/pipeline/shadow/cumulus-shadow.ts` | 雲の描画・散乱・影の標本化へ地球の半軸を渡し、地表と同じUVを読む |
| `src/render/atmosphere.ts` | `AtmosphereClouds`へ半軸または同等の楕円体投影契約を追加する |
| `src/game/celestial/celestial-entity/point-entity.ts:140`・`:175` | 当該フレームの位置・半軸・自転・`bodyToView`を確定し、形状LODとテクスチャLODへ同じ入力を渡してから地表の要求と法線uniformを同期する。非表示の早期returnでも要求を停止できるようにする |
| `src/game/celestial/celestial-entity/sphere-entity.ts` | 表面契約の変更が及ぶ呼び出しを更新し、月・他天体の描画を維持する |
| `src/render/camera-scale.ts` | window寸法の暗黙参照を地表タイルの判定に流用せず、実描画寸法を明示して扱える接点を用意する |
| `src/game/camera/camera-system.ts` | カメラの投影方式と実描画寸法を地表同期へ供給する |
| `src/render/pipeline/gbuffer.ts` | 法線の受け渡しを確認する。通常のnormalNode出力で成立するなら変更不要とし、地球専用の描画パスは追加しない |
| `tests/render/earth-surface-material.test.ts` (新規) | ゼロ勾配・自転・非一様スケール・経度周期の不変条件を検査する |
| `tests/render/game-entity-dispose.test.ts` | 地球の通信とGPU資源まで破棄されることを検査する |

**達成条件と検証**: `npm run typecheck`、`npm run test:render`、`npm run test:game`。
軌道分析の円筒図法背景に使われる `surfaceTextureUrl` は同じ全球ベース画像URLを返す。
追加するタイル用状態を `src/main.ts` や `Game` のグローバル処理へ置かない。同期順は
「位置・姿勢・半軸→bodyToView→形状LOD/テクスチャLOD→要求→GPUページ表→描画」とし、disposeは
「要求キャンセル→世代無効化→ページ表の非公開→GPU層解放→Context解放」の順にする。
`rg -n 'normalNode|surfaceTextureUrl|syncLod' src/render/celestial-surface.ts src/game/celestial` で
変更した表面契約の接続を確認する。`npm run earth-surface:serve` と `npm run dev` で
写実表示の地球へ寄り、地表が写る画像を1枚保存する。赤道・北緯60°・北緯85°・経度±180°で
ベースから詳細へ切り替わる前後の標識位置、気候マップの陸地被覆率・標高・温度、雲・雲影との一致、
太陽方位を反転した法線画像を比較する。海底・湖底が気候マップの標高へ入らず、海抜0m未満の陸地が
陸として雲の環境条件へ渡ることを確認する。GEBCOを読む経路が残っていないことを検査する。
模式図へ切り替えた画像では地形の細部が輪郭線を増やしていないことを確認する。詳細な比較は次の手順で行う。

### 手順6（未着手）: 地表専用の描画ケースと検証を完成させる

**目的**: 実際に見える位置・陰影・切り替えと、通信・処理時間の影響を確認する。

| 変更が必要な箇所 | すること |
| --- | --- |
| `tools/render-lab/cases.ts:94`・`:639` | 地球ケースに地表同期・準備完了・専用disposeの接点を追加する |
| `tools/render-lab/earth-surface-cases.ts` (新規) | 地域拡大、極、経度境界、ゼロ勾配、海岸、青い陸地、氷、海抜0m未満の陸、海底・湖底を除いた気候入力、模式図、通信遅延、親子到着順、128層超過、mipmap有無の固定ケースを置く |
| `tools/render-lab/lab.ts:308`・`:342`・`:413` | カメラ行列更新後に地表を同期し、対象地表のGPU公開完了を待って撮影し、ケース切替で破棄する。検証用ビューの実描画寸法を入力で受け、1920×1080で測れるようにする |
| `tools/render-lab/main.ts` | 地表専用の撮影・計測入口を接続する。他のケースの既定寸法と計測条件を保つ |
| `tools/earth-surface/capture.mjs` (新規) | 地表ケースだけを撮影・計測して `.earth-surface/verification/` へ保存する |
| `tools/earth-surface/serve.mjs` | 検証で明示された遅延・404・破損の固定経路を追加する |
| `package.json` | `earth-surface:capture` を追加する |

**達成条件と検証**: `npm run typecheck`、`npm run test:render`、`npm run test:game`。
`npm run earth-surface:serve` と `npm run render-lab` を起動し、地域ごとに色・法線・深度と
通常の照明結果を保存する。`npm run earth-surface:capture` は地表ケースだけを実行する。
通常の `render-lab:shot` をそのまま呼んで、テクスチャ未到着の単色画像を合格にしない。
同コマンドが扱う別分野のベースラインファイルへ書き込まない。

固定条件は通常比較1920×1080、ヒマラヤの視点高度200km・画角50°・昼側と斜光、
比較用に高度50kmと2,000km、赤道・北緯60°・両極、経度±180°。視点高さは見え方の確認用で、
地形との接触確認ではない。太陽方位の反転、0.25秒の到着遷移、透視/直交、戦闘/マップ、
写実/模式図の往復を確認する。親タイルから子タイルへ切り替わる途中で、色・法線・roughnessのどれか
だけが先に変わらないこと、LOD閾値付近で詳細が往復しないことも記録する。
同じ地点の気候マップについては、GSHHGの被覆率とETOPO標高から雲の陸海条件が決まり、GEBCOの
海底値や標高閾値へ戻らないことを記録する。
通信断はベース画像取得後に詳細の配信を止める条件とする。
各ケースで選択z、`errorPx`、frontier数、fallback率、要求数、GPU層使用数、ページ表更新数をJSONへ保存し、
画像だけでなく「なぜそのLODになったか」を再現できるようにする。
ゲーム全体の `smoke:browser` / `/verify` は別途実行時確認を求められたときだけ行う。

### 手順7（初期実装済み・残作業）: 配信用成果物と公開ビルドの接続を整える

**目的**: 詳細データをアプリの巨大な同梱資源にせず、再現可能に配信へ載せられる状態にする。

`tools/earth-surface/package.mjs`と`serve.mjs`、`earth-surface:package`・`earth-surface:serve`を追加した。
packageはdatasetId・12枚の気候マップ・帰属・全ファイルのサイズ/SHA-256を検査し、検査済み本文を配信先へコピーする。
serveは8084番ポートでMIME、CORS、immutable cacheを設定し、パス脱出を拒否する。実データbundleはまだない。
`earth-surface:check`、webpack公開URL、release検査、CI連携、実bundleの版混在検査は未実装である。


| 変更が必要な箇所 | すること |
| --- | --- |
| `tools/earth-surface/package.mjs` | 実bundleのdatasetId・入力ハッシュ・タイル索引を検査し、異なる版の混在を拒否する |
| `webpack.config.js`・`webpack.render-lab.config.js` | 開発用URLと公開用URLをビルド用途に従って解決する。公開ビルドと検証用ビルドを区別して設定を検査する |
| `src/game/celestial/solar-system/earth-surface-source.ts` | ビルドから渡す公開URL、manifestのhash、datasetIdの対応を検査できるようにする |
| `tools/verify-release.mjs` | 公開用URLの未設定・ローカルURL・datasetId不整合を検出する |
| `.github/workflows/build.yml` | 公開用配信URLをリポジトリ変数からビルドへ渡し、データ全量の取得・生成を毎回のCIへ入れない |
| `package.json` | `earth-surface:check` と、必要なら公開bundleの検査入口を追加する |

**達成条件と検証**: `npm run typecheck`、`npm run earth-surface:check`、
`npm run earth-surface:package`。ローカルの別ポート配信でCORS・MIME・gzip展開・版付きURL・
キャッシュを確認し、配信ディレクトリを入れ替えても異なる版が混ざらないこと、12枚の`earth-climate-MM.png`と
地表タイルが同じdatasetId・入力ハッシュを持つことを検査する。
実際の公開オリジンが用意されるまでは公開しない。mainへ送る作業を行う場合に限り、
`/send-pr` に従って全層テストと本番ビルドを含む検証を行う。

## 残作業の詳細実装計画（レビュー後改訂）

残作業は、データ契約、タイル供給、マテリアル、地球エンティティ、気候・雲、検証、配信の順に
進める。各段は独立したcommitにし、前段の達成条件を満たさないまま後段の実写判定へ進まない。
fixtureだけで通す段と実データで通す段を分け、fixtureの成功を実データの品質保証とはみなさない。

### レビューで確定した修正方針

| 見つかった曖昧さ・不整合 | 修正後の方針 |
| --- | --- |
| `src/render/earth-surface.ts`は現在Contextだけを持つが、手順5では同名を表面所有者としていた | `EarthSurfaceContext`を`earth-surface-context.ts`へ分離し、`earth-surface.ts`はメッシュ・material・tiles・Contextの所有者にする。移行中は旧exportを再exportして差分を小さくする |
| `CelestialSurface`は具体クラスでconstructorもprivateなため、地球だけを差し替える境界がない | `CelestialSurfaceLike`（photometry、textureUrl、addTo、syncLod、syncFrame、hide、dispose）を抽出し、`CelestialSurface`と`EarthSurface`を`PointEntity`/`SphereEntity`へ渡せるようにする。既存天体へEarth分岐を追加しない |
| タイルのURL・hash・本文長をどこから得るか決まっていない | `earth-surface.json`は共通版・符号化・`tileIndexUrl`を持ち、`tile-index.json`は`z/x/y`ごとの色本文hash、ESTN本文hash、本文長、URLを持つ。デコーダーは色と地形の両方を検証する |
| 気候RGBAのR/Bが物理値へどう戻るか決まっていない | manifestに固定範囲を置く。Rは`temperatureK: 180..330`、Gは雲量`0..1`、Bは陸上正高`-1000..9000 m`、AはGSHHG陸地被覆率`0..1`とする。水域のBは0 mとしてもA=0を優先し、範囲外は生成時にエラーにする |
| `ClimateMap`が標高から陸らしさを再推定している | Aをそのまま陸地被覆率として読み、標高から`landFraction`を作らない。雲の陸海条件はGSHHG由来Aだけで決める |
| `earth-surface:check`が達成条件にあるが入口と検査内容がない | `tools/earth-surface/check.mjs`を追加し、manifest schema、datasetId、入力hash、12枚、tile-index、全本文hash、URL安全性、gzip/ESTN整合性を検査する。`package`は配信用コピー、`check`は検査だけに分ける |
| 画像検証の保存形式と合格条件が曖昧 | `.earth-surface/verification/{case}/`に`color.png`、`normal.png`、`depth.png`、`metrics.json`を保存し、metricsにはdatasetId、視点、投影、選択z、frontier数、fallback率、要求数、層数、失敗理由を必須化する |
| 公開URLと開発URLの切り替え方法がない | `EARTH_SURFACE_BASE_URL`をwebpackのDefinePluginから渡す。未設定時は開発時だけlocalhost:8084を許し、公開用`verify-release`ではlocalhost・空文字・datasetId不一致を拒否する |

### 実装段A: 配信契約と生成物の固定（完了）

**依存**: 手順3のfixture出力。実データ全量は不要。
**変更**: `tools/earth-surface/package.mjs`、`tools/earth-surface/check.mjs`、
`src/game/celestial/solar-system/earth-surface-source.ts`、manifest型、package script。

1. `earth-surface.json`の必須項目を`schemaVersion`、`datasetId`、`sourceManifestSha256`、
   `baseColor`、`baseTerrain`、`tileIndexUrl`、`climateMaps[12]`、`climateEncoding`、
   `attribution`へ固定する。
2. タイルURLは`tiles/{z}/{x}/{y}.jpg`と`tiles/{z}/{x}/{y}.bin.gz`、z=0..7、x周期、y範囲を固定する。
3. `tile-index.json`の各エントリに、キー、色hash、ESTN本文hash、圧縮本文長、展開本文長を置く。
4. packageはmanifest・tile-index・全ファイルを一時出力へ検査済み順にコピーし、同一datasetId以外を混在させない。
5. checkは実体を変更せず、欠落、重複キー、範囲外キー、hash不一致、gzip後のESTN不一致を失敗させる。

**達成条件**: fixtureでpackage後の全ファイルが配信先に存在し、checkが正常版を通し、1ファイルの変更・
別datasetId・タイルキー違いを検出する。`npm run typecheck`、`npm run earth-surface:check`、
Pythonデータテストを実行する。

**実装状況（2026-09-09）**: `58fb009d`でmanifest・tile-index・ESTN/gzip/hash・datasetId・URLの検証、
`earth-surface:check`、staging経由のpackage、決定的fixtureを実装した。レビューで、後続の気候復号へ
つなぐ`sourceManifestSha256`と`climateEncoding`を`EarthSurfaceSource`へ公開する修正も加えた。
`npm run typecheck`、`npm run test:render`（49/49）、`npm run earth-surface:test`、Pythonデータテスト
（15件）を通過している。実データ全量のbundle検査は未実施である。段B以降はfixtureを使った初期実装が
進んでいるが、実GPU・実データ・ゲーム表示への接続は後段の残作業である。

### 実装段B: タイル要求・常駐・GPU公開を接続（要求・常駐fixture完了）

**依存**: 段Aのtile-indexと既存の`earth-surface-tiles.ts`、`earth-surface-gpu.ts`、decode。
**変更**: `src/render/earth-surface-request.ts`（新規）、`earth-surface-tiles.ts`、
`earth-surface-gpu.ts`、`earth-surface-decode.ts`、関連renderテスト。

1. `EarthSurfaceTileRequestSource`を作り、`urlFor(key)`とhash取得をtile-indexから一度だけ行う。
2. 同時実行数をHTTP 6、画像/地形decode 2、待機展開8組に分離する。予約・開始・解放をmetricsへ出す。
3. 408/429/5xx/ネットワーク切断だけ最大2回再試行し、404、形式不一致、hash不一致は版内永久失敗にする。
4. `EarthSurfaceTiles.sync()`が作ったfrontierを要求集合へ変換し、未取得子は親を表示したままにする。
   色と地形の両方がdecode済みで、GPUの同じ非公開層へ書き終わるまでresidentにしない。
5. `publishFrame(frame)`の前にページ表をstageし、成功したフレームだけfrontierとlayerの使用権を入れ替える。
   世代が古い結果、dispose後の結果、途中失敗した層は公開も再利用もしない。
6. LRUは表示葉、fade中の親、次フレームの祖先を固定し、空きがなければ中心から遠い葉を親へ戻す。
   128層を超えた要求を増やし続けない。

**達成条件**: 逆順到着、同時失敗、404、タイムアウト、abort、dispose、全層使用中、親fallbackをfake
fetch/GPUで検査し、色だけ・地形だけが表示される状態を作れない。`npm run typecheck`と`npm run test:render`を通す。

**実装状況（2026-09-09）**: `adc0920e`でtile-indexの一度だけの解決、HTTP 6・decode 2・待機展開8の
要求キュー、再試行・永久失敗・generation・AbortSignal・metrics、色hash・地形hash・本文長の検証を実装した。
レビューでdatasetId/相対URLの境界、HTTPイベントのgeneration、世代交代・dispose時のresident待機permit解放を
追加した。要求キューのfixtureを含め`npm run test:render`（53/53）、`npm run typecheck`、
`npm run earth-surface:test`、Pythonデータテスト（15件）を通過している。`EarthSurfaceTiles`とのfrontier
接続、GPU層への同時upload、resident LRU、親fallbackの実運用接続は段Bの残作業である。

**追加実装状況（2026-09-09）**: `0b3d4ee3`で`EarthSurfaceResidentCoordinator`、
`requestCandidates()`、`pinnedLayers()`を追加し、要求キューから色RGBA8・地形Float16を同じGPU層へ投入してから
ページ表を公開する経路、親fallback、世代/破棄境界、128層以下の退避をfixtureで接続した。レビューで、GPUや
色変換の一時失敗をcoordinator側の永続失敗へ昇格しないよう修正した。renderテストは58/58まで通過している。
実Three.jsの色変換、実GPUの配列層、Earth entityへのcoordinator注入は段C・Dへ残す。

### 実装段C: 地表マテリアルと実GPU接続（解析contract・texture設定contract完了）

**依存**: 段B。
**変更**: `src/render/earth-surface-material.ts`（新規）、`src/render/earth-surface-gpu.ts`、
`src/render/deferred-texture.ts`、`src/render/pipeline/render-pipeline.ts`、materialテスト。

1. 球メッシュのモデル方向を楕円体法線へ変換する。`n=normalize(direction / axes^2)`を用い、
   経度・緯度UVはこの`n`から求める。球面方向をそのまま地理UVへ使わない。
2. ページ表は最近傍、色はsRGB入力を線形化して線形filter、法線とroughnessはNoColorSpace・線形filterに固定する。
   roughnessは水0.05、陸0.80、氷0.35をESTNのalphaから読み、色の青さを参照しない。
3. R=255のbase fallback、親子fade、経度周期、極のclamp、未取得子の祖先保持をmaterial側で実装する。
4. 写実ではbody固定法線を`bodyToView`で一度だけviewへ変換し、模式図では幾何楕円体法線を選ぶ。
5. 実GPUで配列層・ページ表を作れない場合は、機能検査時点から全球baseへ固定し、個別draw call経路を追加しない。
   mipmapは`generateMipmaps=false`の親fallbackを合格させた後に別計測する。

**達成条件**: ゼロ勾配、非一様半軸、自転0/90/180度、経度±180度、親子fade、sRGB混合、模式図fallbackを
解析テストと実ブラウザ画像で確認する。色・法線・roughnessの公開フレームが一致し、既存の月・他天体の
 material挙動を変えない。

**実装状況（2026-09-09）**: `fa1f04e1`で、実GPUへ依存しないmaterial解析contractを追加した。楕円体UV、
ページ表の最近傍読取り、タイルgutter・経度wrap・極clamp、sRGBから線形への変換、親子fade、GSHHG被覆率からの
水・陸・氷roughness、body法線のview変換、模式図の幾何法線fallbackをfixtureで固定した。`npm run typecheck`、
`npm run test:render`（64/64）、`npm run earth-surface:test`、Pythonデータテスト（15件）を通過している。
この段で実Three.jsの`DataArrayTexture`/TSL、実GPU配列層、ページ表の公開、mipmap無効化とbase固定fallbackは
まだ接続していないため、段Cの受け入れは未完了とする。

**追加実装状況（2026-09-09）**: `41859d98`で、Three.jsのテクスチャ設定だけを担当する
`earth-surface-material-node.ts`を追加した。ページ表は最近傍、色はsRGB/線形filter、地形はNoColorSpace/線形filter、
全てmipmap無効という初期値を一箇所へ固定し、非対応機能を全球baseへ戻す能力フラグをfixtureで検査する。
これは実GPU配列層やTSLの標本化nodeを作る前の境界であり、`DataArrayTexture`、実GPU capability検査、
ページ表swap、base画像への実material接続は未完了として残す。

### 実装段D: `CelestialSurface`とEarth entityの接続（共通contract完了）

**依存**: 段Cのmaterial。fixture baseを使った接続を先に行い、実データは後から差し替える。
**変更**: `src/render/earth-surface-context.ts`、`src/render/earth-surface.ts`、
`src/render/celestial-surface.ts`、`src/game/celestial/celestial-entity/point-entity.ts`、
`src/game/celestial/celestial-entity/sphere-entity.ts`、`earth-system.ts`、型shim、webpack。

1. `CelestialSurfaceLike`を抽出し、既存の静的surfaceは従来挙動のままにする。地球だけ`EarthSurface`を注入する。
2. `EarthSurface.syncFrame({camera, bodyToView, axes, viewport, frame, timeMs, style})`を境界にし、
   `PointEntity.sync()`は位置・姿勢・scaleを確定してから呼ぶ。非表示・小さすぎる場合は要求を停止し、
   再表示時に世代を更新する。
3. `EarthSurface`は`addTo`、`syncLod`、`syncFrame`、`hide`、`dispose`を実装し、disposeを
   `cancel requests → invalidate generation → hide page table → release GPU layers → dispose context`の順にする。
4. `earth-system.ts`の地球だけを新sourceへ切り替え、月は旧`CelestialSurface`のままにする。地球の
   `surfaceTextureUrl`は全球base画像URLを返し、軌道分析の背景を壊さない。
5. webpackへ`.bin.gz`と公開URLの型・asset/resource処理を追加し、公開URL未設定時はproduction buildを失敗させる。

**達成条件**: `npm run typecheck`、`npm run test:render`、`npm run test:game`。地球のdispose後に要求・GPU層・
Contextが残らず、月・他天体・模式図・軌道分析が既存テストを維持する。

**実装状況（2026-09-09）**: `12dd9529`で`CelestialSurfaceLike`と`CelestialSurfaceFrame`を抽出し、
`PointEntity`/`SphereEntity`が具体クラスへ依存せず表面を注入できる契約を追加した。続く`7dec9df9`で、
`EarthSurfaceContext`と既存の全球base球を束ねる`EarthSurface` fallback facadeを追加し、破棄順序をfixtureで
固定した。`98e884a7`ではentityが姿勢・半軸を確定した後に`syncFrame`へscaleを含まないbody-to-viewを渡す
境界を追加した。既存の静的surfaceを含め、`npm run typecheck`、`npm run test:render`（66/66）、
`npm run test:game`（199/199）を通過している。Earthへの実データ注入、タイル常駐coordinatorとの接続、
非表示時の世代更新、webpackの公開URL検査は未実装であり、段Dの受け入れは未完了とする。

### 実装段E: 気候マップと雲・大気を共有入力へ切り替える

**依存**: 段A、段D。
**変更**: `src/render/cloud/climate-map.ts`、`generated-cloud-field.ts`、`weather-model.ts`、
`field-projection.ts`、`cumulus-shell.ts`、`cloud-scattering.ts`、`cumulus-shadow.ts`、`atmosphere.ts`、
`earth-system.ts`、気候テスト。

1. 単月の`ClimateMap`と12枚を管理する`MonthlyClimateMap`を分け、常駐は当月・翌月の2枚に限定する。
   月境界は線形補間し、年末は12月から1月へ周期的につなぐ。
2. R/Bはmanifestのmin/maxで復号し、Aを`landFraction`としてそのまま使う。標高閾値で陸海を再計算しない。
   水域のB=0と海抜0m未満の陸地を、Aの違いで判別できるテストを置く。
3. 雲場、積雲殻、雲散乱、雲影、大気の4経路へ同じ`earthSurfaceUv`・楕円体半軸・body姿勢を渡す。
   雲影と地表が同じ経度緯度へ重なることを、赤道・高緯度・経度境界で確認する。
4. 旧`earth-climate.png`、旧MODIS実行時入力、旧`earth-smoothness.png`、GEBCO参照が地球経路に残っていないことを検索する。

**達成条件**: 気候画像のR/G/B/Aを解析値で復号し、海底・湖底が気温・雲・地形性上昇流へ入らず、
海抜0m未満の陸地が陸条件を保つ。`npm run test:render`、`npm run test:game`を通す。

### 実装段F: render-labと実行時検証

**依存**: 段D・E。実データbundleと8084配信を使用する。
**変更**: `tools/render-lab/cases.ts`、`earth-surface-cases.ts`、`lab.ts`、`main.ts`、
`tools/earth-surface/capture.mjs`、`serve.mjs`、package script。

1. ケース名・視点・太陽方位・投影・styleを固定し、1ケース1ディレクトリへ画像3枚とmetrics JSONを保存する。
2. 撮影前に対象tileのGPU公開完了または明示的fallback/永久失敗を待つ。未到着の単色地球を合格にしない。
3. ヒマラヤ200kmを標準、50km/2,000km、赤道・北緯60度・両極・経度±180度、海岸・青い陸地・氷・
   海抜0m未満の陸・海底除外を固定ケースにする。到着順、通信断、404、128層超過、mipmap有無も含める。
4. 1920×1080と内蔵解像度で300フレームを測り、CPU p95、GPU p95、HTTP/デコード待機数、GPU層数、
   fallback率、ページ表更新数、encoded/payloadメモリを保存する。128MiBは品質を落とす絶対上限にしない。

**達成条件**: 画像・metricsがケース間で再現でき、LOD閾値付近で往復せず、親子fade中に色・法線・roughnessが
分離しない。`npm run test:render`、`npm run test:game`、capture fixtureを通す。

### 実装段G: 公開buildと配信の最終接続

**依存**: 段A〜F、実データhash固定。
**変更**: `webpack.config.js`、`webpack.render-lab.config.js`、`tools/verify-release.mjs`、
`.github/workflows/build.yml`、`package.json`、package/check/serve。

1. `EARTH_SURFACE_BASE_URL`とdatasetIdをbuildへ渡し、公開buildではHTTPSまたは承認済みoriginだけを許可する。
2. `earth-surface:check`をCI前の検査入口にし、12枚気候マップ、base、tile-index、全タイルhash、manifest hashを検査する。
3. static serverのmanifestは短いcache、画像・地形本文はdatasetId付きimmutable cacheに分け、CORSとgzip本文を確認する。
4. buildはデータ全量を取得・生成せず、生成済みbundleのdatasetId・hashだけを検査する。公開origin未設定なら公開を失敗させる。

**達成条件**: clean checkoutで`npm run typecheck`、`npm run earth-surface:check`、package、必要なrender/gameテスト、
公開URL検査を通し、異なるdatasetIdの資源が混在した配信ディレクトリを拒否する。mainへ送る場合だけ全層テスト・
本番buildを行う。

## 未完了タスクの実装計画（2026-09-09再整理）

ここからは、fixtureだけで確認できる契約と、実データ・実GPUが必要な確認を混ぜない。`A0`〜`A6`は
次の段へ進む条件を持つ独立した作業単位であり、各単位を別worktreeで実装してレビュー後に
`workspace3`へ取り込む。実データがまだない段では、既存fixtureを使ってコード経路だけを完成させる。

### 全体の順序と依存

```text
A0 基準状態の固定
 ├─ A1 実データ取得・小領域生成 ──┐
 └─ A2 実GPU material接続（fixture） ─┼─ A3 EarthSurface本接続
                                      └─ A4 気候・雲・大気の共有入力
                                             └─ A5 render-lab実行時検証
                                                    └─ A6 公開build・配信検査
```

`A1`と`A2`はfixtureの範囲で並行できる。`A3`は`A2`のGPU fallback契約と`CelestialSurfaceLike`の
同期境界を前提にし、`A4`は`A1`のRGBA気候マップ契約と`A3`のEarth entity接続を前提にする。
`A5`は`A3`・`A4`の両方が完了するまで実データ画像を合格判定に使わない。`A6`は`A5`のmetricsと
入力hashが固定された後にだけ着手する。

### A0: 基準状態と作業境界を固定する（コード変更なし）

1. `git rev-parse --short HEAD`、Node/npm、macOS、ブラウザ、WebGPU backend、実描画サイズを
   `.earth-surface/verification/baseline.json`へ記録する。
2. `npm run typecheck`、`npm run test:render`、`npm run test:game`、`npm run earth-surface:test`、
   Pythonデータテストを実行し、件数とcommitを保存する。
3. `.earth-surface/`と生成bundleがGit管理対象外であることを確認し、無関係なprotein変更を作業対象へ
   混ぜない。以後のworktreeは`workspace3`の最新commitから作る。

**完了条件**: baseline JSONとテスト結果があり、以後の差分が地表計画のファイルだけで説明できる。

### A1: 実データ取得と16領域の再現可能な生成を完了する

**入力**: BMNG 2004年7月Base Map、ETOPO 2022 v1 ice-surface/geoid、GSHHG 2.3.7 full resolution、
ERA5 1991–2020月平均の2m気温・総雲量。

1. `assets-src/earth-surface/sources.json`へ製品版、変数、単位、期間、CRS、NoData、再格子化方法、
   入力SHA-256、帰属を確定する。ETOPOはsurface/geoidだけを登録し、bed elevationを登録しない。
2. `tools/earth-surface/fetch.mjs`または既存取得入口へ、部分ファイル、Content-Length、SHA-256、再開、
   HTML応答拒否を実装する。取得済み入力はhashが一致する場合だけ再利用する。
3. `tools/earth-surface/bake.py`で北緯25〜35度・東経80〜90度、海岸、南極、グリーンランド、経度境界を
   含む16領域を処理する。領域ごとに、BMNG JPEG、ESTN地形、GSHHG被覆率、法線、12か月RGBAを出す。
4. 生成時に`A=GSHHG landFraction`を焼き、`B=ETOPO ice-surface + geoid`は陸上だけへ入れる。水域のBは
   0m、海抜0m未満の陸地は負値のまま保持する。氷を分類できないセルは`iceUnknown`として記録する。
5. 各領域の生成ログへ入力hash、出力hash、NoData数、有限値、処理時間、出力サイズを保存する。

**検証**: `python3 -m unittest discover -s tools/earth-surface -p 'test_*.py'`、小領域の
`earth-surface:check`、ヒマラヤ・太平洋・カスピ海・死海・南極の解析画像。16領域で色の向き、
極clamp、経度wrap、海底勾配の除外、負標高陸のA値を確認する。

**停止条件**: CRS、NoData、単位、入力hashのいずれかが確定できない場合はタイル全量生成へ進まず、
`sources.json`だけを修正する。ETOPOの標高から氷マスクを推定してはならない。

### A2: 実Three.js GPU material接続をfixtureで完成する

**実装方針の更新（2026-09-09）**: Three.js WebGPUの内部的な配列層APIへ先に依存すると、対応機能の
検査前にゲームへ漏れ、fallbackを壊す危険がある。このため第一段を公開APIだけのtexture設定・能力フラグ
contractとして固定し、実`DataArrayTexture`/TSL nodeと公開swapは別commitへ分離する。後者を実ブラウザで
検証できない場合は、設定contractを保持したまま全球base固定でA3へ進む。

1. `src/render/earth-surface-gpu-three.ts`を追加し、`EarthSurfaceGpuBackend`へ`DataArrayTexture`の
   色層・地形層とページ表のswapを実装する。層の書込みは非公開層だけへ行い、既存fake backendの
   reservation検査を通す。
2. `src/render/earth-surface-material-node.ts`を追加し、`EarthSurfaceMaterial`の解析contractをTSLへ
   写す。ページ表は`NearestFilter`、色はsRGB入力・線形標本化、地形は`NoColorSpace`・線形標本化、
   `generateMipmaps=false`を初期値とする。R=255は全球baseへ戻す。
3. TSLの標本化順序を固定する。楕円体法線→共通地理UV→ページ表最近傍→現在/親層の同一UV読取り→
   sRGB線形化後の色混合→roughness/法線混合→`normalNode`公開の順とする。模式図は地形層を読まず、
   同じ楕円体の幾何法線を使う。
4. `EarthSurfaceGpuAdapter`へbackend capabilityの実値を渡し、`texture2dArray`、128層、RGBA8線形化、
   terrain Float16線形標本化のいずれかが不足する場合は生成時から全球baseへ固定する。
5. WebGPU対応ブラウザで、z=0、z=1、親子fade、経度±180度、極、非一様半軸、0/90/180度自転を
   解析画像とGBuffer値で確認する。mipmapはbase fallbackの合格後にだけ比較し、採用する場合も
   親子fallbackと同じ画像差を記録する。

**検証**: `npm run typecheck`、`npm run test:render`、fake backendの公開順テスト、実ブラウザの
最小fixture画像。合格条件は色・地形・roughness・ページ表が同じframe番号で公開され、非対応機能では
GPU層を作らず全球baseだけが表示されること。

**停止条件**: Three.js内部APIへ直接アクセスしないと層swapを実現できない場合は、backend adapter内へ
隔離し、アプリや`CelestialSurface`へ内部APIを漏らさない。実GPUで検証できない場合はA3のEarth切替を
fixture baseへ戻したままにする。

### A3: EarthSurfaceをゲームへ注入し、常駐coordinatorを同期する

1. `EarthSurfaceContext`の定義と旧importを整理し、`EarthSurface`がContext、`EarthSurfaceTiles`、
   `EarthSurfaceResidentCoordinator`、material、全球baseを所有する。`CelestialSurfaceLike`の既存契約は
   月・他天体へそのまま適用する。
2. `earth-system.ts`ではEarthだけを`EarthSurface`へ差し替える。manifest URLまたは開発fixtureが無い
   場合は、EarthSurfaceが全球base fallbackで動き、月は旧`CelestialSurface`を使う。production buildで
   URLが無い場合の失敗はA6のrelease検査へ分離する。
3. `PointEntity.sync()`の`syncFrame`境界へ、カメラの実描画寸法、bodyToView、半軸、frame、styleを渡す。
   その後に形状LOD、テクスチャfrontier、coordinator.syncを同じ入力で実行する。小さすぎる・非表示へ
   移ったフレームではcoordinatorを止め、世代を一度だけ進める。再表示時に新世代を発行する。
4. disposeは`cancel requests → invalidate generation → hide page table → release GPU layers → dispose
   coordinator/context → fallback`の順にし、遅着のdecode、色変換、GPU書込みを公開しない。
5. `surfaceTextureUrl`は実際に表示する全球base画像へ向け、軌道分析の背景だけが旧画像を参照しないようにする。
6. Webpackの`.bin.gz` URL型と`EARTH_SURFACE_BASE_URL`を追加し、開発時localhost fallbackとproductionの
   必須URL検査を分ける。

**検証**: `npm run typecheck`、`npm run test:render`、`npm run test:game`。Earthだけをbuildし、表示→非表示→
再表示→disposeを繰り返して、generation、queue、resident、GPU層、Contextがすべて0へ戻ることをfixtureで
確認する。月・他天体・軌道分析・模式図の回帰を同じテストで確認する。

**停止条件**: Earth切替後に実データが無い環境で単色または欠損になる場合は、source注入を戻してfallbackを
維持する。実データの品質判定はA5で行い、game testを画像品質の代替にしない。

**追加実装状況（2026-09-09）**: `ba883db8`で、`EarthSurface`へ任意のresident coordinatorを注入できる
境界を追加した。`syncFrame`は既存fallbackを同期した後、同じframeから`EarthSurfaceView`と世代付きleaseを
coordinatorへ渡し、次フレーム・hide・disposeでAbortする。`earth-system.ts`の地球だけを開発用source付き
`EarthSurface`へ包み、実テクスチャは従来のfallbackを使うため月・気候・雲は変更しない。coordinatorの実生成、
実GPU公開、実manifest URLは未完了で、A6のproduction検査と合わせて後続実装する。
`f5de43dd`ではdispose時にcoordinator破棄より先に要求leaseをabortする順序へ修正した。

### A4: 月別気候入力を雲・大気・影へ接続する

1. `ClimateMap`を単月のRGBA入力として整理し、`MonthlyClimateMap`が12 URLのうち当月・翌月だけを
   常駐させる。月境界は線形補間、12月→1月は周期補間し、表示時刻から月と補間率を決定する。
2. manifestの範囲でRを2m気温、Gを総雲量、Bを陸上ETOPO正高、AをGSHHG陸地被覆率へ復号する。
   `landFraction = smoothstep(elevation)`を廃止し、Aをそのまま雲の陸海条件へ渡す。水域B=0と負標高陸を
   分けるテストを置く。
3. `earthSurfaceUv`と楕円体半軸を`field-projection.ts`、雲場生成、積雲殻、散乱、雲影、大気へ渡す。
   球面の`equirectUvFromDirection`を地球経路で直接使わない。雲場と影は同じbody姿勢と時刻を読む。
4. `earth-system.ts`で旧`earth-climate.png`、旧MODIS入力、`earth-smoothness.png`、GEBCO参照を外し、
   ClimateMapとEarthSurfaceのdatasetIdを`assertEarthSurfaceDataset`で検査する。
5. ERA5未到着の開発環境では既存fixtureを使うが、fixtureのR/G/B/Aが実データ契約と同じ符号化範囲を持つ
   ことを検査する。12枚すべてを同時にGPUへ置かない。

**検証**: `npm run typecheck`、`npm run test:render`、`npm run test:game`、気候復号fixture。赤道・
北緯60度・北極/南極・経度±180度で地表色、雲場、雲影、大気の標識が一致すること、海底・湖底の値が
雲へ入らないこと、海抜0m未満の陸が陸条件を保つことを確認する。`rg`でGEBCO・旧気候資源の実行時参照が
地球経路に残っていないことを検査する。

**停止条件**: 12枚のうち1枚でもdatasetId・符号化範囲・向きが異なる場合は切替を中断し、旧ClimateMapへ
戻す。A4は気候の見た目を改善する段であり、天気モデルの物理検証を代替しない。

**追加実装状況（2026-09-09）**: `d472e694`で、`ClimateMapLike`を導入し、単月入力と月別入力が同じ
雲生成境界を使えるようにした。`MonthlyClimateMap`は12枚を保持するが、要求するのは当月・翌月の2枚だけで、
同一UVのRGBAを線形補間し、R/G/B/Aを気温・雲量・ETOPO正高・GSHHG陸地被覆率へ固定範囲で復号する。
`GeneratedCloudField.syncClimateMonth`で月の選択を明示的に渡せる。`earth-system.ts`の実URL切替、ERA5生成、
大気・影への実データ配線、旧気候画像の除去は未完了である。

### A5: render-labで画像とmetricsを固定する

1. `tools/render-lab/earth-surface-cases.ts`へ、ヒマラヤ200kmを標準とする50km/2,000km、赤道、
   北緯60度、両極、経度±180度、海岸、青い陸、氷、負標高陸、海底除外、模式図を登録する。
2. `tools/earth-surface/capture.mjs`はケースごとに`color.png`、`normal.png`、`depth.png`、
   `metrics.json`を`.earth-surface/verification/{case}/`へ出す。metricsはdatasetId、ブラウザ、viewport、
   projection、sun方位、選択z、`errorPx`、frontier数、fallback率、要求数、decode待機数、GPU層数、
   page table更新数、encoded/payloadメモリ、失敗理由を必須とする。
3. 撮影前に対象tileのGPU公開、または明示的fallback/永久失敗を待つ。単色の未到着画像を合格にしない。
   到着順、通信断、404、128層超過、mipmap有無をfake serverで再現する。
4. 300フレームを1920×1080と内蔵解像度で測り、CPU/GPU p95、要求・decode待機、GPU層数、fallback率を
   比較する。LOD閾値の前後でカメラを往復させ、選択列が振動しないことを記録する。
5. 太陽方位反転、写実/模式図、透視/直交、戦闘/マップを同じ地点で比較し、親子fade中に色・法線・roughness
   が分離しないことを画像差とmetricsで判定する。

**検証**: `npm run typecheck`、`npm run test:render`、`npm run test:game`、`npm run earth-surface:capture`。
ケース画像は既存のcloud/protein計測ファイルへ書き込まず、地表専用ディレクトリへ保存する。

**合格条件**: 欠損・未到着・永久失敗がmetricsへ明示され、画像だけで成功と誤認できない。標準ケースで
親fallbackから詳細へ移る位置が固定され、LOD往復、色の段差、法線の反転、海岸の鏡面帯が発生しない。

**追加実装状況（2026-09-09）**: `5d735ecb`で、既存render-labのEarth 5ケースを専用に撮影する
`tools/render-lab-earth-surface.mjs`と、`.render-lab/earth-surface-shots/metrics.json`へPNGのSHA-256・
バイト長・viewport・ケース順を保存する入口を追加した。隣接8bit差分、RGBA有限値/範囲、metricsの正規化は
`earth-surface-metrics.ts`と解析テストで固定する。実GPUタイルの到着待ち、GBuffer撮影、p95性能計測、
実ブラウザでの撮影は未実施で、画像を自動合格にしない。

### A6: 公開build・配信・clean checkout検査を行う

1. `EARTH_SURFACE_BASE_URL`、datasetId、manifest hashをwebpackのDefinePluginへ渡し、開発用localhostと
   production用URLを分ける。`sourceManifestSha256`とtile-indexのdatasetIdを起動時に比較する。
2. `tools/earth-surface/check.mjs`へmanifest schema、12枚、base、tile-index、全タイルhash、URL安全性、
   gzip/ESTN本文長、入力hashを追加する。`package`はstaging出力、`check`は読み取り専用検査にする。
3. `tools/verify-release.mjs`へ、空URL、localhost、HTTP、承認外origin、datasetId不一致の拒否を追加する。
   `.github/workflows/build.yml`ではデータ全量の取得・生成を行わず、生成済みbundleのhash検査だけを行う。
4. `serve.mjs`のmanifestは短いcache、datasetId付きJPEG/bin.gzはimmutable cache、CORS、gzip本文を検査する。
   生gzipとHTTP Content-Encoding gzipを混同しないテストを置く。
5. clean checkoutでA0の基準テスト、`npm run earth-surface:check`、package、必要なrender/gameテスト、
   production webpack buildを実行する。公開originが未設定ならrelease検査を失敗させ、公開を行わない。

**合格条件**: 異なるdatasetIdの資源混在、manifest改変、タイルhash不一致、公開URL未設定をすべて拒否し、
同一版のbundleだけがローカル配信から読み込める。mainへ送る場合のみ全層テストと本番buildを追加する。

**追加実装状況（2026-09-09）**: `51454406`で、webpackの`.bin`/`.bin.gz` asset処理、
`EARTH_SURFACE_BASE_URL`のDefinePlugin境界、HTTPS/localhost/datasetIdを検査するrelease-checkを追加する。
通常の開発buildは空URLを許容し、明示したrelease-checkだけが公開URLを必須にする。実データbundleの配置、
CI secret/originの設定、ゲーム起動時のmanifest fetchは未完了である。

### 実装のコミット境界とレビュー順

| 単位 | 変更のまとまり | 必須レビュー観点 | 次へ進む条件 |
| --- | --- | --- | --- |
| A0 | baseline JSONのみ | 無関係な差分・環境記録 | テスト結果が保存済み |
| A1 | fetch/bake/checkと16領域fixture | 入力hash、単位、NoData、GSHHG/ETOPO境界 | 16領域の出力hashと解析画像 |
| A2 | Three GPU backendとTSL material | 色空間、filter、公開順、fallback | 実GPUまたは明示fallbackのfixture |
| A3 | EarthSurface・earth-system・entity同期 | 世代、dispose、月への非影響 | game/render回帰と表示fixture |
| A4 | MonthlyClimateMapと雲・影・大気 | A値の陸海判定、共有UV、旧入力除去 | 気候復号・共有標識テスト |
| A5 | render-lab/capture/metrics | 未到着を合格にしない、再現性 | 固定ケース画像・metrics |
| A6 | webpack/release/CI/serve | URL、hash、cache、clean checkout | check/package/build成功 |

各単位のレビュー後に、計画書の該当段へcommit、テスト件数、未完了境界を追記する。実データの取得や
ブラウザ撮影をfixtureテストの成功だけで代用しない。

### 実装順とcommit境界

| 順 | commitの責務 | 主な検証 |
| --- | --- | --- |
| A0 | baselineと環境記録 | 基準テスト、baseline JSON |
| A1 | 実データ取得、16領域bake、入力hash | Pythonテスト、check、解析画像 |
| A2 | Three GPU backend、TSL material、base fallback | renderテスト、GPU fixture、最小画像 |
| A3 | EarthSurface、earth-system、entity同期 | render/gameテスト、dispose fixture |
| A4 | 月別ClimateMap、雲・大気・影の共有投影 | render/gameテスト、気候解析テスト |
| A5 | render-labケース、capture、性能metrics | capture fixture、実行時画像 |
| A6 | webpack、release検査、CI・配信 | clean checkout、package/check、build |

A0〜A2はゲームの地球表示を切り替える前に完了させる。A3でfixture baseを使ったゲーム接続を行い、
A4で実気候資源へ切り替える。A5の画像判定を通過するまでA6の公開URLを有効化しない。

## すぐに取り組める小タスク

全量取得やゲーム接続を待たず、次の順で不確実性を減らす。

1. **ETOPOの製品確認**: `15s_surface_elev_gtif`と対応する`15s_geoid_gtif`を南極・グリーンランドの
   小領域で読み、氷床上の値がsurface側にあること、geoidとの単位・NoData・符号が一致することを確認する。
   `bed_elev`は取得せず、氷の分類へ標高差を流用しないことを検査する。ここで`sources.json`の版とハッシュを固定する。
2. **座標・共有Contextの解析テスト**: `earthSurfaceUv`と`EarthSurfaceContext`の型を先に作り、
   赤道・60°・85°・±180°、楕円体半軸、海抜0m未満の陸、海底0mを解析値だけで通す。
3. **ERA5の12か月試作**: 0.25°の2m気温・総雲量を1991–2020で平均し、512×256の12枚へ再格子化する。
   既存MODISは比較画像として横に置き、海岸・高地・季節分布が緯度式より改善するかを記録する。
4. **固定roughnessの描画スパイク**: 水0.05・陸0.80・氷0.35を合成マスクへ入れ、青い陸地、沿岸、
   海抜0m未満の陸、氷床で鏡面の帯が出ないことを確認する。`CelestialSurface`へEarth分岐を追加しない。
5. **GPU公開と標本化の実測**: このMacの実ブラウザで`EarthSurfaceGpuAdapter`の機能検査、
   128層・260²の非公開層更新、1層swap時間、ページ表最近傍、親子2段フォールバックを測る。
   必須の基底レベル経路を合格させた後でだけmipmap生成と斜視のちらつきを比較し、採用可否を記録する。
6. **デコード・基準機の計測条件を固定**: JPEG/gzipの同時デコード2、待機8組、AbortSignalの解放を測り、
   macOS、ブラウザ版、Metal/WebGPU backend、1920×1080、内蔵解像度、300フレームのp95とGPUメモリの
   記録形式を`.earth-surface/verification/`へ置く。

## 見積り

以下は設計上の上限・計算値であり、実測性能を主張するものではない。

| 項目 | 導出式・初期値 |
| --- | --- |
| 最高段の幅 | `256 × 2^(7+1) = 65,536 texel`、赤道間隔 `2π × 6,378,137 / 65,536 ≒ 611.5 m` |
| タイル組数 | `Σ(z=0..7) 2×4^z = 43,690組`。色と地形の2ファイルなので87,380ファイル＋索引 |
| GPU常駐 | 必須経路は`260² × 128 × (RGBA8 4B + RGBA16F 8B) = 103,833,600B ≒ 99.0MiB`にページ表を加える。mipmapを採用する場合は約4/3で約132MiBとなり得るため、実測値を別記録し、精度要件を優先する |
| 全球地形ベース | `2048 × 1024 × 8B = 16MiB`。ページ表・管理用資源を加えた実測ピークをM4 Proで記録する。128MiBは絶対上限にしない |
| CPU保持 | GPU投入用の配列約99MiB＋全球地形16MiB＋待機8組 `8×260²×12B ≒ 6.2MiB`に、同時デコード2組の
  圧縮本文・展開領域を加える。encoded/payloadの実測ピークを記録し、192MiBは予約上限として管理する |
| 1回の投入 | `260² × 12B ≒ 792KiB`、1フレーム1組。128組の入れ替えは60fpsなら転送処理だけでも `128/60 ≒ 2.13秒`を要する |
| データ生成の量 | 作業ピクセル数 `43,690 × 260² ≒ 29.53億`。色RGBA8と地形RGBA16Fの生データ換算は約33.0GiB。512×256のRGBA気候マップ12枚はこの見積りへ別途加えるが、配信量への影響は小さい。JPEG/gzip後の配信量はこの数字と別 |
| 配信容量 | 16枚の地域別試作から得た平均JPEGサイズJと平均地形gzipサイズNで `43,690×(J+N)＋ベース＋索引` を計算する。海/陸/極の面積比も加味して全量生成前に更新する |
| ディスク空き | `取得対象のContent-Length合計＋中間ファイル上限＋配信見積り＋生成中の1領域分`。原画像全展開の同時保持を避ける。実測前に固定のGB値で足りると断定しない |
| 生成時間 | 16枚の処理時間から、読込・再投影・法線・圧縮を分けて `領域数×平均処理時間` を求め、データ読込の共有分を全量処理で再測定する |
| 実装工数 | 仕様1～2h＋取得4～6h＋加工/検査12～20h＋常駐/標本化12～20h＋ゲーム/気候接続5～10h＋画像/性能検証8～12h＋配信準備3～5h = **45～75h**。1作業者の目安で、ダウンロード待ち・生成待ち・公開環境の準備時間は別 |

## リスクと落とし穴

P0は実装を先へ進める前に解消する。P1は画像検証で見え方を確認し、許容する場合もその条件を記録する。
この計画でP0として先に解消するのは、形状LODとテクスチャLODの分離、`errorPx`と楕円体可視判定、
ページ表の層・z・fade契約、frontierの2:1制約、ベース画像と詳細タイルの地理UV、雲場・雲影の投影、
法線のlocal/view空間、模式図の幾何法線、旧青色比のroughness、`DataArrayTexture`のフィルタ・色空間、
GPU機能検査と非公開層swap、JPEG/gzipのデコード上限、タイルヘッダー・マニフェストの検証、
氷分類の未知範囲、GEBCO由来の気候標高・海陸判定の残存である。
これらは手順1.5と手順4～5の設計・検査へ修正を組み込み、未解消のまま手順6の実写判定へ進めない。
LODのちらつき、非同期のまだらな公開、JPEG境界、氷分類の適用範囲、法線だけで山を表す限界などはP1以降として
手順4～6の画像検証で懸念または許容条件を記録する。

| リスク | 影響 | 露見する手順・具体的な確認 |
| --- | --- | --- |
| ベース画像だけが旧球面UV、詳細タイルだけが楕円体の地理UV | 高緯度で海岸・山がタイル到着時に移動し、雲影が地表から外れる | 1.5・5・6で同じ緯度経度の標識をベース/詳細/雲で比較。`earthSurfaceUv`以外の地表UV生成が残っていないことを検索する |
| 形状LODとテクスチャLODを1つの見かけ直径で選ぶ | 地球の輪郭は細かいのにタイルが粗い、またはGPUへ不要な詳細を入れる | 1.5・4で形状は`sphereLodLevel`、テクスチャはノードごとの`errorPx`として選択列を比較する |
| ページ表の層番号とタイルzを補間する | 隣のタイル層を誤って読み、地域全体が別画像へ飛ぶ | 1.5・4でRGBA8ページ表を最近傍で読み、予約層255、親子fade、経度wrapを解析テクスチャで検査する |
| 2:1隣接制約を作らない | 子がそろわない境界で親子の色・法線が急に変わる | 1.5・4・6で4子の到着順を変え、frontierの隣接z差と画像を記録する |
| 雲場の生成時と雲の描画・影で楕円体投影が異なる | 雲本体と雲影がずれ、地表の自転に対して雲だけが滑る | 1.5・5・6で雲場の生成UV、積雲殻、散乱、影の4経路を同じ標識で比較する |
| 天体固定法線をlocal/viewへ二重変換、または半軸の逆転置を追加適用 | 自転でハイライトが回らない、極や楕円体の縁だけ陰影が歪む | 1.5・5・6のゼロ勾配・非一様半軸・自転角0/90/180°でGBuffer法線を復号し、0.2°以内を確認する |
| 模式図でも地形法線をGBufferへ出す | 地形の細部が模式図の輪郭線として現れ、地球がノイズ状になる | 1.5・5・6で写実/模式図を往復し、模式図の輪郭が幾何楕円体のケースと一致することを比較する |
| 写実表示で旧青色比のroughnessマップを併用する | 青い陸地や沿岸の水でない領域に光沢が出る | 3・5・6で旧`smoothnessUrl`の地球参照と旧exporterの利用が0件であることを検索し、青い陸地を拡大する |
| 陰影入りBMNGを選ぶ | 太陽を動かしても固定された山影が残る | 2でファイル名、3・6で太陽方位の反転 |
| 全球ベースと詳細が別の月・測光 | タイルの到着で地域の色・明るさが変わる | 3の親子平均、6の到着前後 |
| EGM2008を楕円体高と混同 | 長波長の法線が地球の基準とずれる | 2のメタデータ、3のsurface+geoidの解析検査 |
| 地理緯度と球メッシュの緯度を混同 | 高緯度で海岸・山・陰影の位置がずれる | 5・6で60°、85°と自転した同じ地点 |
| 度単位の標高差をそのまま法線へ使う | 緯度で起伏の強さが変わる | 3で同じm/m勾配を赤道・中緯度・極近傍に置く |
| 水底・NoDataを陸の勾配へ混ぜる | 水面に山が出る、海岸に架空の崖が立つ | 3・6で太平洋、カスピ海、負標高の陸、島 |
| GEBCO由来の気候画像・標高閾値を残す | 地表のGSHHG海岸と雲の陸海条件がずれ、海底深度が気温・地形性上昇流へ混ざる | 3・5・6で`tools/export-climate.mjs`、`ClimateMap`、ビルド入力を確認し、GEBCO参照と標高からの海陸再推定を0件にする |
| ETOPOの海底・湖底を気候標高へ入れる | 海域の深さが冷却や地形性上昇流として雲へ現れる | 3・5・6で水域B値が0m、海抜0m未満の陸地は負値のまま、GSHHGのA値が陸らしさを決めることを確認する |
| 原画像とGSHHGの海岸が完全には一致しない | 海岸の細い帯で粗さと色がずれる | 3で被覆率を同じ格子へ焼き、6で海岸拡大。海岸の正確さを611mと同義にしない |
| 氷床と海氷・積雪を同じクラスへ混ぜる | 水域の粗さや季節表現を誤る | 3でETOPO ice-surfaceとGSHHG L5の適用範囲を検査し、未分類の海氷・積雪をマニフェストへ残す |
| ETOPOのice-surfaceを氷の面積マスクと解釈する | グリーンランド等が標高だけで氷のroughnessになり、科学的根拠のない境界が出る | 2・3でbed_elevや標高閾値を入力にしていないこと、`iceUnknown`範囲をマニフェストへ記録する |
| 極の接基底が退化、±180°の微分が跳ぶ | 極の穴、経線に沿う陰影、過剰なLOD要求 | 3のXYZ法線、4の周期境界、6の極/経度ケース |
| 法線へ自転・非一様スケールを二重適用 | 見た目は出るが光源方向との関係が誤る | 5のゼロ勾配と回転不変条件、6の法線画像 |
| `DataArrayTexture`の既定Nearestや誤った色空間に依存する | 地形法線がブロック状になり、親子切替で明るさが跳ぶ | 1.5・4・6でfilter、`colorSpace`、線形混合を実値と画像の両方から確認する |
| 配列層更新をThree.js/WebGPUの内部APIへ直接散らす | ブラウザやThree.js更新で層書込みが壊れ、表示中の層を途中で上書きする | 1.5・4で`EarthSurfaceGpuAdapter`の機能検査、非公開層への書込み、フレーム境界swapをfake/実GPUで確認する |
| JPEG/gzipの展開数だけをHTTP要求数で代用する | 6要求でもデコードが詰まり、CPU p95や192MiBを越える | 1.5・4・6でHTTP6・デコード2・待機8を別メトリクスとして記録し、キャンセル後の保持量を確認する |
| タイル本文をヘッダー・マニフェスト検証なしでGPUへ送る | 壊れたFloat16、寸法違い、別datasetIdのデータが地表へ出る | 2・3・4でmagic、version、寸法、キー、本文長、SHA-256を検査し、失敗タイルを永久失敗へ置く |
| `Content-Length`だけをファイル同一性に使う | gzip/CDN経路で長さが変わり、同じ版の検証に失敗する | 2・3・7でencoded/payload bytesとpayload hashを検査し、gzip版と`.bin`版を同じ本文として扱う |
| 2texel余白があっても隣接JPEGの量子化差を検査しない | タイル境界に細い色の線や鏡面の帯が出る | 3・4・6でデコード後の共通境界を比較し、色差2/255以下を目安として実データの見え方を記録する |
| LODの分割/統合状態をフレームごとに作り直す | 閾値付近で細部がちらつき、要求とLRUが往復する | 4・6でカメラを閾値周辺に固定し、一定時間の選択列と画像を記録する |
| 非同期に到着した子タイルを個別に表示する | 同じ親領域に粗い部分と細かい部分が混在し、遷移がまだらになる | 4・6で4子の到着順を入れ替え、色・法線・roughnessの公開時刻を記録する |
| 到着時にページだけ先に公開 | 別地域の色、未初期化の法線、瞬間的な黒 | 4のGPU公開順と遅延テスト、6の到着ケース |
| LRUが表示中の祖先を追い出す | 地表の欠け・粗密の往復 | 4で全層使用中の要求、6で高速移動 |
| GPU層更新を全配列の転送にしてしまう | 1タイル到着のたびに約99MiBを転送 | 4で層更新の使用を確認、6で投入フレームの計測 |
| 配列層のmipmap生成がバックエンドごとに異なる | タイル内の縮小でにじみやちらつき | 1.5・4で生成済みmipmapと親子2段フォールバックを同じ解析画像で比較する |
| 通信中のdispose・スタイル切替 | 解放後の書込み、要求の増え続け | 4・5の遅着検査、6で往復操作 |
| 撮影が画像・GPU公開を待たない | 単色の地球を正常と誤認する | 6で対象タイルの公開完了または明示された失敗を待つ |
| 法線だけで山を表す仕様を輪郭・影まで再現できると誤認する | 近距離で山が塗り絵に見え、地平線や地形自己遮蔽と一致しない | 6で50kmと200kmを比較し、これは未実装の形状変形・地形影であることを検証結果へ記録する |
| 検証が人間の他分野のメモを上書き | 無関係な成果物の変更 | 6で地表専用の出力先と撮影入口を使う |
| データ全量をGitHub Pagesのアプリ成果物へ含める | releaseと配信量が巨大化する | 7でdocs/内容と配信用別成果物を検査 |
| 生gzipとHTTP圧縮を混同する | 展開に失敗して詳細が永続的に出ない | 7で実レスポンスのContent-Encodingと本文を確認 |
| 公開URL未設定でもコードだけ出荷する | 利用者には詳細が届かない | 7の公開ビルド検査。外部データ配置を公開作業の条件にする |

## 計画の検査後に着手する際の扱い

手順1・1.5・2および4〜7の初期実装は完了済みのコミットと残作業を上記へ記録した。以降も各段の検証は触った層へ
対応させ、画像が変わる段は地表画像を残す。
実装後にSPECを開いて現状へ合わせる作業は行わず、この計画の達成目標と検証条件で実装を判定する。
大きな変更の仕上げでは `/refactor` と必要なコメント点検を行う。
実データの全量取得、実GPUでの表示検証、ゲームへの接続、公開は残作業を終えてから実施する。
