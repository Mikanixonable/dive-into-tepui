# render 層境界の是正計画

## 目的

`render/` を、表示資源・表示用キャッシュと、毎フレーム供給された値から表示を決める計算だけを持つimmutableな出力層へ整理する。ランを跨ぐ設定、ゲーム進行上の mutable state、入力操作、天体や entity の選択判断は外へ出し、`render/` が必要とする情報は consumer 側で定義した細い readonly interface から取得する。

同時に、THREE/GPU 資源や表示専用計算を `game/` に残したために生じている逆配置を解消する。ただし、物理量を使うという理由だけで表示計算を `game/` へ戻してはいけない。状態を持たない純粋な計算であれば、`render/` も計算を行うことが歓迎される。`game/` を小さくすることと、インターフェイスを細くすることが目的。たとえば、軌道線のサンプリング、LOD、投影、照明・影・雲の近似など、表示だけが必要とする計算は `render/` に残す。

## 決めたこと

1. ランを跨ぐ user preference の mutable な正本は `src/settings/*.ts` に置く。これはランを開始するものではなく、`launcher/` の責務である起動判断・セーブ・解放記録とは別の意味論的層である。`main.ts` が settings と各 consumer を配線し、`launcher/` は必要な immutable value を受け取るだけにする。
2. 設定の値型、選択肢表、validator、immutable update 関数は、その値を解釈する層に残す。永続 store を丸ごと `game/`・`render/`・`hud/` へ渡さず、`main.ts` が値と変更 callback を配線する。
3. 集約対象は graphics、render style、BGM volume、theme palette、map の天体分類表示、天球 grid、orbit guide とする。settings window の開閉、panel の折り畳み、tab 選択は UI 復元状態、save/unlock はゲーム記録なので今回の集約対象外とする。
4. `CameraSystem` は game 側の操作・注視対象・保存可能な論理状態を持つ controller として残す。THREE camera、viewport 反映、near/far、floating origin は render 側の `CameraView` が所有し、1 回の sync で immutable な `CameraFrame` を確定する。
5. `MapVisibilityPolicy` は表示だけでなく pickability も決め、entity 種別と天体分類を知るため game に残す。render へは最終的な visible 値と線の表示宣言だけを渡す。
6. 軌道線の点列 query は render から game への readonly readback として維持する。クリック判定は再計算した軌道ではなく、実際に表示した geometry/cache と同じ点列を読む。physics に同じサンプリングを複製しない。
7. 地球の雲モデルだけは天体固有表示として render 内の Earth 固有近似を許す。ただし `game/celestial/solar-system/constants` は import せず、半径と自転周期を構築時の細い入力として受ける。雲以外の海岸線・月面模様は汎用 overlay と天体別 asset 選択へ分ける。
8. `game/celestial/scale-grid-view` と `game/marker/` の責務再設計は対象外とする。camera/floating-origin の型変更を通すための機械的な引数更新は行うが、scale-grid の天体名判断や marker の所有・API は変更しない。
9. render 内部だけで閉じる helper の `show` / `hide` / `set` 一括改名は対象外とする。今回是正するのは層を越えて公開される command API と、所有層の誤りである。
10. `settings/` の primitive は `src/settings/stored-setting.ts` が持つ。`SettingStorage`(`read` / `write`、失敗はここで吸収)、`browserSettingStorage`、`MemorySettingStorage`、`SettingValue<T>`(`readonly current: T` だけの面)、`StoredSetting<T>`(`constructor(storage, key, parse, format)` / `current` / `set` / `subscribe`。`subscribe` は登録時に現在値で1度呼ぶ)。設定を書き換えない consumer には `SettingValue` を渡す。
11. 配色 id だけは `src/settings/theme-setting.ts` が module 直下の単一 instance として持つ。`theme.ts` が module 評価時の `ACTIVE_THEME` から全色トークン定数を導いており、初期値を注入する余地がないため。`UserSettings` は `theme.ts` を import しない(循環になる)。
12. テストの層は `settings`(`tests/settings/`、`npm run test:settings`)。層名は `tests/run.ts` の規約どおり `src/` のフォルダ名に揃える。
13. node のテストから `src/render/` を評価できるよう、`tests/repo-assets.ts` が webpack の `require.context` と `.cube` の代役を持つ。差し込みは `"use strict";` の直後で、改行を足さない。
14. ランが読むラン跨ぎ設定は、`game/` が自分で宣言した `RunSetting<T>`(`src/game/run-setting.ts`。`readonly current` と `set`)で受ける。`settings/` の `StoredSetting` がこの面を構造的に満たすので、`main.ts` が変換なしで渡す。**`game/` から `settings/` を import しない。**
15. `GameHost` が `mapDisplay` / `grid` / `orbitGuide` の `RunSetting` を運ぶ。ラン跨ぎの持ち物という `GameHost` の既存の意味に載るので、`Launcher` の引数は増えない。
16. 表示パネル(`ViewOptionsPanel`)の所有と、その操作を設定・描画側へ結ぶ責務は `src/game/hud/panels/view-options-control.ts` の `ViewOptionsControl` が持つ。`CameraSystem` はパネルも天体分類トグルも持たない。`Navball` は削除済み。
17. `CelestialSystem.sync` と `ObjectPickables.refresh` は `MapDisplayToggles` をそのフレームの引数で受け、`MapView` は `RunSetting<MapDisplayToggles>` を構築時に受ける。カメラ経由で読まない。

## 達成目標

- `src/render/**/*.ts` から `game/` への import は、今回対象外の `game/marker/` だけになる。`CameraSystem`、`DynamicMotion`、`CelestialBodies`、`MapVisibilityPolicy`、protein の game 型、solar-system constants への import は 0 件になる。
- `rg -n 'localStorage|sessionStorage' src/render src/game/camera src/game/navball src/game/celestial/orbit-guide src/audio/bgm src/theme.ts` が 0 件になる。UI 開閉・panel/tab 復元用 storage は検索対象外の HUD ファイルに残してよい。
- `CameraSystem`、`FocusCamera`、`GunsightCamera` から THREE camera と `window.innerWidth` / `window.innerHeight` が消え、render の view が同じフレームの viewport、camera、floating origin を確定する。
- `src/game/lines/{ellipse-line,target-relative-line,trajectory-line}.ts`、`src/game/dynamic/instanced-pools.ts`、`src/game/player/reentry-effects.ts`、`src/game/celestial/body-frame.ts`、`src/game/protein/protein-runtime.ts` がなくなり、対応する表示実装が `src/render/` 配下にある。
- dynamic/celestial/protein view の public sync 入力は render 側で定義した readonly interface となり、具象 Motion/System の `instanceof` や mutable object 全体の受け渡しが 0 件になる。
- orbit guide、plan path、creative placement、celestial illumination、flash effect は、game の判断・寿命・編集 state と render の資源・同期処理が別 owner になる。
- `EarthCoastline` と `MoonSurfaceMarkings` という天体固有 class、および対応 asset import が `src/render/` から 0 件になる。汎用 line overlay は render に残る。
- orbit/reference/trajectory line の `samplePoints` / `lineSamples` query が、表示済み revision と同じ点列を返すテストを持ち、`game/pickable/line-pickables.ts` はその query を使い続ける。
- 同じ入力で `thrust-effects` / `rcs-effects` を同一 display time に複数回 sync しても乱数結果が変わらない。
- 全手順で `npm run typecheck` が通り、最終的に `npm run test:physics`、`npm run test:game`、`npm run test:render`、`npm run test:settings` が通る。

## 手順

### 手順 3. camera controller と render camera view を分離する

#### 目的

mutable な入力操作・注視対象と、THREE camera・viewport・floating origin を別 owner にする。render の各 view は `CameraSystem` ではなく、同一 sync で確定した `CameraFrame` だけを読む。この時点で投影結果、near/far、zoom 挙動は変えない。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `src/render/camera/camera-frame.ts`（新規） | active THREE camera、camera position/quaternion、view kind、zoom、projection/scale、viewport を持つ readonly frame contract を定義する。 |
| `src/render/camera/camera-view.ts`（新規） | perspective/orthographic/gunsight camera を所有し、論理 `Viewpoint` と viewport から 1 回の sync で `CameraFrame` を確定・破棄する。 |
| `src/render/camera/floating-origin.ts`（`src/game/camera/floating-origin.ts` から移動） | render 技術としての原点・速度と THREE 変換を所有する。 |
| `src/game/camera/camera-system.ts:148-175,245-259,308-374` | THREE camera、render sync、floating origin 生成、ViewOptionsPanel を除き、操作 state と `Viewpoint`/view kind/zoom の論理出力だけにする。 |
| `src/game/camera/focus-camera.ts:198-202,300-312,382-443` | THREE camera と viewport global を除く。Earth/Moon を使う reference-plane 判断、focus、回転 follow、通知は game controller に残す。 |
| `src/game/camera/gunsight-camera.ts:1-55` | THREE camera と window 依存を除き、gunsight `Viewpoint` の計算だけにする。 |
| `src/render/scene.ts:37-61` | window resize listener と resolution closure を除き、明示 viewport/graphics value で renderer を同期する。 |
| `src/render/camera-scale.ts:20-24` | `window.innerHeight` をやめ、frame の viewport height を使う。 |
| `src/main.ts:43-80` | 各 frame の `{width,height,pixelRatio}` を取得し、update/sync の明示入力へする。 |
| `src/game/game.ts:137,196-207,317-334,397-405,479-561` | CameraView を生成・所有・破棄し、CameraSystem の論理出力を sync して、以後の sync/render に同じ CameraFrame/FloatingOrigin を渡す。 |
| `src/game/view/map-view.ts:136-155` | game の pointer/pick 計算には `Viewpoint`/`ProjectFn`/camera position の細い値を使う。 |
| `src/game/view/combat-view.ts:91-123` | 同上。 |
| `src/game/pickable/map-picking.ts:81-114,180` | viewport を明示入力にし、window と concrete camera system の投影依存を除く。 |
| `src/game/pickable/object-pickables.ts:66-92` | camera position、projection、設定値を個別入力にする。 |
| `src/game/pickable/object-windows.ts:138-191,230-298` | view/focus controller の最小 command/query に依存する。 |
| `src/game/targeter.ts:115-192` | frame の projection/scale/position と game の view kind を明示して受ける。 |
| `src/game/nav-target.ts:293-294` | projection/position を個別入力にする。 |
| `src/game/control-selection.ts:64` | map focus の細い `FocusSink`/clear command へ依存する。 |
| `src/game/hud/frame/frame-controls.ts:27-71` | render camera ではなく logical FocusCamera controller を操作する。 |
| `src/game/hud/frame/camera-frame-panel.ts:40-146` | 同上。 |
| `src/game/hud/panels/map-scale-badge.ts:27-28` | `ScaleFn` と focus position を受ける。 |
| `src/game/hud/panels/vessel-panel.ts:235` | combat camera の logical follow state だけを受ける。 |
| `src/game/celestial/scale-grid-view.ts:20-48` | 対象外機能の判断は変えず、camera frame/floating-origin の新しい型へ機械的に接続する。 |
| `src/render/celestial/celestial-grid.ts:275-321` | window dimensions を frame viewport へ置き換える。 |
| `src/render/celestial/scale-grid.ts:131-170` | 同上。天体名に関する既存判断は変更しない。 |
| `src/render/dynamic/dynamic-view.ts:12-13,32-42,83-100` | `CameraSystem` を `CameraFrame` に置換し、寄せ集めの `DynamicViewFrame` から camera を分離する。 |
| `src/render/dynamic/player/attached-boosters-view.ts:5,40-74` | render 側 FloatingOrigin/CameraFrame を使う。 |
| `src/render/dynamic/player/thrust-effects.ts:12,30-65` | 同上。 |
| `src/render/dynamic/player/rcs-effects.ts:11,32-60` | 同上。 |
| `src/render/celestial/celestial-entity/celestial-view.ts:8-10,53-109` | `CameraFrame` と render 側 FloatingOrigin を受ける。 |
| `src/render/celestial/celestial-entity/star-celestial-view.ts:7-8,42-75` | 同上。 |
| `src/render/celestial/celestial-entity/sphere-celestial-view.ts:6-7,66-101` | 同上。 |
| `src/render/celestial/celestial-entity/point-celestial-view.ts:7-8,124-223` | 同上。 |
| `src/render/celestial/celestial-entity/geostationary-overlay.ts:8-9,68-124` | 同上。 |
| `src/render/celestial/point-field-view.ts:7,51-100` | 同上。 |
| `tests/render/camera-view.test.ts`（新規） | perspective/orthographic/gunsight の frame、viewport 変更、floating-origin 変換を固定入力で検証する。 |
| `tests/game/camera-orientation.test.ts` | controller 分離後も logical orientation を検証する。 |
| `tests/game/focus-target.test.ts` | focus 解決を維持する。 |

#### 達成条件と検証

- `rg -n 'three/webgpu|window\.(innerWidth|innerHeight)' src/game/camera` が 0 件。
- `rg -n 'CameraSystem|game/camera/floating-origin' src/render` が 0 件。
- `CameraView.sync` 1 回で得た frame が camera、projection、scale、floating origin の同一時点を表し、同じ入力を再 sync した結果が一致する。
- `npm run typecheck`
- `npm run test:math`
- `npm run test:game`
- `npm run test:render`

### 手順 4. 天体表示の基礎値を細い境界へ移す

#### 目的

body-frame、point field、Earth cloud の表示計算を game の具象 module から切り離す。天体固有の生成・選択は game に残し、render は汎用の軌道要素または構築時に注入された world scale だけを読む。この時点で点群分布と雲の調整値は変えない。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `src/render/celestial/body-frame.ts`（`src/game/celestial/body-frame.ts` から移動） | THREE matrix への body orientation 反映を render 所有にする。 |
| `src/render/celestial/celestial-entity/point-celestial-view.ts:16,187,207` | 移動後の body-frame を使う。 |
| `src/game/celestial/celestial-illumination.ts:17,125` | 手順 10 までの暫定 call site を移動後 path へ更新する。 |
| `src/physics/point-orbit.ts`（新規） | `PointElements` と `pointPositionAt` の THREE 非依存な軌道評価を置く。 |
| `src/game/celestial/point-field.ts:8-36` | 削除し、物理要素は physics、表示 group 型は render へ分ける。 |
| `src/render/celestial/point-field-view.ts:8,15-110` | `PointField`/group の readonly 表示契約を定義し、位置評価だけ physics から読む。`sync({visible,...})` 1 本へする。 |
| `src/game/celestial/solar-system/point-field.ts:10,28-52,187-220` | 天体名・分布・色・draw radius の決定を残し、render の表示契約を組み立てる。 |
| `src/game/celestial/solar-system/solar-system.ts:12-13,87` | 生成結果を PointFieldView へ注入する。 |
| `src/game/celestial/celestial-system.ts:121,384-440` | point field の visible を declarative sync に含める。 |
| `src/render/cloud/generated-cloud-field.ts:20-26` | radius/rotation period を持つ Earth-cloud world input を構築時に受け、WeatherModel へ渡す。 |
| `src/render/cloud/weather-model.ts:10,263-305,499` | game constants import を除き、world input を使う。 |
| `src/render/cloud/air-mass.ts:8,43-92` | radius を constructor から使う。 |
| `src/render/cloud/climate-map.ts:5,20` | radius を引数で使う。 |
| `src/render/cloud/cyclone-tracks.ts:6,180` | radius を引数で使う。 |
| `src/render/cloud/cyclones.ts:7,41-104` | radius を引数で使う。 |
| `src/render/cloud/rossby-wave.ts:6,18-50` | radius を引数で使う。 |
| `src/render/cloud/wind-law.ts:6,17-20` | radius と rotation period を引数で受ける pure function にする。 |
| `src/game/celestial/solar-system/earth-system.ts:192-193` | Earth の半径・自転周期を GeneratedCloudField の構築時に注入する。 |
| `tools/cloud-lab/pane.ts:21` | lab case の world scale を明示する。 |
| `tests/game/point-field.test.ts:6-25,120-130` | import を physics/render の新 owner へ更新し、分布と位置の既存期待値を維持する。 |
| `tests/render/cyclone-tracks.test.ts:7-10` | radius を fixture から与える。 |
| `tsconfig.test.json:19-39` | 新しい point-orbit と render point-field contract を test build に含める。 |

#### 達成条件と検証

- `rg -n 'game/celestial/(body-frame|point-field)|game/celestial/solar-system/constants' src/render` が 0 件。
- `rg -n 'class PointFieldView' src/render/celestial/point-field-view.ts` の public 表示 command が `sync` と readonly query/dispose だけになる。
- seed と sim-zero が同じときの点群分布、および既存 cloud sampling test の数値が変わらない。
- `npm run typecheck`
- `npm run test:physics`
- `npm run test:game`
- `npm run test:render`

### 手順 5. 天体固有 overlay の選択を game へ戻す

#### 目的

render に残る Earth coastline と Moon surface markings の名指しを除く。render は asset data から line overlay を作る汎用 factory と共有 cache だけを持ち、どの天体にどの data を割り当てるかは solar-system assembly が決める。この時点で線の形、色、半径 offset は変えない。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `src/render/celestial/line-overlay.ts:1-27` | 緯度経度 loop / surface marking data を受ける generic factory と cache lifecycle を追加する。 |
| `src/render/celestial/earth-coastline.ts:1-50` | 天体固有 class と asset import を削除する。 |
| `src/render/celestial/moon-surface-markings.ts:1-51` | 天体固有 class と asset import を削除する。 |
| `src/game/celestial/solar-system/earth-system.ts:22-23,199,211` | Earth/Moon asset を選び、generic overlay factory へ data と style を渡す。 |
| `tools/render-lab/cases.ts:17,647` | Earth 固有 case は tool 側で asset を選んで generic factory へ渡す。 |
| `tests/render/line-overlay.test.ts`（新規） | 両 data shape から同じ閉曲線・半径 offset が作られることを検証する。 |

#### 達成条件と検証

- `rg -n 'EarthCoastline|MoonSurfaceMarkings|assets/earth-coastline|assets/moon' src/render` が 0 件。
- generic overlay module に `'earth'` / `'moon'` の id 分岐がない。
- `npm run typecheck`
- `npm run test:game`
- `npm run test:render`

### 手順 6. 基本の軌道線資源を render へ移し、declarative sync にする

#### 目的

THREE/Curve を所有する 3 種の軌道線を render へ移す。game は「どの基準で、どの役割の線を表示するか」を決め、render は style、sampling、geometry、cache を決める。表示済み点列の readback は維持する。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `src/render/lines/ellipse-line.ts`（`src/game/lines/ellipse-line.ts` から移動） | resource owner を移し、geometry/style/visible を 1 回の sync 入力へまとめる。 |
| `src/render/lines/target-relative-line.ts`（`src/game/lines/target-relative-line.ts` から移動） | 同上。 |
| `src/render/lines/trajectory-line.ts`（`src/game/lines/trajectory-line.ts` から移動） | 同上。 |
| `src/render/lines/line-display.ts`（新規） | self/enemy/ally/reference/preview 等の semantic role と source query を持つ readonly 表示宣言を定義する。 |
| `src/render/dynamic/dynamic-view.ts:15-17,63-65,122-236` | render 所有線を使い、宣言を 1 回で同期する。`lineSamples` は表示済み revision を読む query として残す。 |
| `src/render/celestial/celestial-entity/celestial-view.ts:18,42,107-145` | reference ellipse を render 所有にし、`referenceLineSamples` を維持する。 |
| `src/render/celestial/celestial-entity/geostationary-overlay.ts:10,38,68-92` | 同上。 |
| `src/game/lines/entity-line-manager.ts:2-22,59-181` | THREE、theme color、LineStyle を除き、entity 種別・可視性・orbit basis から semantic line declaration を作る。 |
| `src/game/orbit-reference.ts:19-53` | `DynamicEntity` を含む basis を render へ渡さず、manager 内で readonly line source へ解決する。 |
| `src/game/dynamic/dynamic-entity/dynamic-entity.ts:78` | Motion→View の唯一の結節点から line declaration を view へ渡す。 |
| `src/game/celestial/celestial-system.ts:338` | reference line sample query の import/path を更新する。 |
| `src/game/pickable/line-pickables.ts:51-76` | 実際に sync 済みの render line query を読み続ける。 |
| `src/physics/state-queue.ts:83` | 移動後の責務を指すコメント path を更新する。 |
| `tests/render/line-samples.test.ts`（新規） | ellipse/trajectory/relative line の表示 revision、非表示時、sample count cache を検証する。 |
| `tests/game/line-pickables.test.ts`（新規） | pickable が render から受けた点列を変換・再生成せず使うことを検証する。 |

#### 達成条件と検証

- `src/game/lines/` には game の表示判断だけが残り、`rg -n 'three/webgpu|Curve|LineStyle|currentThemePalette' src/game/lines` が 0 件。
- 3 line class の公開変更 API は declarative `sync`、readonly sample query、`dispose` だけになる。
- line sample test で、同じ synced revision と count には同一内容が返り、非表示宣言後は空になる。
- `npm run typecheck`
- `npm run test:game`
- `npm run test:render`

### 手順 7. orbit guide・plan・creative preview の game state と view を分ける

#### 目的

`game/` に残る純表示資源を render へ移す。orbit catalog/zero-velocity の選択・天体名判断、plan の編集・軌道区間計算、creative placement の入力は game に残し、Curve/THREE/marker triangle/gizmo/preview line は render が所有する。この時点で計算する軌道、選択対象、表示 style は変えない。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `src/render/celestial/orbit-guide/guide-curve.ts`（`src/game/celestial/orbit-guide/guide-curve.ts` から移動） | Curve resource と表示済み sample revision を所有し、declarative sync にする。 |
| `src/render/celestial/orbit-guide/direction-markers.ts`（`src/game/celestial/orbit-guide/direction-markers.ts` から移動） | instanced triangle、camera scale、配置を render 所有にする。これは `game/marker/` の対象外 marker system には統合しない。 |
| `src/game/celestial/orbit-guide/orbit-guide-model.ts`（新規） | catalog、Earth 固有基準、loop 再計算、semantic style role、visible guide metadata を `orbit-guide-lines.ts` から分離する。 |
| `src/render/celestial/orbit-guide/orbit-guide-view.ts`（新規） | `GuideCurve` 群と direction markers を所有し、model declaration と CameraFrame から sync する。表示済み線 query を公開する。 |
| `src/game/celestial/orbit-guide/orbit-guide-lines.ts:198-486` | model/view へ分割後に削除する。 |
| `src/game/celestial/orbit-guide/zero-velocity-model.ts`（新規） | rotating frame と zero-velocity curve set の再計算を分離する。 |
| `src/render/celestial/orbit-guide/zero-velocity-view.ts`（新規） | GuideCurve 資源と sync を所有する。 |
| `src/game/celestial/orbit-guide/zero-velocity-lines.ts:114-239` | model/view へ分割後に削除する。 |
| `src/game/celestial/celestial-system.ts:104-106,147-151,344,402-403` | model と view の生成・sync・sample query の結節点にする。 |
| `src/game/pickable/line-pickables.ts:51` | CelestialSystem の表示済み orbit-guide query を使う。 |
| `src/render/plan/plan-path-view.ts`（新規） | TrajectoryLine 群、visible/style、表示済み sample cache を所有する。 |
| `src/game/plan/plan-path.ts:7,17-20,75-110,482` | trajectory/impact/apsis の計算と cache を残し、THREE/line resource を PlanPathView へ出す。 |
| `src/render/plan/plan-gizmo-3d.ts`（`src/game/plan/plan-gizmo-3d.ts` から移動） | THREE gizmo resource を render 所有にし、位置・軸・active drag を 1 回の sync で受ける。 |
| `src/game/plan/plan-editor.ts:21-29,70,463-573` | edit state と pointer 操作を残し、gizmo view へ readonly 表示値を渡す。 |
| `src/game/plan/plan-display.ts:3,16-20,82-180` | plan/marker の game 判断を残し、PlanPathView と CameraFrame を同期する。 |
| `src/render/creative/object-placement-preview-view.ts`（新規） | preview ellipse と marker 投影の表示資源を所有する。 |
| `src/game/creative/object-placement.ts:10,15,28,54-57,108-155` | form/placement/occlusion 判断を残し、preview の readonly source/visible を view へ渡す。 |
| `tests/render/orbit-guide-view.test.ts`（新規） | model declaration の再構築、camera sync、表示済み sample query を検証する。 |
| `tests/render/plan-path-view.test.ts`（新規） | active line count と非表示時の resource sync を検証する。 |

#### 達成条件と検証

- `rg -n 'three/webgpu|render/curve|render/line-style' src/game/celestial/orbit-guide src/game/plan/plan-path.ts src/game/plan/plan-gizmo-3d.ts src/game/creative/object-placement.ts` が 0 件。
- orbit guide の Earth 固有判断は game model にだけあり、render view に `'earth'` / `'moon'` 分岐がない。
- orbit guide と plan path の click query は render view が同期済みの点列を返す。
- `npm run typecheck`
- `npm run test:physics`
- `npm run test:game`
- `npm run test:render`

### 手順 8. dynamic view を具象 Motion/System から切り離す

#### 目的

dynamic view が mutable な `DynamicMotion`、game の可視性 policy、entity kind、player subsystem を直接読む構造をやめる。各 entity が Motion→View の結節点で狭い readonly source と visible/line declaration を渡し、render は必要な時刻の状態だけを問い合わせて表示計算する。巨大な事前計算点列は渡さない。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `src/render/dynamic/dynamic-view.ts:12-46,82-109,188-258` | `DynamicRenderSource` と共通 frame の最小面を定義する。`DynamicMotion`、CelestialBodies、MapVisibilityPolicy、OrbitReference、DynamicEntityKind を除き、state query・attitude・thermal・line source・resolved visible を受ける。 |
| `src/game/dynamic/dynamic-entity/dynamic-entity.ts:12,78` | entity が motion を render source へ構造的に射影して view.sync を呼ぶ唯一の結節点になる。 |
| `src/game/dynamic/dynamic-system.ts:16,45-74` | render pool の lifecycle を render owner として生成・frame sync・破棄する。 |
| `src/render/dynamic/instanced-pools.ts`（`src/game/dynamic/instanced-pools.ts` から移動） | pool と GPU/THREE 資源を所有する。capacity は構築時の表示値として受ける。 |
| `src/render/dynamic/dynamic-entity/base-view.ts:7-9,28-61` | `instanceof BaseMotion` を除き、base 固有 readonly source を受ける。marker は対象外のため既存接続を維持する。 |
| `src/render/dynamic/dynamic-entity/detached-booster-view.ts:12-13,34-59` | `instanceof DetachedBoosterMotion` を除き、stage appearance と zoom/display state を受ける。 |
| `src/render/dynamic/dynamic-entity/bullet-view.ts:5-49` | DynamicMotion を除き、position/appearance/pool source を受ける。 |
| `src/render/dynamic/dynamic-entity/debris-piece-view.ts:15-69` | DynamicMotion/DebrisKind を除き、game が選んだ render variant を受ける。 |
| `src/render/dynamic/dynamic-entity/metal-enemy-view.ts:4-7` | game 定数を import せず、entity assembly から model scale を受ける。 |
| `src/render/dynamic/player/player-view.ts:9-18,44-153` | `instanceof PlayerMotion` と player subsystem import を除き、player 固有 source を受ける。 |
| `src/render/dynamic/player/attached-boosters-view.ts:13,25-57` | `BoosterStage` 全体でなく id/appearance の最小列を受ける。 |
| `src/render/dynamic/player/belt-view.ts:6,24-43` | BeltPhysics 全体でなく anchor/positions/twists の readonly 面を受ける。 |
| `src/render/dynamic/player/power-view.ts:2-29` | SolarSide と closure を除き、up/down deploy value を受ける。 |
| `src/render/dynamic/player/radiator-view.ts:2-35` | RadiatorSide と closure を除き、up/down の wear/tilt value を受ける。 |
| `src/render/dynamic/player/reentry-effects.ts`（`src/game/player/reentry-effects.ts` から移動） | Billboard 資源と動圧からの表示計算を render 所有にする。 |
| `src/render/dynamic/player/thrust-effects.ts:30-65` | `Math.random()` を displayTime/entity/nozzle seed からの deterministic visual noise に置換する。 |
| `src/render/dynamic/player/rcs-effects.ts:32-60` | 同上。 |
| `src/game/dynamic/dynamic-entity/base.ts:124` | base view source を組み立てる。 |
| `src/game/dynamic/dynamic-entity/detached-booster.ts:36` | booster view source/appearance を組み立てる。 |
| `src/game/dynamic/dynamic-entity/debris-piece.ts:28-99` | debris logical kind を render variant に変換する。 |
| `src/game/dynamic/dynamic-entity/metal-enemy.ts:31-37` | model scale/collision definition を motion と view の両方へ構築時に渡す。 |
| `src/game/dynamic/dynamic-entity/enemy-motion.ts:15-29` | render が読む exported model scale を除き、物理 collision 値は constructor/definition から受ける。 |
| `src/game/dynamic/dynamic-entity/enemy.ts:43,259-261` | shared enemy definition の scale を effect/debris/view へ明示する。 |
| `src/game/player/player.ts:163,337-398` | player view source、belt/solar/radiator の値を Motion→View sync で組む。 |
| `src/game/player/player-motion.ts:23-39` | render 用具象型の露出をやめる。 |
| `src/game/player/belt.ts:8-37` | `BELT_MAX_VISIBLE` を physics/view 共通の構築値として Player assembly から渡し、render import 用 export を除く。 |
| `src/game/player/belt-physics.ts:36-214` | readonly view source を満たす値だけを getter で公開する。 |
| `src/game/player/attached-booster-motion.ts:30-49` | view へ stage appearance の最小面を提供する。 |
| `src/game/player/power.ts:12-77` | game の mutable deploy state は残し、sync 時に value record を作る。 |
| `src/game/player/radiator.ts:26-214` | game の update/wear state は残し、sync 時に value record を作る。 |
| `tests/render/enemy-model-bounds.test.ts:4-11` | assembly から渡す model scale と collision bounds の一致を検証する。 |
| `tests/render/dynamic-view-source.test.ts`（新規） | narrow source の時刻 query、resolved visibility、同一時刻の deterministic effect sync を検証する。 |

#### 達成条件と検証

- `rg -n 'DynamicMotion|CelestialBodies|MapVisibilityPolicy|OrbitReference|DynamicEntityKind|BeltPhysics|BoosterStage|RadiatorSide|SolarSide|ENEMY_MODEL_SCALE|BELT_MAX_VISIBLE' src/render/dynamic` が 0 件。
- `rg -n 'instanceof (BaseMotion|DetachedBoosterMotion|PlayerMotion)' src/render` が 0 件。
- view へ渡す trajectory/orbit source は時刻 query を持ち、game 側で表示点列を事前構築していない。
- `npm run typecheck`
- `npm run test:game`
- `npm run test:render`

### 手順 9. protein の論理定義と表示 runtime を分離する

#### 目的

protein の display vocabulary、GPU motion binding、THREE object builder/cache を render に集め、combat state、Brownian/motion update、collision definition、save/HUD state は game に残す。render view は game の schema/runtime/registry を import せず、表示に必要な構造的 subset だけを受ける。この時点で asset format、collision sphere、LOD threshold、色選択の挙動は変えない。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `src/render/protein/protein-display.ts`（`src/game/protein/protein-display.ts` から移動） | representation/color setting の値型、label、pure update/validator を表示語彙として所有する。 |
| `src/render/protein/protein-display-asset.ts`（`src/game/protein/protein-display-asset.ts` から移動） | 表示 asset schema と validator を所有する。 |
| `src/render/protein/protein-motion-modes.ts`（`src/game/protein/protein-motion-modes.ts` から移動） | GPU displacement 用の immutable flattening を所有する。 |
| `src/render/protein/protein-runtime.ts`（`src/game/protein/protein-runtime.ts` から移動） | THREE/GPU resource、visual rebuild/cache、dispose を所有する。 |
| `src/render/protein/protein-render-definition.ts`（新規） | build/recolor closure と `ProteinRenderSource` を game の collision definition から分ける。 |
| `src/render/protein-atom-view.ts` | `src/render/protein/protein-atom-view.ts` へ移し、render 側の狭い display asset を読む。 |
| `src/render/protein-ribbon.ts:3-5` | `src/render/protein/protein-ribbon.ts` へ移し、game schema import を render 側の asset/motion source に置換する。 |
| `src/render/protein-ribbon-color.ts:3` | `src/render/protein/protein-ribbon-color.ts` へ移し、render 所有の color mode を読む。 |
| `src/render/protein-silhouette-view.ts:2` | `src/render/protein/protein-silhouette-view.ts` へ移し、render 所有の display setting を読む。 |
| `src/render/protein-enemy-ship.ts:2-11` | `src/render/protein/protein-enemy-ship.ts` へ移し、render definition/source だけを受ける。 |
| `src/render/protein-motion-material.ts` | `src/render/protein/protein-motion-material.ts` へ移し、GPU motion binding の owner をまとめる。 |
| `src/render/dynamic/dynamic-entity/protein-enemy-view.ts:2-18,39-114` | game Runtime/Definition/Display/MotionDisplay/HudSnapshot/DynamicMotion を除き、render definition と protein render source を受ける。 |
| `src/game/protein/protein-enemy-registry.ts:1-57` | collision sphere、semantic asset id、motion definition だけを返す game registry と、render definition の assembly に分ける。THREE/build/recolor を除く。 |
| `src/game/protein/protein-asset-loader.ts:1-20,45-90` | semantic/collision source と render source を明示的に分けて bundle する。 |
| `src/game/protein/protein-schema.ts:68-168` | combat/save/HUD schema を残す。render が必要な geometry/motion subset は render interface に構造的に適合させる。 |
| `src/game/protein/protein-motion-controller.ts:11-38,150-317` | mutable sampling/LOD state を game に残し、`ProteinMotionDisplay` は render 側の readonly value に適合させる。 |
| `src/game/protein/protein-combat-state.ts` | render runtime を import せず semantic combat state だけを保持する。 |
| `src/game/dynamic/dynamic-entity/protein-enemy.ts:7-28,73-162` | game definition と render definition を組み立て、display/motion/HUD の必要値を別々の consumer へ渡す。 |
| `src/launcher/debug-info-window.ts:16` | LOD label 用の immutable 候補表を render の display vocabulary から読む。 |
| `tools/render-lab/protein-cases.ts:5-7` | render definition/display 型を新 path から使い、必要なら game motion controller を fixture として注入する。 |
| `tests/protein-test-assets.ts` | semantic asset と render source の fixture を分ける。 |
| `tests/render/protein-ribbon-geometry.test.ts` | 新しい render source contract を使う。 |
| `tests/render/protein-render-bindings.test.ts:4-9` | game schema/motion-mode import を除き、render binding のみ検証する。 |
| `tests/game/protein-motion-controller.test.ts` | mutable motion controller の既存回帰を維持する。 |
| `tests/game/protein-combat-state.test.ts:11-31` | collision/combat と render definition を別 fixture にし、game test が THREE runtime を生成しないようにする。 |
| `tsconfig.test.json:19-39` | 移動後の game/render protein module を正しい layer test に含める。 |

#### 達成条件と検証

- `rg -n 'game/protein|game/dynamic' src/render/protein src/render/dynamic/dynamic-entity/protein-enemy-view.ts` が 0 件。
- `rg -n 'three/webgpu|render/' src/game/protein/protein-enemy-registry.ts src/game/protein/protein-runtime.ts` は旧 runtime 削除後 0 件。
- game protein tests が THREE object/runtime を構築せず、render tests が combat mutable state を構築しない。
- `npm run typecheck`
- `npm run test:game`
- `npm run test:render`

### 手順 10. celestial illumination を render view にする

#### 目的

lighting/shadow/atmosphere target へ値を書く表示同期を render へ移す。game の CelestialSystem は star、focus position、可視性を選び、render は readonly celestial light source と display time から照明候補・影・atmosphere draw を計算する。巨大な計算済み target 配列は game から渡さない。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `src/render/celestial/celestial-illumination.ts`（`src/game/celestial/celestial-illumination.ts` から移動・分割） | THREE scratch/cache と sun/exposure/ambient/planet-light/shadow/atmosphere の表示計算を所有する。CelestialBodies/Entity/CameraSystem/MapVisibilityPolicy は import しない。 |
| `src/render/celestial/celestial-entity/celestial-view.ts:41-165` | illumination が読む light/albedo/ring/cumulus/atmosphere の readonly source を render 側で定義する。 |
| `src/render/celestial/celestial-entity/point-celestial-view.ts` | body-frame と atmosphere/light source を新 contract に適合させる。 |
| `src/render/celestial/celestial-entity/sphere-celestial-view.ts` | 同上。 |
| `src/render/celestial/celestial-entity/star-celestial-view.ts` | star light source を新 contract に適合させる。 |
| `src/game/celestial/celestial-system.ts:19,81,147-150,362-405` | star/focus/visible の選択、Motion→View の結節、illumination view の sync を行う。 |
| `src/game/celestial/celestial-entity/celestial-entity.ts` | motion と view を結ぶ箇所で illumination source を構造的に提供する。 |
| `src/game/map/visibility-policy.ts:92-186` | policy と Earth satellite 特例を game に維持し、最終 category visible だけを CelestialSystem へ返す。 |
| `tests/render/celestial-illumination.test.ts`（新規） | fixed source から light/shadow/atmosphere target へ書く値と、非表示候補の除外を検証する。 |

#### 達成条件と検証

- `src/game/celestial/celestial-illumination.ts` がなくなる。
- `rg -n 'CelestialBodies|CelestialEntity|CameraSystem|MapVisibilityPolicy|focusTargetId' src/render/celestial/celestial-illumination.ts` が 0 件。
- lighting/影/atmosphere の候補選択は render 内に残り、game が GPU target 用配列を事前構築していない。
- `npm run typecheck`
- `npm run test:physics`
- `npm run test:game`
- `npm run test:render`

### 手順 11. flash effect の寿命 state と表示 pool を分離する

#### 目的

一時 effect の生成・寿命・移流という mutable game state と、Billboard/InstancedPool への出力を分ける。既存 spawn API は game owner に残して呼び出し側の変更を絞り、render view は生存中 effect の readonly 列を sync する。この時点で duration、size curve、color、移流は変えない。

#### 変更が必要な箇所

| ファイル | 変更 |
| --- | --- |
| `src/game/vfx/flash-effects.ts:20-42,56-64,97-172` | THREE/resource/style を除き、effect state、spawn、update、readonly display source を所有する。 |
| `src/render/vfx/flash-effects-view.ts`（新規） | geometry/material/InstancedPool/scratch transform を所有し、effect source、FloatingOrigin、CameraFrame から sync する。 |
| `src/game/game.ts:18,92,186,317-334,531` | game state と render view を別々に生成・update・sync・dispose する。 |
| `src/render/vfx-style.ts:9-18` | visual constants の owner を維持し、render view から使う。 |
| `tests/game/flash-effects.test.ts`（新規） | spawn、age、移流、期限切れ、上限へ渡す readonly source を検証する。 |
| `tests/render/flash-effects-view.test.ts`（新規） | size/brightness/zoom dimming と pool count の同期を固定 source で検証する。 |

#### 達成条件と検証

- `rg -n 'three/webgpu|render/|FloatingOrigin' src/game/vfx/flash-effects.ts` が 0 件。
- render view に `update(dt)`、spawn、寿命 state がなく、game state に THREE/GPU resource がない。
- 既存の FlashEffects 利用者は game の spawn interface を使い続け、render view を参照しない。
- `npm run typecheck`
- `npm run test:game`
- `npm run test:render`

## 見積り

作業量の単位は、途中で typecheck と担当層 test を通して独立 commit にできる境界変更とする。

- 設定 owner: 2 単位（共通 preference 1 + run 内表示 preference 1）
- camera/viewport: 1 単位
- 天体表示の入力境界: 2 単位（基礎値・cloud/point field 1 + 固有 overlay 1）
- 線と表示 controller: 2 単位（基本 line 1 + orbit guide/plan/creative 1）
- entity view source: 2 単位（dynamic 1 + protein 1）
- 残る mixed owner: 2 単位（illumination 1 + flash 1）

したがって、`2 + 1 + 2 + 2 + 2 + 2 = 11` 個の独立 commit 単位を見込む。各単位のファイル数は手順表の行数で、移動元・移動先は 1 変更として数える。最大単位は camera と dynamic で、どちらも共通 contract 1 組に対して全 consumer を同じ commit で更新する必要があるため、さらに分割すると中間 commit が型検査不能になる。

## リスクと落とし穴

| リスク | 影響 | それが露見する場所 |
| --- | --- | --- |
| settings の storage key または normalization を変える | 既存ユーザーの設定が既定値へ戻る | 手順 1・2 の settings test |
| store 全体を Game/HUD/render へ注入してしまう | 新しい mutable global と逆依存を作り、集約しただけで境界が細くならない | 手順 1・2 の constructor/import review |
| theme の selected id と適用済み palette が別々に更新される | DOM と THREE/HUD の色が食い違う | 手順 1 の通知 test と `currentThemePalette` の派生 cache review |
| camera controller と CameraView の sync 順がずれる | projection/picking と表示が 1 frame ずれる | 手順 3 の CameraFrame test、Game.sync の順序 review |
| resize 値を update と sync で別々に読む | pointer 座標と projection の viewport が同一 frame で一致しない | 手順 3 の immutable viewport input review |
| FocusCamera の Earth/Moon reference-plane 判断まで render へ移す | render に天体名と game 操作仕様が侵入する | 手順 3 の `focus-camera.ts` / render camera import review |
| cloud の radius/rotation period の単位を誤る | 雲の移流速度、渦、追跡距離が静かに変わる | 手順 4 の render sampling test |
| point field の表示 group と物理 orbit element を同じ owner に戻す | game→render 逆 import または render の天体名 hardcode が再発する | 手順 4 の import grep、point-field tests |
| generic overlay の cache key が asset/style/半径を区別しない | Earth と Moon で geometry/style が混線する | 手順 5 の overlay test |
| line の sampling を game で再実装する | 表示線と click 判定がずれる | 手順 6・7 の sample query tests |
| `EntityLineManager` から color/style を除く際に semantic role まで render が推測する | render が enemy/player/entity kind を知る | 手順 6 の line declaration review |
| orbit guide model が THREE camera 距離や pixel scale を持つ | game model に表示資源・viewport が残る | 手順 7 の grep と model/view test |
| plan path の軌道 cache まで render へ移す | 編集・impact/apsis 計算の正本が view lifecycle に従属する | 手順 7 の PlanPath/PlanPathView owner review |
| narrow source の名目で既存 Motion/System 全体を intersection 型にする | mutable state への依存が実質残り、変更影響が縮まらない | 手順 8・9 の public interface review |
| model scale や belt count を render と game に複製する | collision と見た目が別々に変わる二重正本になる | 手順 8 の enemy bounds test と constructor wiring review |
| deterministic nozzle noise の seed に frame counter を使う | pause/re-sync/描画回数で見た目が変わる | 手順 8 の同一 displayTime 再 sync test |
| protein semantic schema を丸ごと render へ移す | combat/save/HUD が render に依存する | 手順 9 の game/render test fixture 分離と import grep |
| ProteinRuntime の GPU cache と MotionController の係数 state を同じ class に戻す | update と sync の位相が再結合する | 手順 9 の owner review |
| illumination 用に全 target 値を game で配列化する | 状態非依存の表示計算が game に戻り、frame input が巨大化する | 手順 10 の source/target interface review |
| FlashEffects の lifetime を render 側で dt 更新する | render 回数がゲーム state を進める | 手順 11 の game/render tests |
| 対象外の marker/scale-grid を今回ついでに再設計する | 計画の独立性が崩れ、未監査の表示・pick 回帰が混ざる | 全手順の diff review、特に手順 3・7 |
