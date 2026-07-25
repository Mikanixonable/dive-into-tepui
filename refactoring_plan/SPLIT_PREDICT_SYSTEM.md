# predictSystem と planSystem の分離

かつて mapMode に混在していた責務のうち「将来の軌道予測・未来状態表示」を独立した
predictSystem として切り出し、plan（軌道計画）と疎結合にするための計画。
mapMode の三分割（camera / plan編集 / 軌道予測）のうち、camera と plan編集の分離は
[SPLIT_MAP_MODE.md](SPLIT_MAP_MODE.md) で概ね完了しており、本書は残る「軌道予測」の分離を扱う。

---

## 1. 現状の問題

### 現状のデータモデル
- `Plan`（[plan.ts](../src/game/plan/plan.ts)）が **nodes（正データ）と trajSamples（予測キャッシュ）を同居**させている。
  - node = `{ time, dv }`。dv は「その時刻での相対的な噴射」（プログレード/ノーマル/ラジアル成分）。
  - trajSamples = nodes と**自機のライブ状態**から RK4 で数値積分した予測点列（[predict.ts](../src/physics/predict.ts)）。
    `dirty`/`lastRefreshMs`/`maybeRefresh`/`markDirty` のスロットリングも Plan が抱える。
- 予測の期間調整状態（`predictDurationKey`/`sliderT`/`displayTime`）や太陽回転系変換
  （`toDisplayFrame`/`trajYawRef`）が [PlanDisplay](../src/game/plan/plan-display.ts) に同居。

### 依存関係とその問題
1. **正データと派生キャッシュの混在**（[plan.ts](../src/game/plan/plan.ts)）。trajSamples は軽微な計算では
   求まらない（RK4 積分）が、正データではなく nodes + 現在状態からの導出値。Plan の責務ではない。
2. **単一キャッシュを異なる期間で奪い合う 2 消費者**。
   - マップ表示: [plan-display.ts](../src/game/plan/plan-display.ts) が `predictDurationSec`（day/week/month）で refresh。
   - 戦闘ガイド: [plan-guide.ts](../src/game/plan/plan-guide.ts) が `guideDurationSec`（直近ノードまでの短距離）で refresh。
   これが破綻しないのは `cameraSystem.mapMode` と `planSystem.editMode` が**たまたま同時トグル**され、
   毎フレームどちらか一方しか refresh しないという暗黙の相互排他に依存しているため。両フラグを
   論理的に独立させる（分離の主目的）と、この前提が崩れる。
3. **planGuide が予測に依存**。planGuide が本当に欲しいのは「ノード実行**直後**の OrbitState」
   （目標位置・速度・軌道要素）だけだが、現行の `{ time, dv }` モデルでは未来ノードの実行後状態を
   **自機を未来へ積分して**求めるしかない。唯一の依存点は plan-guide.ts の `plan.maybeRefresh(...)`
   ＋ `plan.sampleAt(node.time)`。
4. **予測が毎フレーム自機ライブ状態から積分し直すことによるドリフト**。噴射中に目標を再計算し続けると
   目標が噴射分だけ先へ逃げて収束しない。[plan-guide.ts](../src/game/plan/plan-guide.ts) の `activeTarget`
   「凍結」ロジックはこのずれを打ち消すための対症療法であり、データモデルの歪みの症状。
5. **相対 dv ゆえの挙動の歪み**。node が相対 dv しか持たないため、自機が計画と無関係な操作をすると
   計画軌道が勝手に追従してずれる（逆に言えば軌道をずらすことで無理やり整合させている）。また自機の
   移動誤差の蓄積に従って、ノードの実行後状態まで一緒にずれてしまう。
6. **責務の分散**。期間調整・displayTime 設定・trajline 生成・座標変換が plan-display / plan-editor /
   plan-system / game.ts に散在している。

---

## 2. 目指すべき設計意図

### 責務分離
- **正データ（plan = corners）とキャッシュ（trajSamples）を分ける。** ただし trajSamples の
  キャッシュ**保存場所は planSystem 側**（plan の隣に置く隣接キャッシュ。plan 型の内部には入れない）。
  予測は player.live にも経過時刻にも依存せず、plan が編集された瞬間にしか変わらない（外部要因での
  リフレッシュが無い）ため、更新タイミングを知る editor がキャッシュを更新する形で問題ない。
- **predictSystem の責務は「計算」と「未来表示」**であり、キャッシュを所有しない:
  1. plan の正データ（曲がり角）から**未来の自機位置を計算する**（compute。ステートレス）。
  2. **sliderT を管理し、それに応じて未来状態を表示する**（TrajLine / plannedPlayer マーカー）。
  3. 将来的に、自機以外の未来位置も sliderT に応じて表示する。
  過去の SPLIT_MAP_MODE のカメラ側残課題「太陽回転系変換を camera へ寄せる」案は、predictSystem という
  責務に気づく前の記述のため撤回する。

### 依存方向
- `Plan` を **passive な leaf**（corners + 隣接 trajSamples キャッシュ）に保つ。
- **plan（editor）が trajSamples を計算するとき predictSystem に問い合わせる**が、保存・更新自体は
  plan 側が行う（更新タイミングを知るのは editor だけ）。predictSystem はキャッシュを所有しない。
- predictSystem の compute は plan の正データ（frozen）+ ephemeris だけを読む（player.live 非依存）。
  表示（syncDisplay）は plan の隣接キャッシュを**引数で受け取る**（plan を import しない）。
- plan-editor は plan（corners を読み書き / キャッシュを picking で読む）と predictSystem（compute 委譲）を使う。
- plan-guide は **plan だけ**を読む（predict 非依存）。
- predictSystem は editor / guide に依存しない（一方向）。

### ノードを自己完結な凍結状態にする
- node の正データを **軌道計画の「曲がり角」における {simTime, 実行後 OrbitState}** とする。
  **`r` も含めて凍結**する — `r` の再計算は predict 依存かつ積分誤差を伴うため、軽微な導出値ではなく
  正データとして持つべき。Δv は導出値（残Δv = 目標速度 − 現在速度、など）で、相対 dv を正データに持たない。
- **編集 UI 上は r と v を独立に操作させない。** 計画軌道（連結した予測軌道）上での Δv 変更だけを許し、
  ノードは常に軌道上に乗る。つまり「データモデルとしては各曲がり角の状態をフルに凍結保存するが、編集
  操作としては連結が保たれるように制限する」。
- **上流ノードを編集したとき、下流ノードは千切れさせない。** 単純に削除するか、変更後の軌道の最も近い点へ
  更新（再スナップ）する（どちらにするかは Step 2 の決定事項）。
- 責務の逆説: **editor は設計時に「player の実座標から連結するよう努力して」plan を作る**が、その結果の
  plan から predict が予測しても、積分誤差レベルの一致は保証しない。**だから逆に随時再計算する必要が
  ない**（frozen な自己完結データを一度描くだけ。繋がらない箇所は正直に不連続として表示する）。
- planGuide は直近ノード 1 個だけを見るので、直近ノードの凍結 OrbitState を直接読めば predict 非依存を
  達成でき、activeTarget 凍結ハックも不要になる。

### predict は player の実 state に依存しない
- 上記の帰結として、**predict（予測軌道・未来位置）は player の実座標に依存しない**。plan は frozen な
  起点アンカー（予定 player の初期状態 = `plannedPlayerStart`）と各曲がり角の凍結状態だけで完結するため、
  「未来の予定 player 位置」は plan だけの純関数として求まる。
- editor は設計・編集時に player の実座標を読んで（連結するよう）plan を作るが、**editor 書き込み後は
  player の実位置と予定 player 位置は完全に無関係**になる（逸脱していても予定位置は動かない）。
- 現状の `ghostLabel`／ghost マーカーは名前が悪い（実座標由来の残像ではない）。この「予定された player の
  未来位置」は **`plannedPlayer`（または `predictedPlayer`）** へ改名する。

### mapMode と editMode の独立
- `cameraSystem.mapMode`（広範囲視点）と `planSystem.editMode`（Δv 編集入力）は本来独立。
  predictSystem の表示（trajline/ghost）は「未来を見たいか」で決まり、どちらのフラグとも
  独立に語れるべき（当面の配線は SPLIT_MAP_MODE 側の整理に従う）。

---

## 3. 理想的な変更後の状態

### データモデル
（後日の型統合により、下記の `{time, state}` 対はすべて 1 個の `OrbitState`(= `{t, r, v}`) に集約された。
`TrajectorySample` は廃止され `OrbitState` に統一。キャッシュの置き場も「Plan 隣接の 1 本」ではなく
`PredictedLine` が arc ごとに持つ形に落ち着いている。以下は当時の設計案として残す。）

```
Plan (planSystem 所有, passive leaf)
  plannedPlayerStart: { time, state: OrbitState }    // frozen な起点アンカー(=予定 player の初期状態)
  nodes: { time: number; postState: OrbitState }[]   // 各曲がり角の実行後絶対状態(r,v とも凍結)
  trajSamplesCache: TrajectorySample[]               // 隣接キャッシュ(正データではない。editor が更新)
      └ corners の 追加/削除/リタイム/Δv編集のメソッド。
      └ 編集は「連結した予測軌道上での Δv 変更」に制限(r,v を独立操作させない)。
        上流編集時、下流ノードは削除 or 最近傍軌道へ再スナップ(千切れさせない)。
      └ キャッシュ更新は editor が predictSystem.compute() を呼んで結果を入れるだけ(dumb storage)。

predictSystem (新設・キャッシュを所有しない)
  compute(plannedPlayerStart, corners, duration, ephemerisParams) → TrajectorySample[]  // ①ステートレス計算
  sliderT / displayTime / resolveDisplayTime                                            // ②未来時刻の管理
  TrajLine(予測折れ線) / plannedPlayer マーカー(旧 ghost) / plannedPlayer ラベル          // ②未来表示
  syncDisplay(cache, sliderT, ...)                    // 表示は plan の隣接キャッシュを引数で受ける
  太陽回転系の表示回転(現在の sunAz)を毎フレーム適用する(サンプル再構築とは分離、下記留意点)
  ── plan(frozen) + ephemeris だけを読む。player.live には依存しない
```

### 依存グラフ
```
  writes corners(設計時に player.live を読み連結)     compute 委譲
  plan-editor ──────────────► Plan(corners+隣接cache) ─────────► predictSystem ──► physics/predict, ephemeris
       │                       ▲    │                     (sliderT, 未来表示を所有)
       │ reads cache(picking)  │    │ reads corners[0].postState
       └───────────────────────┘    └──── plan-guide ──► player.live(誘導対象)

  game.ts(表示): predictSystem.syncDisplay(plan.trajSamplesCache, sliderT, ...)
  ※ predictSystem はキャッシュを所有しない。compute はステートレス、syncDisplay は cache を引数で受ける。
  ※ predictSystem は player.live / editor / guide に依存しない(一方向)。
  ※ player.live を読むのは editor(設計時の連結)と guide(誘導対象)だけ。guide も predict 非依存。
  ※ frameRotating は camera が所有し predictSystem が読む(入力)。
```

### 概念の帰属
| 概念 | 帰属 |
|---|---|
| plannedPlayerStart アンカー + nodes（time + 実行後 OrbitState）とその編集メソッド | **plan**（planSystem 所有） |
| trajSamples キャッシュ（隣接 dumb storage。更新は editor がトリガ） | **plan**（planSystem 所有） |
| 未来自機位置の計算（compute。ステートレス） | **predictSystem ①** |
| sliderT / displayTime / resolveDisplayTime と未来状態表示 | **predictSystem ②** |
| TrajLine（予測折れ線）, plannedPlayer マーカー/ラベル（旧 ghost） | **predictSystem ②** |
| 太陽回転系の表示回転（毎フレーム。toDisplayFrame 相当） | **predictSystem ②** |
| （将来）自機以外の未来位置表示 | **predictSystem ③** |
| mapMarkers への duration+sliderT 供給 | **predictSystem** →（camera 側 mapMarkers へ） |
| クリック配置・ドラッグ・Δv アーム・メニュー・選択・計画パネル・[X]削除・editMode | **plan-editor** |
| NodeGizmo | **plan-editor** |
| 直近ノードの噴射ガイド・達成判定・ノード消化・plannedLine | **plan-guide**（plan のみ依存） |
| frameRotating（太陽回転系トグル状態） | **camera**（predictSystem が読む） |

### 留意点: キャッシュ更新と太陽回転系表示の分離（検証で判明）
- 「trajSamples を編集時のみ更新」は **ECI サンプル列については成立**する（player.live にも経過時刻にも
  依存しない）。→ だから plan 隣接キャッシュに置ける。
- ただし太陽回転系表示（`toDisplayFrame`/`trajYawRef`）は現状 **TrajLine メッシュに回転を焼き込み**、
  refresh 時に `trajYawRef` を固定している。編集時のみ refresh にすると、time warp 中など「編集しないが
  時刻は進む」場面で太陽追従が凍る。
- → **ECI サンプル列の更新（編集時のみ）と、太陽方向への表示回転（毎フレーム）を分離**する。全回転が
  Y 軸まわりで合成可能なので、per-sample 部 `−sunAz(t_sample)` をメッシュに焼き（編集時のみ再構築）、
  基準回転 `現在の sunAz` を毎フレームのグループ回転で与えれば、編集時のみのメッシュ再構築と毎フレームの
  太陽追従を両立できる。picking も同じ毎フレーム回転を通せば描画と一致する。

### physics/predict.ts
- `PlannedNode` を `{ time, dv }` から `{ time, postState: OrbitState }` へ。
- `predictTrajectory` は **plannedPlayerStart アンカーから積分を開始**し、各ノード時刻で**状態を
  postState にリセット**して継続する（現行の「player.live から積分し dv を加算」から「frozen アンカー
  から積分し状態を差し替え」へ）。これにより予測は player.live に依存せず、各アークが独立に積分されて
  繋がらない箇所は不連続として正直に現れる。
- `dvToWorld` は残置（Δv アームのドラッグ量 pro/nrm/rad → world を postState.v へ加える変換に使う）。

### planGuide
- 直近ノードの `postState` を直接読む。`maybeRefresh` / `sampleAt` / `activeTarget` 凍結ロジックを撤去。
- 達成判定 = 自機軌道要素が `elementsFromState(postState)` に十分近いか。消化で nodes[0] を落とし、
  次ノードが自動的にアクティブになる。
- これにより結節点②（キャッシュの二重消費）も自然消滅する（trajSamples の消費者がマップ表示側のみになる）。

---

## 4. 変更の手順と範囲

### Step 1: predictSystem を切り出す（純構造リファクタ・挙動不変）
node モデルは `{ time, dv }` のまま、責務の移設だけ行う。
- 新規 predictSystem を作り、[PlanDisplay](../src/game/plan/plan-display.ts) を解体して移設:
  **compute**（`predictTrajectory` を包む計算）、`predictDurationKey/Sec`、`sliderT`、
  `displayTime`/`resolveDisplayTime`、`ghostLabel`＋ghost マーカー、`TrajLine` 所有、
  `toDisplayFrame`/`trajYawRef`。**キャッシュ自体は持たせない**（下記のとおり plan 側へ）。
- `Plan`（[Plan](../src/game/plan/plan.ts)）は corners + **隣接 trajSamples キャッシュ**を持つ。キャッシュ更新は
  editor が `predictSystem.compute()` を呼んで結果を入れる（`maybeRefresh`/`markDirty` のスロットリングは
  editor 側の更新トリガへ寄せる）。`sampleAt` はキャッシュに対する純関数として残す。
- `plan-editor` はピッキング/リタイムで **plan の隣接キャッシュ**を読む。
- `game.ts`: `resolveDisplayTime` を predictSystem から取得。[game.ts](../src/game/game.ts) の `updateDisplay`
  を predictSystem（`syncDisplay(plan.cache, ...)` で line/ghost/mapMarkers 供給）と editor（gizmo）へ分割。
- この段階では planGuide は暫定的に plan の隣接キャッシュ経由で実行後状態を得る（predict 依存は残す）。
- 範囲: `plan/plan.ts`, `plan/plan-display.ts`(解体), `plan/plan-editor.ts`, `plan/plan-system.ts`,
  `plan/plan-guide.ts`, `plan/trajline.ts`, `game.ts`, 新 predictSystem。

- predict-system.tsをpredictフォルダに移動しました。この後も、planとpredictの分離はフォルダ単位で行い、predict側に属するものはpredictフォルダに移動します。

### Step 2: ノードデータモデル変更（planGuide 脱 predict・凍結ハック除去・predict 脱 player.live）
- `physics/predict.ts`: `PlannedNode` を `{ time, postState }` へ。`predictTrajectory` を
  plannedPlayerStart アンカー起点＋各ノードでリセット積分へ（player.live 非依存化）。
- `Plan`: plannedPlayerStart アンカー + node `{ time, postState }` を保持。配置は「クリック点のサンプル
  状態を凍結して格納」、Δv アーム/キー編集は「連結軌道上の Δv 変更として postState.v をドラッグ量ぶん
  変更」（r,v を独立操作させない）。上流編集時の下流ノードは削除 or 最近傍再スナップ（要決定）。
  表示用 Δv 量は editor が predict で導出（editor は predict 依存可）。
- アンカーの (再)凍結タイミング（editMode open/close 等）を決める。editor は設計時のみ player.live を読む。
- `plan-guide.ts`: 直近ノードの postState を直接読む。`activeTarget` 凍結・`maybeRefresh`・`sampleAt` を撤去。
- ghost/`ghostLabel` を `plannedPlayer` へ改名。
- 結果: trajSamples の消費者がマップ表示側のみになり結節点②が消滅。planGuide は plan のみ依存、
  predictSystem は player.live 非依存になる。
- 範囲: `physics/predict.ts`, `physics/predict` のテスト、`plan/plan.ts`, `plan/plan-editor.ts`,
  `plan/plan-guide.ts`, predictSystem。

### Step 3-1: 固定計画
- 現状の「相対 dv ゆえ自機操作で計画軌道が自動追従する」挙動からの大幅変更。
- 編集時点で計画軌道を固定し、編集モード外では**自機がthrottleや積分積分誤差などによって計画から逸脱しても計画軌道は動かない**ようにする

### Step 3-2: 逸脱警告 UX（別マイルストーン・ゲーム仕様変更）
- 計画軌道を固定し、自機がノードと無関係に計画から逸脱（勝手にthrustした、あるいは曲がり角でthrustしなかった、あるいは蓄積誤差）した場合、警告し「軌道へ戻る／計画破棄」を問う。


### クリンナップ
計画書におけるStep3-2は将来的なtodoに残します。これは単純な追加機能であり、リファクタリングとは無関係だからです。

最後に計画書を再読したうえでコードを検査して、当初の達成目標であったであったplan編集と軌道予測の疎結合な分離が、大局的な意図通りにできていることを確認してください。（これは動作の検証は不要です。コードの構造として、参照、依存関係を確認してください）

検査の結果、計画外の依存関係が残っていた場合、それが消し忘れや移動し忘れによる簡単に解消できるものであれば解消し、本質的に解消するのが厄介なものであった場合にはドキュメントに追記してください。この判断で迷った場合は私に聞いてください。