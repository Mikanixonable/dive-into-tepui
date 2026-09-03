# Dive into Tepui 計画的リファクタリング監査・実行計画

> 状態: 実行前の監査済みマスターメモ
> 監査日: 2026-08-05 JST（実行確認は日付境界を跨いで 2026-08-06）
> 対象コミット: `54a0ef24bfcc77688b7c014f178c45367f07524b` (`2026-08-02 merge`)
> 対象: `src/`, `tests/`, `public/`, `docs/`, `tools/`, `.github/`, 主要開発文書
> 作成目的: 今後 Sol が判断し、Luna が実装する際に、この文書だけで背景・順序・受入条件を読めるようにする
> 重要: `memos/mikanixonable/dev.md` は人間専用文書であり、本監査でも変更していない。今後もエージェントは編集しないこと。

## 0. この文書の位置づけ

この文書は、現行コードに対する再検証済みのリファクタリング・バックログと意思決定案である。古いレビューを単純結合したものではない。`memos/mikanixonable/CODE_REVIEW_2026-07-31.md`、`REFACTORING_REPORT.md`、`MEMORY_LEAK.md`、`軽量化計画.md`、`memos/hedalu244/*todo` には、既に解消された問題、旧パス、現在と異なる前提が混在している。今後の実行順については本書を優先し、古い文書は経緯の参照資料として扱う。

ただし、本書はゲームデザインの正本ではない。仕様上の価値判断は人間の `dev.md` と、承認後に更新する `DEVELOP/SPEC.md` に従う。本書が行うのは、現状、選択肢、トレードオフ、推奨案、受入条件を揃え、承認者が「調べ直す」必要をなくすことである。

優先度は次の意味で使う。

- **P0 / Release blocker**: 現在の起動・公開物が壊れている。ほかの作業より先に修正する。
- **P1 / Correctness & lifecycle**: 状態破壊、リーク、時間不整合、機能上の行き止まり。次の機能追加前に修正する。
- **P2 / Scalability & quality**: 性能、操作性、テスト容易性、拡張性を明確に制限する。
- **P3 / Context & hygiene**: 直ちにゲームを壊さないが、人間・AIの判断コストと誤修正率を上げる。
- 工数は概算で **S**（半日以内）、**M**（1〜3日）、**L**（3〜7日）、**XL**（設計を含む複数週）とする。

---

## 1. 結論

現状は「全面的に作り直すべきコード」ではない。浮動原点、純粋な軌道・姿勢計算、`OrbitEntity`、`update → sync → render` の分離、物理テストは良い土台である。本監査では、重複を統合したうえで **改善項目89件** と、価値判断を要する **意思決定16件** を整理した。一方、現在のブランチは次の2件により、リファクタリング以前に出荷不能である。

1. `src/game/camera/camera-system.ts:153-154` の未 import 識別子 `C` により、**初回フレームで `ReferenceError: C is not defined` が発生し、ゲームループが停止する**。
2. `docs/index.html:2-6` に未解決の Git conflict marker がコミットされ、異なる2本の `main.*.js` を読み込む。ローカル配信と headless Chrome で、**両bundleが実際に取得・実行される**ことを確認した。

したがって推奨順は次である。

1. **公開版を正常化する**: P0を直し、起動スモークと競合マーカー検査を追加する。
2. **安全網を先に作る**: PR CI、物理テスト、ブラウザ起動、リソース破棄、時刻不変条件のテストを入れる。
3. **Creativeと高ワープの正しさを直す**: ノード時刻、入力検証、active ship、ライフサイクル、複数船の意味論を揃える。
4. **初回ロードとGPU負荷を落とす**: 品質tier、テクスチャ、地球メッシュ、DPR、フォント、ローディングを先に行い、その後に弾のinstancingへ進む。
5. **境界を段階的に整理する**: entity ID、controllerとshipの分離、domain event、session dispose、生成文書へ移行する。

**ECSへの全面移行、全Vec3の可変化、物理worker化、フレームワーク導入は現時点の推奨ではない。** いずれも局所的な問題を解かずに移行面積だけを増やす。まず計測、ID、時計、ライフサイクル、描画batchという前提を整える。

---

## 2. 調査方法と再現結果

### 2.1 読んだ一次資料

- `DEVELOP/CALLSTACK.md`: フレーム内の呼出順
- `DEVELOP/OWNERSHIP.md`: 所有権と状態の正本
- `DEVELOP/SPEC.md`: 意図する挙動
- `CLAUDE.md`, `AGENTS.md`, `README.md`
- `src/main.ts`, `src/game/game.ts`, simulation、Player、Stage、Creative、Planner、Camera、HUD、Input、Audio、Render、Physicsの主要実装
- Webpack、TypeScript、package scripts、GitHub Actions、生成ツール、公開済み `docs/`
- 既存のレビュー・todo一式

### 2.2 実行した検証

| 検証 | 結果 | 解釈 |
| --- | --- | --- |
| `npm run typecheck` | **失敗**。TS2304が2件、`camera-system.ts:153-154` | 現HEADは型安全ゲートを通らない |
| `npm run test:physics` | **116 / 116 pass** | 純粋物理関数の回帰基盤は有効 |
| `npm run build` | bundle自体は生成可能 | `esbuild-loader`は型検査しないため、build成功は起動可能を意味しない |
| `npm run dev` | コンパイル成功。補助asset 39.5 MiB、development JS 4.56 MiB | 配信量と型検査がbuildから独立している |
| headless Chrome / 現ソース | `Multiple instances of Three.js` 警告の後、`ReferenceError: C is not defined` でloop停止 | P0-01とThree混在を実行確認 |
| `docs/`を静的配信 | `main.e7a...js` と `main.d359...js` を両方GETし、両方からconsole出力 | P0-02は「可能性」でなく現実の二重ロード |
| emitted import graph | runtime SCC 0件 | ソース上の型import循環候補はあるが、現状の実行時循環ではない |
| `npm audit --omit=dev` | high以上0件 | 既知runtime依存脆弱性は今回の主問題ではない |

### 2.3 規模の基準値

- `src/**/*.ts`: 約16,300行。
- 大きいファイル: `render/ships.ts` 605行、`plan/plan-editor.ts` 515行、`audio/sfx.ts` 505行、`game/game.ts` 442行、`hud/dom.ts` 424行、`game/const.ts` 379行。
- `src/assets`: 約38 MiB。
- 現在の `docs/`: 約45.6 MB。うち画像約33.1 MB、font約8.3 MB、二重JS約4.19 MB。
- 追跡中の `src/assets` と `docs` の合計: 約82 MB。
- 主要4テクスチャはすべて8192×4096。JPEG転送量は合計約31.6 MiB。RGBA8展開とmipmapを仮定すると、GPU常駐量は上限概算で約680 MiB級になり得る。
- 地球 `SphereGeometry(1024, 768)` は約78.8万頂点、約157万三角形、主要attributeとindexだけで概算44 MiB級。
- 弾の実上限は `MAX_BULLETS * 3 = 1,200`。自機弾は本体とhaloの2 Meshで、個別Object3Dとして描画される。
- 最高ワープは×131,072。`dt`上限0.1秒の1フレームで最大13,107.2 sim秒、20秒刻みなら656 substepになる。

---

## 3. 先に守るべき良い設計

次は問題ではなく、リファクタリング中に壊してはならない不変条件である。

1. **ECI / SI単位の論理状態と浮動原点**。絶対座標をGPUへ直接渡さない。
2. **`physics/`のplain objectと純粋関数**。DOM/Threeを持ち込まない。
3. **`OrbitEntity`のstate/history/predictionの同じ抽象**。現在と未来を別実装に増殖させない。
4. **RK4 stageごとの環境加速度評価**と、Sun/Moonの差分第三体加速度。
5. **`update → sync → render` の意図**。違反箇所を直すのであって、分離自体を捨てない。
6. **WebGPUの制約を考慮した固定buffer・手動loop close**。live objectのgeometry/attributeを無闇に差し替えない。
7. **物理テスト116件**。新しいゲーム層テストを足すのであり、既存テストを別frameworkへ移すことを先行させない。
8. **不変Vec3を可変scratchへ一括変換しない**。以前の計測と設計判断を覆すには新しいprofileが必要。
9. **N-body workerを削除も本採用もしない**。cislunar設計の入力として隔離し、現在のLEO性能問題の万能薬にしない。

監査中に棄却した過剰指摘も明記する。

- 月近傍の船が「地球中心重力だけ」で積分される、という指摘は不正確。`envAccel` は月・太陽の差分第三体加速度を含み、月中心初期状態をECIへ変換した後も月重力を受ける。
- halo/Lissajousが厳密に閉じないのは、現在の一次近似初期状態と実環境モデルの既知仕様であり、即バグとは扱わない。UIで近似・漂流を説明する課題は残る。
- `WebGPURenderer`はthree r169内部にWebGL2 fallbackを持つ。「fallbackをゼロから実装すべき」ではなく、現在のfallbackを検出・試験・正しく案内すべきである。
- ソースimportを単純解析すると8ノード循環が出るが、TypeScript出力後のruntime SCCは0件。`import type`整理は必要だが、runtime cycle除去プロジェクトとして扱わない。

---

## 4. P0: 直ちに直す問題

### P0-01 初回フレームでゲームループが停止する

- **根拠**: `src/game/camera/camera-system.ts:153-154` が `C.CAM_KEY_PAN_RATE` を参照するが、`../const` をimportしていない。
- **実害**: `CameraSystem.update()` はキー入力の有無に関係なく式を評価する。headless Chromeで `Fatal error in animation loop ... ReferenceError: C is not defined` を再現した。
- **原因の背景**: production buildはesbuildによるtranspileのみで、型検査を行わない。したがって「build成功、実行失敗」が成立する。
- **修正**: `import * as C from '../const';` を追加する。同時に `build:bundle` と `check` を分け、公開buildは `check` を前提にする。
- **受入条件**:
  - `npm run typecheck` が成功。
  - headless Chromeで最低60 frame更新し、console errorが0件。
  - テストで `simulator.simTime` またはframe counterが初期値から進む。
- **工数**: S。判断不要。

### P0-02 公開HTMLが未解決conflictを含み、2アプリを同時ロードする

- **根拠**: `docs/index.html:2-6` に `<<<<<<< HEAD`, `=======`, `>>>>>>> origin/workspace4`。`main.e7a...js` と `main.d359...js` が両方残る。
- **実害**: 静的配信ログで2本ともGETされ、Chrome consoleでも両方のbundle由来の出力を確認した。canvas、HUD、document listener、GPU/Audio資源が二重生成され得る。
- **原因の背景**: GitHub Pagesのbranch publishing sourceでは公開元をbranch rootまたは`/docs`から選ぶため、webpackの出力先を`docs/`にした判断自体は合理的である。問題は `.github/workflows/build.yml` が生成済み `docs/` をmainへbot pushし、並行変更と競合解決を同じbranchへ持ち込む運用にある。現在branchで `git log --format='%H' -- docs` は114件、そのうちsubjectが `build: docs` で始まるcommitは23件ある。
- **修正**:
  1. 短期: conflictを解消し、clean buildの単一asset setで公開し直す。
  2. 恒久候補: repositoryのPages sourceをGitHub Actionsへ変更できるならartifact deployへ移し、`docs/`をmainの正本にしない。webpackの一時出力先は`docs/`のままでもよく、「出力先」と「Git追跡・公開方式」を分けて考える。詳細はD-01。
  3. CIにconflict marker検査、`git diff --check`、HTML内entry script本数=1の検査を追加する。
- **受入条件**:
  - repo全体のconflict marker検査が0件。ただし履歴資料中の例示は明示除外可。
  - 公開 `index.html` のentry scriptが1本。
  - headless smokeでcanvas/HUD root/Game sessionが各1個。
  - deploy jobは検証job成功後のみ走る。
- **工数**: 短期S、恒久M。デプロイ方針はD-01で承認する。

### P0-03 実行中の致命例外が利用者には無言のfreezeに見える

- **根拠**: `src/main.ts:77-94`。rAF内catchはconsoleへ出して次frameを予約しない。初期化失敗UIとは別経路。
- **実害**: P0-01発生時もHUDとcanvasが残り、一般利用者は停止理由も復旧方法も分からない。
- **修正**: 初期化とloopの両方が使う `FatalErrorOverlay` を作り、エラー概要、reload、対応backendを表示する。Phase -1では復旧を `location.reload()` に限定する。session全体のdisposeがない状態で同一page内の `main()` を再実行する「再試行」は、listener/GPU/Audioを二重化するため実装しない。外部監視を導入する場合はこの境界から一度だけ送信する。
- **受入条件**: 人工的にupdateをthrowさせ、画面内エラー、reload button、重複報告なし、同一page内でsessionを再生成しないことをbrowser testで確認。
- **工数**: S〜M。判断不要。

---

## 5. P1: 正しさ、時間、ライフサイクル

### C-01 `three` と `three/webgpu` のruntime混在

- **根拠**: `src/game/floating-origin.ts:1`, `src/render/glow-texture.ts:1` だけが `three`、他のruntimeは `three/webgpu`。headless Chromeで `WARNING: Multiple instances of Three.js being imported.` を再現。
- **影響**: 実測できたのはduplicate-instance警告である。bundle重複、`instanceof`やclass registryの不一致、WebGPU/TSLオブジェクト境界の不具合は起き得るリスクであり、個別には未実測。プロジェクト自身の規約にも反する。
- **修正**: runtime importを `three/webgpu` へ統一する。Nodeだけで動くasset exporterの `three` は別境界として許可する。CIにimport boundary検査を追加。
- **受入条件**: Chrome警告0、WebGPUとWebGL2 fallbackの両smoke成功。
- **工数**: S。

### C-02 Creative `followPlan` が船の時刻を過去へ巻き戻す

- **根拠**: `CreativeStage.update()` は物理stepより前に `dropNodesBefore(simTime)` を呼び、返された `node.t` のstateを代入する。高ワープで前frameにnodeを跨いだ場合、次frameに過去node stateへresetされる。
- **影響**: `Simulator.simTime` と `ship.state.t` の差が恒久化する。history、prediction、命中、表示補間、次node判定が別の時刻を生きる。
- **推奨修正**: simulationに「次の時間境界」を渡し、node時刻ぴったりでsubstepを分割する。node stateへ交換後、残り時間を積分する。D-04参照。
- **代案**: node stateを現在のsimTimeまで再積分してから適用する。実装は小さいが、複数node、衝突、他eventの順序が曖昧なまま残るため非推奨。
- **暫定ガード**: 本修正まで `followPlan` 実行中はwarpを×1へ戻し、次nodeをframe内に跨ぐ前にsimulationを停止して通知する。境界ぴったりで停止できない実装なら、`followPlan` 自体を一時無効化する。×1へ落とすだけでは時刻不一致を解消しない。
- **受入条件**:
  - node直前から×1、×4、最大warpで跨ぐparameterized test。
  - 全生存entityについて `abs(state.t - simulator.simTime) < epsilon`。
  - 同frame内の複数nodeが時刻順に一度だけ適用される。
- **工数**: L。判断はD-04。

### C-03 Creative配置フォームがNaN・不正軌道を無検証で受け入れる

- **根拠**: `ship-placer-panel.ts:251-277` が全値を `Number(...)` で渡し、`creative-stage.ts:92-120` がそのまま状態化する。
- **影響**: 空欄、現フォームでは定義できない `e >= 1`、非正値周期、地表内近地点、`Ap < Pe`、過大振幅で非有限stateを作り、描画全体が暗転し得る。`NanWatchdog`は汚染後の検出であって入力境界ではない。
- **修正**: DOM非依存の `parseCreativeShipForm` / `validateCreativeOrbitInput` を作り、Result型でfield errorを返す。有限性、範囲、主天体半径、現在の楕円軌道フォームが表現できる条件、振幅上限を検証し、成功時のみentityを生成する。物理層全体から双曲線を禁止する意味ではない。入力範囲の判断はD-15参照。
- **受入条件**: 境界値・空欄・NaN・Infinity・`e=1`・逆apsisをunit test。失敗時entity数とscene child数が変わらない。
- **工数**: M。

### C-04 Creative開始時の「船なし」仕様と実装が矛盾する

- **根拠**: `DEVELOP/SPEC.md:324` と `CLAUDE.md:260` は船がまだないためmap開始・M無効とする。一方 `Game` はmode判定前の `game.ts:108-110` で常にdefault `Player` を生成・登録する。
- **影響**: Creativeは実際には隠れたstarter shipを持ち、8隻上限を1枠消費し、仕様、UI、camera、active player前提が食い違う。
- **修正案**: D-02で選ぶ。現状の「hidden sentinel」は採用しない。
- **受入条件**: 起動直後のroster、M可否、配置上限、最初のactivate挙動が仕様テストと一致。
- **工数**: target案はL。

### C-05 CreativeでPlayerを削除するとPlayer固有のscene/GPU資源が残る

- **根拠**: `DynamicSystem.removePlayer()` は `player.dispose()` を呼ぶが、Playerはdisposeをoverrideしない。継承元Shipは本体mesh/materialだけを破棄する。Playerが直接sceneへ追加する `orbitLine`、`ThrustEffects` 2枚、全RCS puff、`ReentryEffects` 2枚は残る。各effect classにもdisposeがない。
- **影響**: 配置・削除を繰り返すとscene child、geometry、material、描画物が増え続ける。孤立した軌道線も残る。
- **修正**: `Player.dispose()` をidempotentにし、全owned resourceをremove/disposeする。各effectにscene所有を明示したdisposeを追加。共通 `Disposable` とresource ownership規則を定める。
- **受入条件**: fake scene/unit testではowned object、scene child、marker、DOM listener数が20回の配置・削除後にbaselineへ戻り、二重disposeでthrowしない。20回は線形増加を短時間で露出させる最低反復とし、browser負荷試験は100回でheap/GPU memoryの単調増加がないことを見る。three WebGPU r169に安定した公開GPU resource counterがないため、取得方法を確定していない `renderer resource数` をhard gateにはしない。
- **工数**: M。

### C-06 喪失したCreative船が永久に8隻上限を消費する

- **根拠**: `DynamicSystem.cleanup()` はplayersをpruneしない。仕様どおり死んだ船はmap pickableから外れるため、利用者は選択も削除もできない。
- **影響**: 喪失を繰り返すと配置枠が回収不能になり、Creative sessionがsoft-lockする。
- **修正**: roster UIからwreckを削除できるようにするか、非activeのlost playerを演出終了後に自動disposeする。active corpseをcamera基準として残す場合も、明示的なretention policyを持つ。
- **受入条件**: 8隻喪失後も規定の方法で枠を回収し、再配置できる。
- **工数**: M。D-03と合わせる。

### C-07 active ship喪失後、戦闘viewから生存船へ戻れない

- **根拠**: `Game.handleInput()` は `canToggleView = this.player.alive`。active shipがcombat viewで死ぬとMが無効になり、map上で別船をactivateできない。
- **修正**: Creativeではactive ship喪失時にoverviewへ強制移行し、生存船rosterを提示する。生存船が1隻なら自動切替も選択肢だが、cameraが突然飛ぶため明示選択を推奨。
- **受入条件**: combat/mapの両方でactive shipを喪失するE2Eから、必ず生存船選択または新規配置へ到達できる。
- **工数**: M。

### C-08 表示名がentity IDを兼ね、衝突できる

- **根拠**: `findPlayer(name)`, `ObjectPickable.id = ship.name`, marker key、camera focus、NavTargetが文字列名を使う。フォームは重複名、敵名、`earth`, `moon`, `sun`, Lagrange IDを拒否しない。
- **影響**: activate/delete/focus/targetが先に見つかった別entityへ作用する。名称変更、保存、replay、multiplayerを阻害する。
- **修正**: session内で決定的なopaque `EntityId`（例 `ship:17`）を発行し、`displayName`と分離する。random UUIDよりseed/replayに向く。D-05参照。
- **受入条件**: 同名2隻を独立に選択・削除・target可能。予約名も表示名としては許可できる。
- **工数**: L。

### C-09 active選択が船内simulationを変え、切替前の操縦commandが残る

- **根拠**: 全Playerは軌道・姿勢積分されるが、`Player.behave()` と `player.thermal.updateThermal()` はactive 1隻だけ。belt、radiator、power、HP回復、日照設定、熱が選択状態で止まる。
- **追加の致命的挙動**: `Game.setActivePlayer()` は参照を差し替えるだけで、旧active船の `thrust`、`torque`、continuous firing state等の一時commandをclearしない。推進・回転中に別船へ切り替えると、旧船は最後のcommandを保持したままSimulatorで積分され続け得る。
- **影響**: 同じ世界の同型船がactiveか否かで別の物理法則になり、切替時に熱・電力・展開状態が不連続になる。さらに旧船が無操作で加速・回転し続ける。
- **修正**: `Spacecraft.updatePassive(clocks)` を全船に、`PlayerController.applyInput()` をactiveだけに適用する。controller detach時は同一frame内に旧船のtransient commandをすべてclearする。D-03/D-04参照。
- **受入条件**: active切替の有無で、入力を受けない船のpassive stateが同じになるdeterministic test。推進・回転・発射command中に切り替えても、旧船のcommand加速度/torqueが即座に0となり、選択順に依存しない。
- **工数**: L〜XL。

### C-10 複数Player時のRCS音が配列末尾に上書きされる

- **根拠**: `Game.sync()` が全Playerの `RcsEffects.sync()` を呼び、各instanceが共有Sfxへ `setRcs(rotating)` を書く。最後の非回転船がactive船の音をoffにできる。
- **修正**: listener/active shipだけがcontinuous ship audioを所有するか、全sourceをAudioMixerへ集約して最後に一度反映する。
- **受入条件**: 2隻以上で配列順を変えてもactive shipのRCS音が同じ。
- **工数**: S〜M。

### C-11 projectileが発射元entityを持たない

- **根拠**: `Bullet.shooter` は `'player' | 'enemy'` だけ。normal弾のself-hit猶予は現在active Playerにしか適用できず、enemy plasmaは非active Playerを標的にしない。active切替後も「誰の弾か」を復元できない。
- **影響**: Creativeの同士討ち、複数船、faction、friendly fire、score attributionを正しく実装できない。
- **修正**: `sourceEntityId`, `faction`, `collisionLayer/mask` を導入し、hit policyをデータで定義する。
- **受入条件**: shooter自身、別Player、敵、debrisの組合せtable test。active切替で結果が変わらない。
- **工数**: L。C-08後。

### C-12 高速接触のdamageがactive Player対Enemyだけ

- **根拠**: `game.ts:275-283` callbackが `a === this.player` / `b === this.player` の場合だけdamageを与える。非active Player、Player同士、Enemy同士はimpulseだけ。
- **修正**: collision responseから `CollisionEvent` を出し、interaction policyが当事者型/factionごとにdamageを決める。
- **受入条件**: collision pair matrix test。配列順とactive選択に非依存。
- **工数**: M〜L。

### C-13 高ワープでは寿命・再突入判定がframe末まで遅れる

- **根拠**: Simulatorは最大656 substepを回すが、`DynamicSystem.cleanup()` は全substep後に一度。弾240秒、薬莢1800秒、距離、再突入を途中判定しない。
- **影響**: 最大warpの1frame内で寿命を1万秒以上超えた弾が飛び続け、命中候補にも残る。死ぬべきentityが残りのsubstepを積分される。
- **修正**: 既知の寿命境界は検査後ではなく越境前に `subDt = min(remaining, maxDt, nextLifetime - now, ...)` でstepを切る。距離・再突入のように解析的な境界時刻が出ない条件は、保守的なstep上限またはcrossingをbracketして短く再積分する。境界到達後にallocation-freeなlifecycle判定で `alive=false` とし、残りstep/hitから除外する。scene remove/disposeとarray compactionはframe末にまとめる。D-04の同時刻順序に従う。
- **受入条件**: max warpで弾がborn+240秒以後のsegmentに参加しない。dispose回数は1回。
- **工数**: M。

### C-14 再突入域とその手前でも20秒stepを許す

- **根拠**: `SUBSTEP_MAX_DT=20` は高度・密度・降下速度に依存しない。密度scale heightを約1秒で横断する局面がある。
- **影響**: drag、Sutton–Graves heating、動圧peak、喪失条件を飛び越え、ゲームの主要な物理表現がwarp依存になる。
- **修正**: 現在高度だけを見るのではなく、下降速度から120km境界の予測crossingをstep境界へ入れるか、十分上空から1 stepの高度変化量を制限する。危険域では高度/密度/速度に応じた0.25〜1秒上限を初期候補とし、warpも自動低下してUIへ通知する。playerだけでなくdrag/reentry対象の全entityへ同じ安全条件を適用する。
- **受入条件**: 同じ再突入初期状態をwarp別に走らせ、peak q/tempとloss timeが許容誤差内。
- **工数**: L。D-04。

### C-15 姿勢は最大0.48秒しか進まないのに軌道は数時間進む

- **根拠**: `stepAttitude()` は `min(dt, 0.04 * 12)`。playerにはsimDtを渡すため、高warpでも0.48秒だけ進む。非Playerはさらに0.12秒上限。
- **影響**: 姿勢、軌道、RCS torqueが異なる時計を生きる。制限がAPI名から見えず、将来の自動姿勢・solar/radiator計算を壊す。
- **推奨**: ×4超では操作torqueを0にし、姿勢を「明示的にfreeze」する。長期自由回転が必要なdebrisは別のattitude LOD/解析法を設計する。黙って0.48秒だけ進めるのは廃止する。
- **受入条件**: warp policyがテスト・HUD・コメントで一致し、隠れたtime truncationがない。×4超ではcommand torque、RCS audio/plume、姿勢依存のthrust表示を同じ条件で停止し、warp解除後にstale commandを持ち越さない。
- **工数**: M。D-04。

### C-16 thermal・power・展開が異なる時計と日照sampleを使う

- **根拠**: active Playerのradiator solar load/sunlitはframe開始時に一度計算し、全thermal substepで固定。power/radiator展開はreal `dt`、thermalはsim `dt`。高warpで何周しても同じ日照・食を仮定し得る。
- **影響**: 高warpの温度・充電が開始位相に強く依存し、再現性と物理的意味が失われる。
- **修正**: clock policyをD-04で確定する。推奨は、軌道・日照・thermal・発電に加え、放熱面積・被弾半径へ効く物理的なradiator/solar deploy stateもsim clockとする。入力受付とpresentation補間だけをgameplay real clockへ置き、weapon/controlは×4超freezeする。substep時刻でsunlitを再評価する。
- **受入条件**: 1周日照率、食跨ぎ、warp別temperature/chargeの回帰テスト。
- **工数**: L。

### C-17 未来表示1年とentity予測3時間が同じUIに見える

- **根拠**: display rangeは最大365日、entity `PREDICT_DURATION` は3時間。3時間超で船・敵・ammoの `displayState()` がnullになり、消える。
- **影響**: 利用者には故障に見える。計画線は長期、実体ghostは短期という異なる能力が説明されない。
- **修正**: D-06。短期は3時間超で「船の予測範囲外」を表示し、ghost対象sliderを制限する。長期計画線は維持する。
- **受入条件**: 3時間境界で突然無説明に消えない。
- **工数**: S〜M。

### C-18 高ワープがpredictionを毎frame破棄・再構築させる

- **根拠**: 最高warpの1frameが3時間horizonを超える。`resyncPrediction`で破棄し、最大500 RK4 stepを再構築し、次frameまた破棄する。
- **修正**: 高warp中はentity predictionを停止し、overviewまたはwarp解除後に表示に必要な範囲だけincremental rebuildする。
- **受入条件**: max warp中のprediction step budgetがほぼ0、解除後もframe hitchなし。
- **工数**: M。

### C-19 rigid collisionがframe末の1回だけでtunnelingする

- **根拠**: ×4時、0.1 real秒で0.4 sim秒移動後に終端sphere overlapだけを見る。500m/sなら200m進み、小型接触を飛び越える。
- **修正**: 重要pairへswept sphere TOIを導入するか、半径/相対速度からcollision step上限を決める。全pair CCDは不要。
- **受入条件**: 高速player/enemy、casing/hullの代表ケースでframe rate別に同じcollision結果。
- **工数**: L。

### C-20 enemy射撃がreal timeとsim timeを混ぜる

- **根拠**: 新burstの間隔は `simTime`、burst内delayはreal `dt`。warp×4でburst開始周期と連射間隔のsim上倍率が一致しない。
- **修正**: combat cadenceをreal clockへ統一するのを推奨。warpは×4まで許可しても、射撃の操作感はreal timeのままにする。物理時間基準にする場合は両方sim clockへ統一する。
- **時計の定義**: ここでいうreal clockはwall clock直読ではなく、phaseがplaying、documentがvisible、pauseでないrAFだけが進める `gameplayRealDt`。background、設定pause、結果画面の経過を復帰直後のburst delayへ加算しない。
- **受入条件**: ×1/×4、pause、background復帰で仕様どおりの同じgameplay-real cadenceまたはsim cadenceをtest。
- **工数**: S〜M。D-04。

### C-21 update phaseがThreeの絶対ECI transformへ書く

- **根拠**: `Enemy.firePlasma()` は生成直後に `pb.obj.position` を絶対ECI（数百万m）へ置き、Matrix/Vectorを割当てる。次のsyncで浮動原点位置と速度方向へ上書きされる。
- **影響**: update/sync境界違反、不要allocation、floating-origin invariant違反。将来spawn直後renderやworker分離でbugになる。
- **修正**: 生成時のobj transform書込みを削除し、Bullet.syncだけを正本にする。
- **受入条件**: visual regressionなし、update中のrender object書込み検査またはcode review ruleを通る。
- **工数**: S。

### C-22 radiator破損位置が前frameのrender transformを読む

- **根拠**: `RadiatorSystem.tipWorldPosition()` はThree foldのworld matrixを読み、論理shipRへ足す。attackはupdate側で発生するため、sync前のmesh状態を参照する。
- **影響**: 破片発生位置が1frame古い。simulationがThreeに依存し、headless testを難しくする。
- **修正**: deploy/fold角とAttitudeからplain Vec3でtipを算出する。Three foldはsyncの出力先だけにする。
- **受入条件**: pure unit testとvisual位置一致。
- **工数**: M。

### C-23 削除時にfocus/nav target等の参照整合を一括処理しない

- **根拠**: `DynamicSystem.removePlayer()` は配列とmeshだけを扱い、Camera focus、NavTarget、開いたContextMenu、PlanEditor等へlifecycle eventを通知しない。
- **影響**: ghost ID、Earthへの暗黙fallback、削除済み対象名のUI残留が起き得る。
- **修正**: `EntityRemoved` eventまたはsession registry callbackで参照所有者がcleanupする。DynamicSystemにCamera/HUDを注入しない。
- **受入条件**: focused/targeted/following shipを削除するcase table。
- **工数**: M。C-08後。

### C-24 `Stage.id` がCreativeに対して型として嘘をつく

- **根拠**: `Stage.id` は `StageId`を返すstatic castだが、`CreativeStage.id='creative'` はunion外。現在は危険なconstructor castで隠れる。
- **修正**: `ExperienceId = StageId | 'creative'`、または攻略StageとSandboxModeのidentityを分ける。Gameが共通phase contractを持つこととは別問題。
- **受入条件**: `unknown as`なし、UnlockManagerへcreativeが渡らないことを型で保証。
- **工数**: S〜M。

---

## 6. P2: 描画・ロード・フレーム時間

### PERF-01 8Kテクスチャ固定とGPU常駐量

- **根拠**: earth/clouds/moon/starsが全て8192×4096。JPEG転送量31.6 MiB、RGBA8+mipmap上限概算約680 MiB。
- **影響**: mobile/内蔵GPUで起動遅延、VRAM eviction、context/device loss、黒画面。機能追加のtexture budgetが残らない。
- **修正**: D-07。まず標準4K、低2K、高8Kの解像度tierと必要時lazy loadを通常画像で成立させる。その後、KTX2/Basisはtranscoder/backend/fallbackを含むspike結果で採否を決める。端末のmax texture sizeと実測GPU timeでtierを選ぶ。
- **受入条件**: cold load、転送byte、texture memory、p95 frame timeのbudgetを端末tier別に記録。
- **工数**: L。

### PERF-02 月mesh 64×32に8K 15 MBを貼っている

- **根拠**: `createMoon`の低分割球に `8k_moon.jpg` 15,030,356 byte。
- **修正**: 標準1K〜2K、高品質4K程度から比較する。月のscreen-space最大径を基準に選ぶ。
- **受入条件**: 最大zoomの比較画像で許容差、転送量削減を記録。
- **工数**: S〜M。

### PERF-03 地球が約157万triangle

- **根拠**: `earth.ts:40`, `SphereGeometry(R_EARTH, 1024, 768)`。
- **修正**: まず256×128または384×192固定でvisual/GPU比較。差が見える場合だけ2〜3段LOD。地表細部はtexture/normalへ寄せる。
- **受入条件**: combat/map距離のgolden screenshotとGPU timing。見た目を測らずLOD frameworkを先に作らない。
- **工数**: M。

### PERF-04 DPRが無制限で、resize時にも更新されない

- **根拠**: `scene.ts:19-25`。
- **影響**: DPR4でpixel数16倍。display移動やbrowser zoomでDPRが変わっても古い値。
- **修正**: qualityごとのmaxDpr（low 1、standard 2、high 3を初期候補）でcapし、resizeで再評価。将来はframe timeに基づくdynamic resolution。
- **受入条件**: DPR1/2/4、window移動、rotation test。
- **工数**: S。

### PERF-05 GPU初期化がtitle selectionより先

- **根拠**: `main()` は `initScene()` をawaitしてからHUDと `selectLaunch()` を作る。
- **影響**: 利用者はstageを選ぶ前にWebGPU初期化と大きなJS parseを待つ。失敗時はtitleにすら到達しない。
- **修正**: 軽いDOM shell/titleを最初に表示し、選択後にrenderer/Gameをdynamic import・初期化する。背景preloadはidle時に行える。
- **受入条件**: title interactiveまでの時間とgame readyまでの時間を別計測。
- **工数**: M〜L。

### PERF-06 loading表示がtexture完了を待たない

- **根拠**: `TextureLoader.load()`の完了/失敗を集約せず、overlayはrenderer.init直後に消える。
- **影響**: 地球・月・星がpop-inし、404/CORS/decode失敗を説明・再試行できない。
- **修正**: AssetRegistry/LoadingManagerで必須assetのprogress/error/retryを管理し、quality tierで必要なものだけload。
- **受入条件**: slow network、1 asset 404、retryのbrowser test。
- **工数**: M。

### PERF-07 font出力が約7.92 MiB、未使用外部fontも読む

- **根拠**: JetBrains Mono全subsetのwoff/woff2、HackGen regular/boldのwoff/woff2をemit。`public/index.html`はthemeで使わないShare Tech MonoをGoogleから読む。
- **修正**: 使うweight/subset/woff2だけself-host。日本語glyph要件を確認し、外部linkを削除。
- **注意**: emitされた全fontが毎回network fetchされるとは限らないが、deploy/repo容量とCSS parse対象にはなる。
- **受入条件**: Japanese HUDのglyph欠落なし、外部font request 0、font output budgetを設定。
- **工数**: S〜M。

### PERF-08 弾・薬莢・破片が個別draw callへ増える

- **根拠**: 弾最大1,200、自機弾は2 Mesh、薬莢260、破片160。mesh resource共有はあるがObject/drawは個別。
- **修正**: 最初にnormal/plasma bulletのrender表現だけをInstancedMesh registryへ移す。simulation entityは維持し、transform bufferへ書く。次にprofile結果でcasing/debrisを判断。
- **受入条件**: 最大弾数scenarioのdraw calls、CPU render time、GPU timeがbudget内。命中・spawn/despawn順は既存と一致。
- **工数**: L。D-14。

### PERF-09 `frustumCulled=false` が弾・billboard・gridに広い

- **影響**: 画面外の小物もdraw対象になりやすい。floating originにより通常culling可能なものまで無効化している。
- **修正**: なぜfalseが必要かをobject種別ごとに再検証。Instancing後はCPU visibility/距離bucketまたはinstance countで抑制。
- **受入条件**: 消失artifactなし、offscreen大量弾でdraw reduction。
- **工数**: M。

### PERF-10 BillboardがinstanceごとにPlaneGeometry/Materialを作る

- **根拠**: `render/billboard.ts` constructor。flash等の高頻度effectも個別GPU resourceを作成・disposeする。
- **修正**: geometry共有、color/blend別material cache、短命flash poolまたはinstancing。Player-owned long-lived effectには明示disposeも必要。
- **受入条件**: 連射・連続被弾でresource countが定常、見た目同等。
- **工数**: M〜L。

### PERF-11 オーロラが毎frame CPUで頂点・色を再計算しuploadする

- **根拠**: `earth.ts:137-175, 249-260`。`positions.set([..])`等の短命arrayも生成。
- **修正**: 最終的にはvertex shader/TSLへphaseを渡す。短期は直接index代入、15〜30Hz更新、非表示時skip。
- **受入条件**: aurora有無のCPU/GPU profile差を記録。
- **工数**: M。

### PERF-12 collision/hitが高warpとentity数で増幅する

- **根拠**: rigid collision O(n²)。hitは各substepでbullet×Ship/debrisを走査し、target配列も再生成。最高warpで656倍。
- **修正順**:
  1. collision layer/maskで候補を削る。
  2. frame/substepで変わらないtarget listを再利用する。
  3. 計測後にuniform grid/spatial hash。
  4. 物理workerは最後。
- **受入条件**: max entity deterministic benchmarkとp95 budget。
- **工数**: M〜L。

### PERF-13 `DynamicSystem.all()`、filter、spreadがframe内で短命arrayを作る

- **例**: cleanup、collision、Predictor、NanWatchdog、alive enemy filter。
- **修正**: stable grouped iterator、`forEachAlive`、必要な箇所だけscratch array。可読性を落とす全域micro-optimizationはしない。
- **受入条件**: allocation profileで対象がhotであること、変更前後のGC時間を比較。
- **工数**: M。

### PERF-14 marker collisionとHUDのDOM churn

- **根拠**: MarkerManagerは概算文字幅、CSS文字列の再parse、5反復O(N²)、SVG `innerHTML=''` とline再生成。NavballもSVG群を再構築。target/enemy panelは定期的にinnerHTML再生成する。
- **修正**: numeric layout model、label幅cache、spatial bucket、SVG element pool、15〜30Hz UI update。HUD rowはkeyed nodeを一度作りtext/styleだけ更新。
- **受入条件**: marker最大scenarioのstyle/layout/GC時間。日本語・全角labelの重なりvisual test。
- **工数**: L。現上限ではasset/DPR後。

### PERF-15 predictorをcombat中も全entityへ常時回す

- **背景**: map切替直後の表示を滑らかにする意図は妥当。
- **修正**: D-06。combat中は低budgetのbackground warm、overviewは高budget、high warp中は停止。完全lazyか常時fullの二択にしない。
- **受入条件**: mapを開いた初frameの欠落時間とcombat CPU budgetを両方計測。
- **工数**: M。

### PERF-16 FloatingOrigin変換が毎回Three Vectorをallocateする

- **根拠**: `RtoThreeV3` / `VtoThreeV3` は毎call new。entity/effect syncから多数呼ぶ。
- **修正**: `setRelative(out, vec)` または数値tuple APIをrender bridgeに追加。plain Vec3側の不変性は維持する。
- **受入条件**: sync allocation profile。API置換だけを目的に全call siteを一括変更しない。
- **工数**: M。

### PERF-17 単一初期bundleとperformance budget不在

- **根拠**: stage/creative/planner/debug/renderを一entryへ静的import。WebpackにsplitChunks、source map方針、bundle budgetがない。
- **修正**: title shell、Game core、creative/debugをdynamic import。production/staging source mapを分け、CIでJS/image/font budgetを検査。
- **受入条件**: initial JS parse/transfer budget、chunk load failure handling。
- **工数**: M〜L。

### PERF-18 重複・未参照assetが正本を曖昧にする

- **根拠**: `src/assets/earth.jpg` と `8k_earth.jpg` はhash同一。`earth.png`はexport対象だがruntime未参照。sourceとdocsで大容量を二重追跡。
- **修正**: asset manifestに用途、寸法、品質tier、出典、license、authoring source、runtime outputを記載。未参照物は確認後に削除またはauthoring archiveへ移す。
- **受入条件**: manifest未登録asset・runtime未参照assetをCIで列挙。
- **工数**: M。

---

## 7. P2/P3: Web UX、入力、アクセシビリティ、安全性

### WEB-01 global Tab抑止でUI keyboard navigationを壊す

- **根拠**: `Input`は常にTabをpreventDefault。launch/settings/context menu等の操作要素も多くがdiv/spanでfocus不能。
- **修正**: gameplay canvasにfocusがある時だけgame keyをcaptureし、native `button`, `input`, `label`へ移行。modalはfocus trapとrestoreを持つ。
- **受入条件**: keyboardだけでtitle選択、settings、quit、map context menuを完遂。
- **工数**: L。

### WEB-02 viewport zoomを禁止する

- **根拠**: `maximum-scale=1.0, user-scalable=no`。
- **修正**: 削除。canvas gesture抑止は `touch-action` とcanvas内pointer処理に限定。
- **受入条件**: browser zoom可能、canvas pinchは意図どおり。
- **工数**: S。

### WEB-03 touch pointer状態機械が不完全

- **根拠**: pointer IDごとでなくglobal bool、2本目captureなし、片指へ戻る基準なし、`lostpointercapture`なし。blurでもrightActive/pointers/pinchを全resetしない。
- **影響**: pinch後drag不能、OS割込で操作残留、right/middle状態のstuck。
- **修正**: pointer IDごとのFSMと `resetAllInputs()`。blur、visibilitychange、lostcapture、pointercancelを同じ解除経路へ集約。
- **受入条件**: one-finger→pinch→one-finger、画面外、通知割込、mouse/touch混在のE2E。
- **工数**: M。

### WEB-04 virtual keyが複数pointerを区別しない

- **根拠**: keyごとのSet ON/OFFだけ。同じ操作を2本の指が保持すると片方upでoff。zoom buttonはlocal `zoomOn` とInputが別正本。
- **修正**: input source/pointer IDごとのheld setまたはreference count。UI toggleの正本はInput/action state一箇所。
- **受入条件**: multi-touchとblurでheld classと論理stateが常に一致。
- **工数**: M。

### WEB-05 safe area・狭幅・hybrid device対応が不足

- **根拠**: `viewport-fit=cover`だが `env(safe-area-inset-*)`なし。固定幅左右panelが360px級で重なる。landscapeでbuttonが38pxまで縮む。`maxTouchPoints`だけでhybrid laptopにも常時touch UIを出す。
- **修正**: safe-area CSS変数、container query/grid、mobile compact HUD、pointer modality/設定でtouch UI表示を選ぶ。
- **判断**: mobileを正式supportするなら再設計。desktop専用なら起動時にsupport範囲を明示し、touch UIをexperimentalとする。D-16でsupport水準を選び、renderer/backend範囲はD-08と合わせる。
- **受入条件**: 320/360/390/768px、縦横、notch想定のvisual regression。主要tap target 44px目安。
- **工数**: L。

### WEB-06 ContextMenuがviewport外へ出て、Escape/focusを持たない

- **修正**: 表示後にサイズ測定してclamp、native button、Escape close、focus restore、menu semantics。
- **受入条件**: 四隅とkeyboard E2E。
- **工数**: S〜M。

### WEB-07 background/visibility policyが暗黙

- **現状**: rAF停止とdt clampによりsimulationは実質pauseするが、audio timerやUI状態は明示pauseされない。
- **推奨**: `visibilitychange`でGameSessionとAudioContextをpause/suspendし、復帰は利用者操作でresume。突然数時間進めない。
- **受入条件**: hidden 10秒後にsim/音/Inputが停止し、復帰時stuck keyなし。
- **工数**: M。

### WEB-08 Ctrlを前進代替に使いbrowser予約shortcutと衝突する

- **根拠**: key mapping自身がCtrl+W/T/N/数字はJSで抑止不能と認める。
- **修正**: Ctrl代替を廃止するか、remappable controlとしてopt-inにする。critical actionをbrowser modifierへ置かない。
- **受入条件**: keymap conflict validator、主要browser smoke。
- **工数**: S〜M。

### WEB-09 renderer backendの案内が実装と矛盾する

- **根拠**: README/error overlayはWebGPU必須とするが、three r169 `WebGPURenderer` はWebGPU不在時にWebGL2 backendを返す。
- **修正**: backendを検出してHUD/debugへ表示し、WebGL2 fallbackをexperimentalとしてsmokeする。対応不能なら明示的にWebGPU-onlyに設定して曖昧fallbackを止める。D-08参照。
- **工数**: M。

### WEB-10 device/context lossから復旧できない

- **修正**: backendのdevice loss/context lossを監視し、session停止、エラーoverlay、reload/retryを提示。VRAM最適化前に自動再構築へ踏み込まない。
- **受入条件**: lossをmockして復旧導線をtest。
- **工数**: M。

### WEB-11 audioのbus、limiter、session lifecycleがない

- **根拠**: 多くのnodeがdestinationへ直結。SFX volume/master mute/limiterなし。visibilityとsession disposeに連動しない。
- **修正**: master/music/sfx gain bus + compressor/limiter、onended disconnect、pause/suspend、session dispose。background音は常に停止を推奨。
- **受入条件**: 多重発砲でclipなし、pause/hidden/quitで無音、再sessionでtimer二重化なし。
- **工数**: M〜L。

### WEB-12 `innerHTML` APIの信頼境界が広い

- **根拠**: toast、target/enemy list、context menu、result、main errorがHTML文字列を受ける。現データの大半は定数だが、Creative名や将来のMOD/remote data導入でXSS境界になる。
- **修正**: defaultはtextContent/DOM builder。必要なstatic rich contentだけ狭い `TrustedMarkup` APIへ分離。`String(err)`は必ずtextContent。
- **受入条件**: `<img onerror=...>`等を入力してDOMとして解釈されない。
- **工数**: M。

### WEB-13 CSP・外部依存・metadataが未整備

- **現状**: 外部Google Font、inline style/HTMLが多く厳格CSPを難しくする。favicon 404、noscript/対応環境説明もない。
- **修正順**: 外部font削除 → styleを静的CSSへ寄せる → CSPをReport-Only → enforcement。favicon/description/noscriptは小タスク。
- **工数**: S〜L。CSPだけを先に入れて大量のunsafe-inlineを許すのは価値が低い。

### WEB-14 assetの出典・配布権がmanifest化されていない

- **根拠**: download URLはscriptにあるが、asset単位の出典、利用条件、加工履歴、license fileがない。
- **影響**: 公開・再配布・差替え時に権利確認を毎回やり直す。ここでは権利侵害とは断定しないが、確認不能自体が運用リスク。
- **修正**: `src/assets/ASSETS.md`またはmanifestへsource URL、author/provider、license/terms link、取得日、加工、checksumを記録。
- **工数**: M。人間による最終確認が必要。

---

## 8. P2/P3: アーキテクチャと拡張性

### ARCH-01 Gameのbranch重複と更新順が暗黙のAPIになっている

- **根拠**: paused/post-game/playingの各branchでeditor、map picker、cameraを重複呼出し。`Simulator.stepSimulation` は末尾に3つのbooleanを持ち、無効な組合せを型で防げない。
- **修正**: `FrameMode` discriminated unionと明示phase（input → command → simulation → lifecycle → prediction → presentation preparation）へ整理。Simulatorはnamed optionsまたは `stepPlaying` / `stepAfterResult` に分ける。
- **注意**: scheduler frameworkを新設するのではなく、現在の順序を名前付き関数へ抽出し、characterization testで固定する。
- **工数**: L。

### ARCH-02 GameがSimulator所有stateを直接変更する

- **根拠**: `Game.pause()` が `simulator.lastSimDt=0`。
- **修正**: `Simulator.pause/resetFrameDelta()`、またはlastSimDtをframe resultから導出する。
- **工数**: S。

### ARCH-03 MapPicker/HudPanelsがGame全体へ依存する

- **影響**: composition rootへ逆依存し、headless test、再利用、所有権理解を難しくする。
- **修正**: `ActivePlayerService`、read-only `HudViewModel`、command callbacksへnarrow化。巨大な汎用Context objectは作らない。
- **工数**: M〜L。

### ARCH-04 renderからgameへの依存が残る

- **例**: `environment-scene.ts`, `celestial-grid.ts` のCameraSystem、FloatingOrigin、const、`ships.ts`のgame const。
- **修正**: render側はplain view snapshot（camera position/quaternion/mode/far）とrenderer configを受ける。FloatingOriginはrender bridgeへ移すか、plain converter interfaceにする。
- **工数**: M〜L。

### ARCH-05 type-only importが通常import表記で、解析上の循環を作る

- **例**: `ProjectFn`, `ViewFrame`, `Player`等。現在のTS出力ではeraseされruntime cycleは0件だが、dependency toolと人間には循環に見える。
- **修正**: `import type`へ機械変換し、`ProjectFn`のような共有型を `view-types.ts` へ置く。`verbatimModuleSyntax`採用は全体影響を確認して別PR。
- **受入条件**: emitted graph 0 cycleを維持し、source graphのtype/runtimeを分離表示。
- **工数**: S〜M。

### ARCH-06 DynamicEntityがsimulation stateとThree objectを同時所有する

- **影響**: browserなしのgame integration test、worker、save/replay、render batchingが難しい。
- **推奨**: 一括分離しない。最初にprojectileとcollision eventをplain snapshot化し、Instanced rendererがそのsnapshotを読む。次にSpacecraft controllerを分ける。D-09。
- **工数**: 段階的L〜XL。

### ARCH-07 HitSystem/SimulatorがVFX・Sfx・Stage bookkeepingを直接呼ぶ

- **影響**: deterministic simulation harnessを作りにくい。命中ロジックと演出失敗が同じcall path。
- **修正**: simulationから `HitEvent`, `DestroyedEvent`, `CollisionEvent`, `PickupEvent` を返し、GameSessionのconsumerがscore/audio/vfxへ配る。
- **工数**: L。

### ARCH-08 Stageは多数serviceをmutable late injectionする

- **根拠**: `setup()`後でなければfieldが有効でない `!` state。label用instanceとruntime instanceが同じclass。
- **修正**: static/readonly StageDefinitionとruntime StageSessionを分ける。runtimeにはreadonlyな狭いservicesをconstructorで渡す。毎frameの巨大ctxは作らない。
- **工数**: L。

### ARCH-09 `const.ts`が物理、stage tuning、UI色、performance上限を混在

- **修正**: domain別config moduleへ分け、必要なら互換export facadeを一時維持。値を移すだけの大PRにせず、関連work packageごとに移す。
- **工数**: M。

### ARCH-10 timeとunitがすべてnumberで、clockの混同を型で防げない

- **根拠**: real dt、simDt、simTime、displayTime、MET、秒/時、m/kmが隣接APIでnumber。
- **修正**: D-13。まずclock境界に `RealSeconds`, `SimSeconds`, `SimTime` またはparameter objectを導入し、距離は公開API名のsuffixを統一。全算術をbrand化しない。
- **工数**: L。

### ARCH-11 `Math.random()`直結で再現不能

- **対象**: Ephemeris moon phase、enemy cadence/spread、spawn、debris、VFX。
- **修正**: session seed、gameplay RNG、visual RNGを分離注入。URL/debug reportへseedを出す。
- **受入条件**: 同seed・同inputでsimulation event列が一致。visual RNG変更がgameplayへ影響しない。
- **工数**: M〜L。

### ARCH-12 PowerSystemが充電だけで消費・不足効果を持たない

- **影響**: HUDとsolar deploy操作はあるがgameplay上の意味がなく、未完成featureの文脈コストを毎変更に課す。
- **修正**: D-12。短期は「未消費telemetry」と明示するかcharge HUDを隠す。長期はweapon/RCS/thermal負荷とload sheddingを別designで追加。
- **工数**: SまたはL。

### ARCH-13 model assetのObject3D名が暗黙schema

- **根拠**: radiator/solar foldを文字列名で解決し、欠けるとruntime constructorでthrow。exporterは毎回random UUIDを生成し全JSON差分を作る。
- **修正**: asset validatorをbuild/testで実行し、required names/counts/material rolesを検証。export後UUIDを決定的に正規化する。
- **受入条件**: asset schema破損をbrowser起動前にCIで検出。同入力exportでgit diff 0。
- **工数**: M。

### ARCH-14 resource ownership/dispose規則が型・共通処理になっていない

- **根拠**: Ship/Ammoはmaterialを無条件dispose、Debrisは`userData.owns*`、Bulletは共有前提でdisposeしない、Billboardはscene removeをcaller任せ。
- **修正**: shared/owned resource policy、idempotent dispose、session owner treeを定義。単一の「scene traversalで全部dispose」は共有resourceを壊すため避ける。
- **工数**: L。

### ARCH-15 session全体のdisposeがない

- **対象**: rAF、window/document listener、style、HUD、canvas、renderer、AudioContext、timers、scene resource。
- **影響**: 現状はpage navigationが偶然解放する。title復帰のSPA化、HMR、埋込み、fast restartで二重化する。
- **修正**: `GameSession.dispose()` とAbortControllerによるlistener一括解除。mainがsessionの唯一owner。
- **工数**: L。

### ARCH-16 `sunGlareSpreadScale`がPlayer/Enemyに重複し、Ephemerisを通らない

- **現状**: sun phase既定0なので結果は一致するが、将来phaseを変えると共有Ephemerisと分岐する。
- **修正**: pure combat policyへ1本化し、sunDirをcallerから渡す。
- **工数**: S。

### ARCH-17 enemy AIがStage00定数を全stageで読む

- **根拠**: `Enemy.behave` の交戦rangeが `STAGE00_MAX_RANGE`。group attack countも各Enemyが全enemyを走査する。
- **修正**: stage/AI profileをEnemy spawn時に渡し、group attack数はStage/AIDirectorがframe単位で集計。
- **工数**: M。

---

## 9. P2/P3: テスト、CI、配信、文書

### TOOL-01 CIがPRとphysics testを守らない

- **根拠**: workflowはmain pushのみ、typecheck/buildだけ。`test:physics`を実行しない。
- **修正**: pull_requestに `typecheck`, `test:physics`, lint, conflict marker, asset schema, browser smokeを段階追加。deployはmainのcheck成功後。
- **受入条件**: failing physics testでmerge/deploy不能。
- **工数**: S〜M。

### TOOL-02 production buildが型検査を含まない

- **修正例**:
  - `check`: typecheck + tests + lint
  - `build:bundle`: webpackのみ
  - `build`: `npm run check && npm run build:bundle`
- **注意**: CIで並列化する場合も、公開jobは全check resultへ依存させる。
- **工数**: S。

### TOOL-03 game層のテストがない

- **不足**: Stage/Simulator/DynamicSystem integration、warp境界、Creative validation、dispose、multi-player、hit/collision/lifecycle順、Input、DOM、launch。
- **修正順**:
  1. 純粋validator/clock/event test。
  2. fake renderer/audioを使うSimulation Harness。
  3. jsdom等のDOM component test。
  4. Playwright/Chromeの起動・入力・公開物smoke。
- **工数**: 継続的L。

### TOOL-04 lint/format/editor/toolchain固定がない

- **根拠**: project ESLint/Prettier/.editorconfig/.nvmrc/engines/packageManagerなし。CIだけNode20。`ts-loader`はinstallされるがwebpack未使用。
- **修正**: Node majorとnpm lock、ESLint TypeScript、Prettierまたは最小formatter、EditorConfig、import boundary rule。未使用ts-loader削除。
- **工数**: M。

### TOOL-05 browser targetが二重

- **根拠**: tsconfig target ES2022、esbuild loader/minifier target ES2015。対応browserの正本がない。
- **修正**: browserslistまたはdocumented targetを1つにし、WebGPU/WebGL2 support policyと一致させる。
- **工数**: S。

### TOOL-06 deployがmainへ生成物をpushする

- **詳細**: P0-02、D-01。`docs/`出力はbranch sourceの制約に沿ったものだが、その生成物をmainへpushするため権限が `contents: write` となり、branch protection/race/履歴/rollbackを悪化させる。
- **推奨**: Pages sourceをGitHub Actionsへ変更可能ならartifact deployと最小権限 `contents: read`, `pages: write`, `id-token: write`。変更できない事情がある場合はbranch publishingを維持し、専用deploy branch、単一writer、直列化、clean build、競合時failで安全化する。
- **工数**: M。

### TOOL-07 performance baselineとbudgetがない

- **現状**: `?perf=1`は有用だが、scenario、端末、閾値、履歴がない。
- **修正**: 代表3scenario（idle LEO、最大弾幕、overview長期予測）をseed固定し、CPU update/render、draw call、JS/asset byte、memoryを保存。退行幅をCI warning/blockにする。
- **工数**: M〜L。

### TOOL-08 ad-hoc download scriptと追跡 `.DS_Store`

- **根拠**: `.DS_Store`, `src/.DS_Store` が追跡済み。`download.js`, `download_py.py` はpackage script/READMEから孤立し、Python版はTLS hostname/certificate検証を無効化する。
- **修正**: `.DS_Store`削除・ignore。download toolはchecksum/HTTPS検証付きで `tools/`へ統合するか削除。TLS無効化は残さない。
- **工数**: S。

### DOC-01 READMEが利用者を誤案内する

- **例**: build先を`dist/`と記載（実際は`docs/`）、左click射撃/右drag、摂動・enemy AI・aurora未実装、WebGPU必須。
- **修正**: P0修正と同じPRでcurrent behaviorへ同期。READMEは利用者/導入だけに絞る。
- **工数**: S。

### DOC-02 AGENTS/DEVELOP一次資料にもdriftがある

- **例**: 旧path、mapで物理停止、旧input、PowerSystemの固定panel説明、存在しないaudio path、実装済み項目の「未実装」。
- **影響**: 「DEVELOPを正本」とする規約自体が成立せず、人間・AIが正しいコードを誤って古い仕様へ戻す。
- **修正**: 最初に現在の真実へ一度同期。その後D-11の文書戦略へ移行。
- **工数**: M。

### DOC-03 四つの長大文書を全src変更で手更新する義務が持続不能

- **根拠**: CALLSTACK 421行、OWNERSHIP 298行、SPEC 332行、CLAUDE 276行を変更ごとに同期する規約。既にdriftしている。
- **修正**: D-11。安定した不変条件/ADRだけ手書きし、import/call/asset/ownership inventoryは生成する。
- **工数**: L。

### DOC-04 旧memoにstatus/as-of/supersedesがない

- **修正**: memo indexを作り、各文書に `current`, `superseded`, `historical`, `human-only` とas-of commitを付ける。過去本文を大量編集せずindexで管理する。
- **工数**: S〜M。

### DOC-05 コメントが実装と逆の安心を与える

- **例**: Simulatorの「fpsによらず積分の刻みを一定」は、20秒未満では可変rAF dtをそのまま使うため事実でない。
- **修正**: コメントは意図でなく検証可能な不変条件を書く。clock policy決定後に更新。
- **工数**: S。

---

## 10. Completed Staff Work: 判断が必要な論点

ここでは「承認者へ何を決めてもらうか」ではなく、選択肢を検討したうえで推奨案まで提示する。

### D-01 公開方式

前提として、現行の `docs/` 出力はGitHub Pagesのbranch publishing sourceがrootまたは`/docs`を公開対象にする制約へ対応した設計であり、それ自体を問題扱いしない。GitHub Pagesには別方式としてGitHub Actions artifact deployもあるが、repository settingsのPages source変更が必要である。

| 選択肢 | 利点 | 欠点 |
| --- | --- | --- |
| A. mainの`docs/`へbot pushを継続 | 現在のPages設定を維持できる | 競合、履歴ノイズ、write権限、今回の二重bundleを再発しやすい |
| B. branch publishingを維持し、deploy専用branch/単一writerへ移す | mainはきれい、root/`docs`制約の範囲で運用可能 | branchの生成履歴とwrite権限は残る。Pages sourceのbranch変更が必要 |
| C. Pages sourceをGitHub Actionsへ変更しartifact deploy | sourceとartifact分離、最小権限、atomic deploy、rollback明確 | repository settingsとworkflowの移行権限・検証が必要 |

**推奨: repository settingsを変更できるならC、変更できないならB。** 今回のP0は`docs/`というdirectory名ではなく、Aの「mainへ生成物を自動pushする」構造的コストが現実化したもの。短期の公開復旧では現在の`docs/`方式を維持し、公開方式の移行は別作業にする。

Cを採る場合は二段階にする。先にPages source、custom domain/CNAMEの有無、404 fallback、cache header、hashed assetの参照を確認し、artifact版を公開して旧URLとdeep linkをsmokeする。直前の正常な `docs/` をtag/artifactとしてrollback可能な期間だけ保持し、artifact deploy確認後の別commitで追跡対象から外す。PR previewは必須ではないが、必要性を移行ticketで明示判断する。生成物削除とPages source切替を未検証の1操作にまとめない。Bを採る場合はdeploy専用branchを単一workflowだけが更新し、concurrency groupで直列化し、clean build以外の差分混入と自動mergeを禁止する。

### D-02 Creative開始時の船

| 選択肢 | 利点 | 欠点 |
| --- | --- | --- |
| A. 本当に0隻で開始し、active shipをnullableにする | SPECと体験が一致、sandboxとして自然 | Camera/Editor/HUDのactive前提を整理する必要 |
| B. 明示的なstarter ship 1隻で開始し、UI/SPECに表示 | 小改修、既存active前提を維持 | 自由配置前に1隻あり、8隻枠の意味が変わる |
| C. hidden sentinelを維持 | 改修不要 | 現在の矛盾、枠消費、将来bugを温存 |

**推奨: A。** ただしC-08/C-09のactive ship serviceと同じwork packageで行う。緊急にCreativeを公開する必要がある場合のみBを暫定採用し、starterを隠さない。

### D-03 複数船の意味論

| 選択肢 | 利点 | 欠点 |
| --- | --- | --- |
| A. 全追加船を完全なPlayerとして常時sim | 一貫した世界、将来の切替/AIに強い | passive systemの全船cost |
| B. activeだけPlayer、他は受動Spacecraft | 低コスト、制御境界が明快 | active化時のcomponent/state移行設計が必要 |
| C. 現状どおり選択でsystemを止める | 変更なし | 物理法則が選択依存、再現不能 |

**推奨: Bを構造として採用し、passive physics/thermal/powerは全Spacecraftで進める。** `Player`というentity型ではなく `PlayerController`が1隻を指す。将来AI controllerも同じ口を使える。

設計成果物には、orbit、attitude、thermal、power、radiator/solar、damage、ammo/belt、plan/followPlanを `Spacecraft`、controller、stage/sessionの誰が所有するかを表にする。detach時のtransient command clear、非active船の被弾・攻撃・friendly-fire policy、旧 `Player` からの段階的移行とrollback点も必須とする。

### D-04 clockとsimulation step

| 対象 | 推奨clock/policy |
| --- | --- |
| 軌道、drag、third body、thermal、日照、発電 | sim time、event/atmosphere境界でadaptive substep |
| Radiator/solarの物理deploy state | sim time。放熱面積・太陽入力・被弾形状と同じ時刻を使う |
| Weapon cadence、入力poll、UI、presentation補間 | `gameplayRealDt`。playing・visible・非pause時だけ進み、×4超はcontrol/weaponをfreeze |
| Player attitude | ×4以下sim time。×4超は明示freeze |
| 自由回転debris | quality/perf予算内のattitude LOD。隠れた0.12秒進行にしない |
| VFX | 原則real time。軌道上位置だけsim stateに追随 |

**推奨: strict固定60Hz一本化ではなく、event-aware bounded stepping。** 基本式を `subDt = min(remainingDt, MAX_DT, nextKnownBoundaryDt, dynamicSafetyDt)` とし、node、lifetime、atmosphere、collisionという「跨いではいけない時刻/領域」の手前で切る。解析時刻を持たない大気/距離境界は保守的上限またはbracket＋短い再積分を使う。catch-up予算を超えた場合はwarpを落としてHUDへ `WARP LIMITED` を出し、正しさを捨てて追いついたふりをしない。

同じ時刻とみなすepsilonは一箇所の `TIME_EPS_S`（初期候補 `1e-6 s`）に集約し、次の順で処理する。

1. 全entityの連続状態を境界時刻まで積分する。
2. expiry/out-of-bounds/reentry等のterminal lifecycleを確定する。寿命区間は `[born, expires)` とし、expiryと同時のhitではexpiryを先にする。
3. swept hit/collision/pickupを時刻順に解決し、damage/lossを確定する。
4. まだ生存するentityへnode/followPlan/burn等のscheduled discontinuityを適用する。
5. spawn/destruction eventをcommitし、epoch invariantを確認して次の残り時間へ進む。

この順序は最初の推奨値であり、gameplay上別の同時刻規則を選ぶ場合もtable testで固定する。Phase 0で高精度・短stepの参照積分を用意し、LEOの位置/速度/軌道要素、node epoch、reentryのpeak q/temp/loss timeごとに数値誤差予算を承認する。「warpが違っても完全一致」を要求しない。

### D-05 entity identity

| 選択肢 | 評価 |
| --- | --- |
| 表示名をunique制約にする | 小さいがrename/同名表現/外部dataに弱い |
| random UUID | 一般的だがdeterministic replayとdebug表示に不便 |
| session-local deterministic opaque ID | 単純、再現可能、表示名と分離できる |

**推奨: session-local deterministic ID。** save/loadを入れる時点でpersistent namespace/versionを追加する。

### D-06 prediction budget

| 選択肢 | 利点 | 欠点 |
| --- | --- | --- |
| 常時full warm | map即時 | combat CPU、高warpthrash |
| 完全lazy | combat最軽量 | map初回が空/重い |
| adaptive background | 両者を均衡 | budget managerが必要 |

**推奨: adaptive background。** combat低budget、overview高budget、高warp停止。長期plan trajectoryと短期entity ghostをUI上も分ける。

### D-07 描画品質とtexture配信形式

| 選択肢 | 利点 | 欠点 |
| --- | --- | --- |
| A. 解像度別JPEG/PNGを先に作る | 実装が単純、全backendで同じ、fallbackが明快 | 展開後VRAMとmipmap量は減るがGPU圧縮ほどではない |
| B. KTX2/Basisを直ちに全面採用 | 転送量・VRAM改善の余地が大きい | transcoder WASM、配布/license、backend別format、fallbackの設計が必要 |
| C. 8K固定のままDPRだけ下げる | 最小変更 | 起動・VRAMの主因を残す |

**推奨: low / standard / highの3段階をAで先に成立させ、Bは互換性spike後に採否を決める。** 初期候補はlow=2K/DPR1、standard=4K/DPR2、高品質だけ8K/DPR3。Moonは他より1段低くてよい。KTX2 spikeではKTX2Loader、transcoder WASMのself-host先/license、WebGPU/WebGL2両backend、非対応時の同tier JPEG fallbackを検証する。設定変更は当面session reloadで反映し、ロード中にasset tierを入れ替えない。動的解像度はstandardのframe budget維持に使い、texture tierを毎frame変えない。

### D-08 renderer backendとsupport範囲

| 選択肢 | 評価 |
| --- | --- |
| WebGPU-onlyを強制 | 検証範囲は狭いが到達端末が減る |
| 現在のWebGL2 fallbackを正式support | 到達範囲大、visual/性能の二系統検証が必要 |
| fallbackをexperimentalとして検出・smoke | 現状に最も近く、事実を正しく伝えられる |

**推奨: 当面experimental fallback。** backend名を表示/ログし、主要画面だけsmokeする。実機差が大きい場合にWebGPU-onlyへ意図的に絞る。

### D-09 ECS / worker /大規模再設計

**推奨: 今は採用しない。** 先にEntityId、clock、domain event、render registry、session lifecycleを導入する。これらが揃えばECSやworkerの必要性を測れる。現時点でECSへ移ると、Three所有と時計不整合を新しいcontainerへ移すだけになる。

### D-10 DOM実装方針

**推奨: React等を導入しない。** 現HUDは小さな更新頻度の異なるgame overlayで、native semantic DOM、component helper、静的CSS、node cacheで十分。frameworkはaccessibilityを自動解決せず、bundle/状態同期を増やす。

### D-11 文書戦略

| 選択肢 | 評価 |
| --- | --- |
| 現4文書を毎変更で手更新 | 情報量は多いが既に破綻 |
| 文書を大幅削除 | driftは減るが設計理由を失う |
| 安定情報+ADRを手書き、機械情報を生成 | 初期整備が必要だが持続可能 |

**推奨: 3番目。** SPECはproduct behavior、ADRは「なぜ」、OWNERSHIPは安定したstate boundaryだけ。import/call tree、file inventory、asset manifestは生成。各文書にas-of commitとowner/update triggerを持たせる。

### D-12 PowerSystem

| 選択肢 | 評価 |
| --- | --- |
| 直ちに消費/負荷遮断まで実装 | gameplay価値は出るがdesign scopeが大きい |
| systemを削除 | 文脈は減るがsolar/radiator表現も後退 |
| 当面telemetry/cosmeticと明示し、chargeの意味を誇張しない | 低リスク、将来設計を待てる |

**推奨: 3番目。** HUDは「蓄電（消費未実装）」とするかchargeを隠す。電力をcore refactorの完了条件にしない。

### D-13 unit型

**推奨: clockと外部境界だけ軽量brand/parameter object。** Vec3の全成分をMeters型にするような全面brand化は算術noiseが大きい。`dt`, `simDt`, `simTime`, `displayTime`の取り違えを最優先で防ぐ。

### D-14 小物描画

**推奨: simulation entityを保ち、rendererだけをinstancingする。** 最初は弾2種。薬莢/破片は形状・所有・回転が複雑なので、弾でAPIと計測が固まってから判断する。

### D-15 Creativeで許可する軌道種別

| 選択肢 | 利点 | 欠点 |
| --- | --- | --- |
| A. 現在のplacerを楕円専用と明記する | `period/a/e` UIと一致し、validatorを安全に閉じられる | escape trajectoryは別手段が必要 |
| B. 同じフォームで全conicを扱う | UI追加が少ない | 双曲線にperiodはなく、入力語彙が嘘になる |
| C. 楕円placerとescape/hyperbolic toolを分ける | 概念と検証条件が明快、将来の遷移設計に強い | 新UIとprediction/loss policyが必要 |

**推奨: 当面A、cislunar/escape gameplay導入時にC。** `e >= 1` の拒否は現在フォームの制約であり、physics APIや将来仕様から双曲線軌道を排除しない。

### D-16 対象端末と性能合格線

| 選択肢 | 利点 | 欠点 |
| --- | --- | --- |
| A. desktop 60fpsのみ正式support | 合格線が明快、最適化範囲が狭い | touch UIとmobile導線が中途半端に残る |
| B. desktop 60fpsを正式、mobile low 30fpsをexperimental | 現実的な範囲でmobile実測を続けられる | 二つのprofileとsupport表示が必要 |
| C. desktop/mobileとも60fps正式support | 到達範囲と品質目標が高い | 現asset/DOM/描画構成では大きな追加投資 |

**推奨: B。** Phase 0で実機名、OS、Chrome version、CSS解像度、DPR、power mode、network profileを記録した基準表を承認する。初期SLO候補は、desktop standard（1920×1080、DPR上限2、integrated GPU級）でcombat p95 frame ≤16.7 ms・overview p95 ≤33.3 ms、mobile low（390×844、DPR1）でp95 ≤33.3 ms、steady stateの100 ms超frame 0件。CI byte候補はtitle shellの圧縮JS+CSS ≤300 KiB、launch必須assetはlow ≤5 MiB・standard ≤12 MiB、高品質assetは選択後lazy loadとする。数値は願望として固定せず、Phase 0のcurrent baselineと見た目比較を添えて人間が承認し、その後は退行率も併記する。

---

## 11. 実行ロードマップ

### Phase -1: 公開復旧（同日、ほかのPRを止めて実施）

1. P0-01 import修正。
2. P0-02 conflict解消、clean deploy。
3. conflict marker、typecheck、physics test、60-frame smokeをCIへ。
4. FatalErrorOverlay。

**Exit criteria**: typecheck/test/build/smoke全緑、公開HTML entry 1本、console error 0、公開版を手動確認。

### Phase 0: Characterizationと計測（1〜3日）

1. simulation time invariantとfollowPlan跨ぎの失敗テストを作り、本修正までC-02の暫定ガードを入れる。
2. lifetime、form validation、disposeの失敗テストを作る。
3. deterministic seedの最小導入と代表scenario固定。
4. current visual/perf baselineを保存し、D-16の端末表・frame/load/byte budgetを数値で承認する。
5. 短stepの参照積分を用意し、LEO state/要素、node epoch、reentry peak/lossの誤差予算を決める。
6. backend名とquality/debug情報を出す。

**Exit criteria**: P1修正前の失敗を自動再現でき、followPlanの既知破壊経路がguardされ、性能・数値誤差変更の比較対象と合格線がある。

### Phase 1: Creative・lifecycle・identity（1〜2週）

1. form validator。
2. Player/effectのidempotent dispose。
3. 最小 `GameSession.dispose()`、listener/Audio/timerの解除。
4. EntityId/displayName分離。
5. dead ship roster/recovery、referential cleanup。
6. Creative 0隻開始とActivePlayerService。
7. controller/passive spacecraft分離とdetach時command clear。

**Exit criteria**: 0〜8隻の配置/削除/喪失/切替を繰返してPlayer/session所有のstate、scene、DOM listener、Audio timerが定常。GPU memoryは決定済みの観測指標で増加傾向がない。

### Phase 2: clock・event-aware simulation（1〜2週）

1. clock policyを型とAPIへ。
2. followPlanのnode boundary。
3. substep lifecycle。
4. atmosphere adaptive step/warp解除。
5. attitude/thermal/power/enemy cadence統一。
6. collision eventと重要pair CCD。

**Exit criteria**: Phase 0の参照積分に対し、LEO state/要素、node時刻、reentry peak/lossが対象別の数値誤差内。全entity epoch invariantを満たし、隠れたtime capがない。

### Phase 3: Web起動・asset・quality（1〜2週）

1. title-first起動とAssetRegistry。
2. self-host font整理。
3. texture tier、Moon、Earth mesh、DPR。KTX2は互換性spikeを通過した場合だけ導入。
4. device loss/fallback表示。
5. visibility/audio/input reset。
6. mobile support範囲に応じたsafe-area/accessibility。

**Exit criteria**: low/standard/highのcold load、GPU、p95 frame budgetを実機で満たす。

### Phase 4: hot pathと描画batch（計測後、1〜2週）

1. Bullet instancing。
2. Billboard共有/pool。
3. collision layers/target scratch。
4. marker/HUD update rateとpool。
5. Predictor adaptive budget。

**Exit criteria**: 最大弾幕/overview benchmarkで目標budget。見た目・命中回帰なし。

### Phase 5: 境界と文書の持続可能化（並行、1週）

1. Game frame phase抽出。
2. domain event、narrow service/view model。
3. Phase 1で入れたsession ownershipの共通化・境界整理。
4. StageDefinition/StageSession。
5. generated architecture/asset docs、ADR、memo index。

**Exit criteria**: source変更時に更新すべき手書き文書が明確で、CI生成物がdriftを検出する。

---

## 12. Sol → Luna向け作業パッケージ

Lunaに任せるのは、判断が確定し、入力・出力・受入条件が閉じている作業とする。Solは各package開始前に、依存するD番号を承認済みとして記録する。

### Luna-ready（判断後は機械的に進めやすい）

#### L-00 Release guard

- 対象: `camera-system.ts`, package scripts, CI, browser smoke。
- 作業: import修正、`check` script、conflict marker check、60-frame smoke。
- smoke contract:
  - runnerはPlaywrightからChrome stableを起動し、clean production artifactを `127.0.0.1` の一時portで配信した `/?stage=1` を必須対象にする。dev-server smokeは別test名にし、artifact検査の代用にしない。
  - CIの安定gateは `--disable-features=WebGPU` でWebGL2 fallbackを確認し、WebGPU jobは `--headless=new --enable-gpu --enable-unsafe-webgpu --disable-gpu-sandbox --no-sandbox` を使用する。WebGPU jobはpass率を記録し、安定するまではscheduled/non-blocking、安定後にrequiredへ上げる。
  - appにtest専用read-only debug hookを設け、`gameReady === true`、backend名、frame counter `>= 60` を30秒以内に待つ。DOMの存在だけをready判定にしない。
  - `pageerror`、console error、network failure、allowlist外warningで失敗。allowlistは完全一致・理由・期限を持ち、`Multiple instances of Three.js` は許可しない。
  - 失敗時はconsole log、network log、backend、screenshotをCI artifactへ保存する。artifact HTMLのentry script 1本も同じjobで検査する。
- 禁止: physics/gameplay tuning変更。
- 検証: typecheck、116 physics、production build、headless console error 0。

#### L-01 Three import統一

- 対象: `floating-origin.ts`, `glow-texture.ts`, import boundary check。
- 作業: runtimeを`three/webgpu`へ統一。
- 検証: duplicate warning 0、WebGPU/WebGL2 smoke。

#### L-02 Creative validator

- 前提: D-15と各fieldの許容範囲をSolが確定。
- 作業: pure parser/validator、field error UI、unit test。
- 検証: invalid入力でentity/scene不変。

#### L-03 Player resource disposal

- 前提: resource ownership表をSolが承認。
- 作業: effect dispose、Player aggregate dispose、idempotency test。
- 検証: unitでは20 place/deleteでowned object/scene/markerがbaseline。browserでは100回のheap/GPU観測値が線形増加しない。取得不能なrenderer内部counterを合格条件にしない。

#### L-04 Input reset/FSM edge cases

- 前提: gesture仕様を確定。
- 作業: lostcapture/blur/visibility、pointer ID、virtual key ref count、E2E。
- 検証: multi-touch case table。

#### L-05 Font/asset hygiene

- 前提: 採用font/weightと削除assetを人間確認。
- 作業: import絞込み、外部link削除、duplicate source整理、manifest/checksum。
- 検証: Japanese glyph screenshot、output byte budget。

#### L-06 CI/deploy hardening

- 前提: D-01でB/Cを選択。CならPages設定権限、Bならdeploy branchと単一writer policyを用意。
- 作業: 共通してPR checks、production URL/deep link、CNAME/404/cache確認を行う。Cはartifact deploy・最小権限・旧docs rollback artifact・検証後のdocs tracking移行。Bはdeploy branchへのclean build、concurrency直列化、競合時fail、自動merge禁止。
- 検証: production URL/deep link、single entry、hashed asset更新、rollback手順。PR previewを採用しない場合も判断を記録。

#### L-07 Docs truth sync

- 前提: current behaviorの変更が先にmerge済み。
- 作業: README/AGENTS/DEVELOPの既知矛盾修正、as-of/status追加。
- 禁止: `memos/mikanixonable/dev.md`編集。

### Sol主導（設計判断とレビューが必須）

#### S-01 Clock/Event boundary

- D-04を具体APIへ落とす。`subDt`選択、node/lifetime/atmosphere/collision boundary、同時刻順、`TIME_EPS_S`、catch-up上限と `WARP LIMITED` の挙動を決める。
- Lunaには個別テスト、type rename、単純call-site移行を分割して渡す。

#### S-02 Active controller / multi-spacecraft

- D-02/D-03/D-05をまとめる。nullable active、roster、camera fallback、passive systems、projectile sourceを設計する。
- component責務表、detach時command clear、nonactive船の攻撃/被弾policy、旧Playerからの移行順とrollback点を成果物にする。
- big-bang entity rewriteを避け、characterization testを先にmergeする。

#### S-03 Domain event and session lifecycle

- event schema、所有権、dispose順、audio/vfx consumerを決める。
- DynamicSystemへUI/Three ownerを逆注入しない。

#### S-04 Render registry / instancing

- current visualとhit stateを保持しつつ、simulation entityとrender instance slotのmappingを決める。
- Bulletだけで成立させてから範囲を広げる。

#### S-05 Documentation architecture

- D-11に基づき、何を手書き、何を生成、何をtestで保証するかを決める。
- 過去memo本文を無差別に書換えずindexでstatus管理する。

#### S-06 Asset quality pipeline

- D-07/D-16に基づき、通常画像tierを先に成立させる。KTX2はtranscoder配布/license、WebGPU/WebGL2対応、JPEG fallback、cache、失敗時挙動を含むspikeとして分離する。
- Lunaには承認済み寸法への変換、manifest/checksum、byte budget testを渡し、codec採用判断は渡さない。

---

## 13. 全体のDefinition of Done

リファクタリング完了は「ファイルを分割した」「classを増やした」ではなく、次を満たすこととする。

### Correctness

- typecheck、全unit/integration/browser smokeが成功。
- 全生存simulation entityのepochがSimulatorの時刻と一致。
- warp別結果が、短step参照積分に対する対象別誤差予算内。完全一致を暗黙に要求しない。
- invalid inputがsimulationへ入らない。
- active選択がpassive physics、hit、collision attributionを変えない。

### Lifecycle

- create/remove/restart/quitを繰り返してscene、GPU resource、DOM listener、Audio timerがbaselineへ戻る。
- disposeはidempotent、shared resourceを早期解放しない。
- 削除entityへのfocus/target/plan参照が残らない。

### Performance

- D-16の対象端末/解像度/browserごとに、low/standard/highのasset byte、DPR、texture、p95 CPU/GPU frame budgetが数値で承認・文書化される。
- 最大弾幕とoverview長期予測のseed固定benchmarkがある。
- 最適化はprofile差とvisual regressionを伴う。

### Web UX

- titleがrenderer初期化より先に操作可能。
- loading/error/device lossに画面内説明と復旧導線がある。
- keyboardだけでmenuを操作でき、Tab/zoomを不必要に奪わない。
- background化で音・入力が残留しない。

### Delivery

- PRでcheckされる。生成物をdefault source branchへpush backせず、D-01で承認したartifact deployまたは専用deploy branchだけを使う。
- 公開HTMLは単一entry、conflict marker 0。
- backend/support範囲がREADMEと実動で一致。
- asset provenanceとlicense確認先が追跡される。

### Context cost

- current architecture文書にas-of commitとownerがある。
- 機械的なcall/import/asset inventoryは生成またはCI検査される。
- 古いmemoのstatusがindexから分かる。
- `dev.md`のhuman-only規則が維持される。

---

## 14. 最初の10チケット

依存関係を踏まえ、実際にissue化するなら次の順がよい。

1. **P0: missing `C` import + 60-frame startup smoke**
2. **P0: `docs/index.html` conflict解消 + single-entry公開検査**
3. **CI: PR checkへtypecheck + physics + conflict markerを追加**
4. **P0: runtime fatal overlay（reload-only）+ throw smoke**
5. **Simulation: followPlan node-crossing失敗test + 暫定guard + epoch invariant**
6. **Creative: active切替時の旧command clear + regression test**
7. **Creative: pure elliptic-form validation + invalid-input tests（D-15）**
8. **Lifecycle: Player/effect/orbitline disposal + resource regression**
9. **Baseline: three performance scenarios + reference integration/error budgets**
10. **Deploy: Pages公開方式のhardening（D-01でB/C承認後）**

この10件が終わるまで、ECS、worker、全体的なfolder再編、描画全面刷新を開始しない。土台の観測可能性と正しさを先に確立する方が、以後の機能追加速度とAIによる実装精度の双方に効く。
