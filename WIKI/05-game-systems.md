# ゲームシステム

## 1. ラン・ステージ・時間

<p align="center">
  <img src="../.github/readme/wiki-game-run.svg" alt="LauncherからRun、Game、Stageへつながるゲーム進行" width="100%">
</p>

一回のプレイは `Run` が `Game` と表示系を組んで成立し、`Stage` が勝敗・初期配置・補給などのルールを与える。Stage 00〜2、CREATIVE、debug系は同じ Game / DynamicSystem を共有し、ゲームモードごとに別の物理エンジンを持たない。

時間加速は `SimSpeedManager` がモデル状態として持ち、ポーズとは別に扱う。ステージは開始元期も宣言するため、開始時刻を変えると月・太陽・影などの天体配置も変わる。結果画面や次のランへの遷移は、ラン外の `launcher/` が担当する。

## 2. 船体・建造・ドッキング

<p align="center">
  <img src="../.github/readme/wiki-game-spacecraft.svg" alt="ShipAssembly、モジュール、建造、ドッキング" width="100%">
</p>

宇宙船は固定モデルではなく、モジュール実体と接続辺からなる **ShipAssembly** である。`cockpit`、`tank`、`thruster`、`RCS`、`weapon`、`dock`、`solar_panel`、`radiator`、`booster` などが個別状態を持ち、総質量・重心・慣性・能力は船体構造から導出する。

ドッキングでは二隻を「親子のまま追従」させず、接続後の一つのアセンブリとして質量特性を再計算する。分離では接続グラフを切り、連結成分ごとに船体を再構成する。描画メッシュは衝突形状や保存形式の正本ではない。

## 3. 会合・戦闘・敵

<p align="center">
  <img src="../.github/readme/wiki-game-combat.svg" alt="軌道会合、相対速度、見越し射撃、被弾" width="100%">
</p>

戦闘は軌道運動の上にあり、距離だけでなく相対速度・姿勢・弾速が射撃機会を決める。見越し点は目標運動と実体弾の飛行時間から計算し、弾は接触・寿命を持つ動的エンティティとして扱う。高倍率時間加速では射撃を制限し、戦闘の時間分解能を保つ。

被弾は接触 → 損傷 → 船体/実体状態の変更 → イベント記録 → 音・閃光・通知という流れで処理する。タンパク質型敵も `DynamicSystem` の個体として存在し、表示形態が特殊でも軌道・戦闘の基盤は共通である。

## 4. UI・入力・カメラ

<p align="center">
  <img src="../.github/readme/wiki-game-ui.svg" alt="生入力からゲーム命令、Viewer、HUD、カメラへの流れ" width="100%">
</p>

`input/` はキー・マウス・タッチの生イベントを集め、`GameInputRouter` が機能ごとの優先順位に従って配る。モーダル、建造中、一時停止では通す入力群を変え、同じ物理キーが複数機能へ二重に届かないよう消費順を持つ。

カメラ・航法ターゲット・マップ基準系・予測表示など、セーブごとに残る「見方」は `Viewer` が所有する。一方、テーマ・描画品質・BGM音量のようにセーブを跨ぐ選択は `UserSettings` が持つ。Three.js Camera や DOMはこれらの正本ではなく、毎フレーム同期される表示資源である。

## 5. 保存・設定・起動

<p align="center">
  <img src="../.github/readme/wiki-game-save.svg" alt="モデル状態からスナップショット、セーブスロット、復元への流れ" width="100%">
</p>

セーブは位置・速度・船体・ステージ・時間加速・Viewerなど、再生成できないモデル状態を直列化する。GPU テクスチャ、メッシュ、DOM、軌道線などは保存せず、ロード時に新しく作り直す。元期と `simTime` の組も保持するため、復元後の天体配置が保存時と一致する。

`launcher/save/` はスロット、スナップショット、自動保存、入出力を管理し、`settings/` はアプリ共通設定を管理する。Launcher → Run/Game の依存方向を保つことで、一回のランが次のステージや `localStorage` の都合を直接知る構造を避けている。

<p align="center">
  <a href="04-weather.md"><strong>← 気象</strong></a>
  ·
  <a href="README.md"><strong>WIKI</strong></a>
  ·
  <a href="../README.md"><strong>プロジェクト README →</strong></a>
</p>
