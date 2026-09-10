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
18. ビュー種別の語彙は `src/render/view-mode.ts` の `ViewMode`(`'combat' | 'map'`)。`CameraFrame` がこれを運ぶため render 側が持つ。`RenderStyle` と同じく、語彙は render、選ぶのは game/hud。
19. そのフレームのカメラは `src/render/camera/camera-frame.ts` の `CameraFrame`(`camera` / `position` / `viewpoint` / `viewport` / `mode` / `zoomed` / `floatingOrigin` / `project` / `scale` / `radialScale`)。`CameraView.sync(viewpoint, clipFovDeg, clipDistance, viewport, mode, zoomed, focusVelocity)` が1回で確定する。`FloatingOrigin` は `src/render/camera/floating-origin.ts`。
20. ビューポートは `src/render/viewport.ts` の `Viewport`。`browserViewport()` を**フレームの先頭で1度だけ**読み、同じ値を renderer・`Game.update`・`Game.sync` へ配る。`window` の寸法を読むのはこの1モジュールだけ。
21. 視点とビューポートを束縛した投影は `math/projection.ts` の `screenProjection(view, width, height)`。game の picking と render の `CameraFrame` が同じ純関数を使う。
22. 近遠クリップ面は照準ズーム中も軌道視点の画角と注視距離が決める(現行挙動の保存)。`camera-view.ts` に TODO として残してある。
23. 点1つぶんの軌道要素と位置評価は `src/physics/point-orbit.ts`(`PointElements` / `pointPositionAt`)。群ごとの描画半径・色という表示契約は `src/render/celestial/point-field-view.ts`(`PointFieldGroup` / `PointField`)。生成は `game/celestial/solar-system/point-field.ts` に残る。
24. 天体固定系を THREE 行列へ写す `writeBodyFromWorld` は `src/render/celestial/body-frame.ts`。
25. `render/cloud/` は天体の半径と自転周期を、`GeneratedCloudField` / `WeatherModel` / `AirMassField` は構築時、それ以外は呼び出し時の引数として受ける。まとめ型は作らない。注入元は `earth-system.ts`(`R_EARTH` と `SIDEREAL_DAY`。`EARTH.radius` は赤道半径なので雲には使わない)。
26. 地表へ貼る線は `src/render/celestial/line-overlay.ts` の `LineOverlay.of(lines)`。`lines` は「緯度経度の折れ線」か「単位球面上の閉ループ」の union で、geometry の共有キャッシュは頂点データの配列と kind の組を鍵にする。どのアセットをどの天体へ割り当てるかは `earth-system.ts` が決める。
27. 軌道線の描画資源は `src/render/lines/{ellipse-line,target-relative-line,trajectory-line}.ts`。公開面は `line` / `sync` / `samplePoints` / `dispose` だけ。
28. **`LineStyle` の組み立てと配色の解決は `game/` に残す。** CODING-RULE 2.2 が「軌道線・軌跡線を含む表示状態は View の外に正本を置き、毎フレーム `sync` の入力として渡す」と定めており、敵ごとの軌道線色は game 側の識別色であるため。当初の達成条件「`LineStyle` を `src/game/lines` から 0 件にする」はこの規約と衝突するので採らない。以降の手順でも同じ扱いにする(orbit guide の `styleFor` も game に残す)。
29. orbit guide は `OrbitGuideModel`(`game/celestial/orbit-guide/orbit-guide-model.ts`)と `OrbitGuideView`(`render/celestial/orbit-guide/orbit-guide-view.ts`)。ゼロ速度曲線も同じ形。model の宣言は形が変わるまで同じオブジェクト参照を返し、`GuideCurve.samplePoints` は `(shape, origin, count)` を鍵にする。表示済みの点列は `CelestialSystem.orbitGuideSamples(count)` から引く。
30. plan は `PlanPathView` / `PlanGizmo3D`(`render/plan/`)。`PlanPath` は弧の計算と、そのフレームに描く弧の宣言(`PlanArcLine`)だけを持つ。配置プレビューは `ObjectPlacementPreviewView`(`render/creative/`)。
31. `game/plan/` と `game/creative/` に残る `three/webgpu` は `THREE.Scene` の型 import だけ。`scene` を渡すだけの引数で、消すには `game.ts` の scene 配布の規約を変える必要がある。
32. 1体ぶんの表示入力は `src/render/dynamic/dynamic-view.ts` の `DynamicRenderSource`(`id` / `name` / `visible` / `alive` / `stateAt(t)` / `attitude` / `thermal`)。種別ごとの面はこれを extends し、`DynamicView<S>` が受ける。組み立ては `DynamicEntity.renderSource(context, visible, active, orbitReference)` の1箇所。
33. **線の宣言は `DynamicRenderSource` に載せない。** 線の見た目は `targeter.aliveTarget` が決まったあとでないと確定せず、それは `dynamicSystem.sync` より後の位相にある。`EntityLineManager` が `view.syncLines(...)` を別の pass で渡す現行の形を維持する。
34. 噴射・RCS の揺らぎの種は `src/render/dynamic/player/plume-noise.ts` の `plumeNoiseSeed(id, displayTime, nozzleIndex)`。フレーム番号や sync の回数は種に入れない。

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
