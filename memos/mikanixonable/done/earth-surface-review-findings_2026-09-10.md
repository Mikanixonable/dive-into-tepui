# 地球表面タイル接続前後のレビュー残件

作成日: 2026-09-10
レビュー基準: `cc2b0416..d30a81d6`

## 今回修正した範囲

`createEarthSurfaceNodeMaterial` と `EarthSurfaceGpuThree` は存在していたが、
`Game`の実Renderer backendが`earthSystem`へ渡らず、NodeMaterialも既存の球メッシュへ
設定されていなかった。今回の別worktree修正では、次を接続した。

- `Game → Stage → solarSystem → earthSystem`へ初期化済みRendererを渡し、Earth runtimeへ接続する。
- resident coordinatorが所有するDataArrayTexture/page tableをEarthの材質へ渡す。
- base colorとESTB地形をbase fallbackとして同じNodeMaterialへ束ねる。
- 既存の全LODメッシュを新材質へ同時に切り替え、GPU非対応・再接続時は初期fallbackへ戻す。

以下はレビューで見つけたが、今回の接続修正には含めていない残件である。

## 現行コードでの再判定（2026-09-12）

- BUG-1（GPU側の緯度UV反転）は、CPU/GPU共有UVの回帰テスト追加後に解消済み。
- BUG-2（南端の`fract()` wrap）は、南端を最終texelへ保持する実装とテストで解消済み。
- BUG-3〜BUG-5、RISK-1〜RISK-2は未完了。実データbundleと実WebGPU表示確認も未完了である。
- 未完了項目は[残タスク一覧](./remaining-tasks_2026-09-12.md)へ集約した。この文書はレビューの根拠と
  詳細な修正案を保持するため、直下に残す。

## 修正優先度が高いもの

### [解消済み BUG-1] GPU側の緯度UVがCPU側の契約と南北反転している

対象: `src/render/earth-surface-coordinate.ts:64-70`

CPU実装`earthSurfaceUv`は北極を`v=0`、南極を`v=1`へ写す。一方、
`earthSurfaceUvFromRadialNode`は`asin(normal.y) / PI + 0.5`なので北極が`v=1`、
南極が`v=0`になる。今回NodeMaterialが実描画へ入ったことで、北半球が南半球の色・
地形を読む候補になる。

修正案:

- GPU式をCPU式と同じ`0.5 - asin(normal.y) / PI`へそろえる。
- `north-pole`、`equator`、`south-pole`でCPU/GPUの対応を固定するテストを追加する。
- 気候map、地表タイル、雲の共有UVにも同じ3点を使い、層ごとの独自補正を作らない。

### [解消済み BUG-2] タイルV座標の南端が`fract()`で北端へwrapする

対象: `src/render/earth-surface-material-node.ts:82-90`

`localV = uv.y * rows`を`clamp(0, 1)`したあと`fract()`しているため、
`v=1`では必ず`0`になる。CPU側の`earthTileSampleUv`は南端を最終texelへclampする
契約なので、南極付近で北側のgutterを読む不連続が残る。

修正案:

- 南端だけ`1`を保持する分岐を入れ、通常の行だけ周期`fract`を使う。
- `z=0`と`z=7`について`v=0`、`v=1`、南端直前の標本位置をCPU契約と比較する。

### [BUG-3] 新しいbase colorのアルベド倍率が材質へ渡っていない

対象: `src/render/earth-surface-material-node.ts`、
`src/render/earth-surface-material-binding.ts`、`src/game/celestial/solar-system/earth-system.ts`

旧Earth画像は`EARTH_TEXTURE.albedoScale`（現在値`0.9102`）を
`CelestialSurface.textured`で掛けている。新NodeMaterialの色ノードはbase/tile色を
そのまま返し、`EarthSurfaceSource`にも倍率の入力がない。データの平均輝度が同じ基準へ
正規化されていなければ、接続後のEarthだけ明るさが変わり、
`photometry.bondAlbedo`と見た目の輝度も一致しない。

修正案:

- manifestへデータセット固有の線形`albedoScale`を追加し、base/tile共通のuniformへ渡す。
- 旧`EARTH_TEXTURE`の値を直接render層へimportせず、manifestの測光メタデータを正本にする。
- 緯度重み付き線形平均からの導出値と、base/tile切替前後の輝度連続性を契約テストにする。

### [BUG-4] base colorの失敗と取得中断が観測・キャンセルできない

対象: `src/render/deferred-texture.ts:32-43, 62-71`

`ImageLoader.load`にerror callbackがなく、404・decode失敗でも`DeferredTexture`は未完了の
まま残る。`dispose`は公開を抑止するだけで、画像取得自体はAbortできない。今回のbindingは
地形取得の失敗をbase地形の初期値へ戻すが、base colorの失敗は`ready`状態から区別できない。

修正案:

- `DeferredTexture`へ成功・失敗状態とerror callbackを追加する。
- 可能なら`fetch + createImageBitmap`へ寄せてAbortSignalを共有し、少なくともLoaderの
  `onError`を公開する。
- EarthSurfaceの診断値でbase color/terrainの未完了・失敗・fallback使用を区別する。
- dispose、source切替、GPU非対応切替でネットワークとdecodeの両方が終了するテストを追加する。

### [BUG-5] `EarthSurface.replaceSource`が描画材質のsourceを更新しない

対象: `src/render/earth-surface.ts:176-184`

`replaceSource`はContextのdatasetとcoordinatorの状態を更新するだけで、既に接続済みの
`EarthSurfaceMaterialBinding`が持つbase color/terrain URLは旧sourceのままになる。
現在の呼び出し側は初回bootstrap後の`attach`が中心だが、公開APIのsource切替を使うと、
新datasetのtileと旧datasetのbaseが混ざる可能性がある。

修正案:

- source切替を`attach`相当の一つの寿命操作へまとめ、coordinator、binding、Contextを
  同じ世代で切り替える。
- 新材質が作れない場合は旧材質を残すか、明示的に初期fallbackへ戻す。
- datasetId変更、途中の旧base到着、再表示の3ケースを回帰テストにする。

## 設計・検証上の残件

### [RISK-1] WebGPU対応判定がFloat16線形標本化を実測していない

対象: `src/render/earth-surface-gpu-three.ts:25-38`

`isWebGPUBackend === true`なら`terrainFloat16Linear`も真にしている。WebGPU backendで
あることと、実環境の`RGBA16F` DataArrayTextureを要求どおり線形標本化できることは別の
能力であり、adapterの判定が楽観的だと実機だけ黒化・validation errorになる可能性がある。

修正案:

- Three.jsが公開するfeature/format能力を調べ、Float16配列テクスチャの線形標本化を
  判定する薄いadapterへ閉じ込める。
- 判定不能時は保守的にbase-onlyへ落とす。
- Apple Metalを含む実WebGPUで材質生成、最初のupload、線形標本化を行うcaptureを追加する。

### [RISK-2] Game全体の実配線を検査するテストがまだ薄い

今回追加したテストは、対応GPUのcoordinatorを`EarthSurface.attach`へ渡したときに既存LOD
メッシュの材質が変わることを直接検査する。`Game.create`からStageの静的factoryを通り、
実際のEarthへbackendが届く経路そのものは、型検査とコードレビューに依存している。

修正案:

- fake backendとfixture manifestを使い、`Game/Stage → earthSystem → EarthSurface`の
  composition rootを一度だけ組む統合テストを追加する。
- テストではcoordinatorのtexture参照とmeshのNodeMaterial接続が同じ実体であることを確認する。

### [GATE-1] 実データを使ったEarth描画captureが未完了

`npm run earth-surface:capture`はChromeのWebGPUとdrawing bufferまでは利用できたが、
実Earth surface datasetが無いため15ケースすべて`unavailable`を記録した。これはコードの
回帰テスト成功とは別の未達成ゲートである。

後続作業:

- BMNG/ETOPO/GSHHG/ERA5から実bundleを生成し、manifest、base、tile-index、z0〜z7、
  12 climate mapを同一datasetIdで検査する。
- fixtureではなく実bundleを静的配信し、z0/z1、親子fade、極、日付変更線、非一様半軸、
  自転角のcolor/normal/depthをcaptureする。
- 取得待ち、GPU upload、p95、fallback率をmetricsへ記録し、実機でこの接続を受け入れる。

## 今回の検証

- `npm run typecheck`: 成功
- `npm run test:render`: 116/116 成功
- `npm run test:game`: 205/205 成功
- `npm run earth-surface:capture`: WebGPU/drawing bufferは利用可能、実データ未投入のためunavailable
