# 技術

## 1. 状態とアーキテクチャ

<p align="center">
  <img src="../.github/readme/wiki-tech-architecture.svg" alt="状態の種類と依存方向" width="100%">
</p>

Dive into Tepui の設計は、値を「何の機能か」より**捨てたときに作り直せるか**で分ける。位置・速度・燃料・損傷のように復元できない値はモデルの正本、軌道線・HUD・GPU資源のように再生成できる値は導出である。この区別により、描画を消してもゲーム状態は失われず、表示設定を変えても物理結果は変わらない。

依存は概ね、不変な数学・物理 → ゲームモデル → 表示導出 → GPU / DOM / Audio の順に流れる。装置側がゲーム上の意味を所有せず、モデルの値を書き換える口も所有者に限定するため、同じ状態を複数箇所が勝手に更新しにくい。

| 層 | 例 | 可変状態 |
| --- | --- | --- |
| 定義 | `math/`, 型、定数 | 原則なし |
| 時刻依存 | `physics/` | 結果を変えないキャッシュのみ |
| モデル | `game/` | 位置、燃料、進行、視点などの正本 |
| 導出・装置 | `render/`, `hud/`, `audio/`, `input/` | 再生成可能な表示・入出力状態 |

## 2. 1フレームの流れ

<p align="center">
  <img src="../.github/readme/wiki-tech-frame.svg" alt="入力から描画までのフレーム位相" width="100%">
</p>

1フレームは **入力解釈 → モデル進行 → 表示導出 → 同期・描画** の順で進む。ブラウザイベントが届いた瞬間に宇宙船を動かすのではなく、入力を操作量や命令へ変換し、決まった進行位相で正本へ適用する。これにより、DOMイベントの発生時刻にゲーム結果が依存しない。

`src/run/run.ts` の `Run` がこの順序を組み、`Game` がモデル、`GamePresentation` が入力解釈と表示導出を束ねる。セーブはモデル進行が確定した後、表示資源へ同期する前の状態を直列化するため、GPUやDOMの一時状態を保存する必要がない。

## 3. WebGPU・描画・データ基盤

<p align="center">
  <img src="../.github/readme/wiki-tech-render.svg" alt="モデルからWebGPUまでの描画とデータ供給" width="100%">
</p>

描画は Three.js の WebGPU renderer と TSL を中心に構成される。宇宙船・天体・軌道線・雲の表示状態はゲーム側で意味付けされ、`render/` はその宣言を Three.js / GPU 資源へ写す。GPU資源は **構築・同期・破棄** を分け、毎フレームの同期で geometry や texture を無制限に作り直さない。

地球表面のような大規模データは、必要範囲だけを **タイル要求 → HTTP → デコード → 常駐管理 → ページテーブル → GPU材質** の順で流す。カメラ移動で不要になった古い要求は世代管理で破棄し、ネットワーク・デコード・GPU待機を別々に制限することで、表示の高精細化がメインループを止めにくい構造になっている。

## 4. 開発・検証

<p align="center">
  <img src="../.github/readme/wiki-tech-development.svg" alt="仕様、実装、テスト、PRの関係" width="100%">
</p>

開発では、**現在の実装＝コード、望ましい挙動＝SPEC、置き場と所有＝ARCHITECTURE、書き方＝CODING-RULE** と役割を分ける。仕様書を実装済み一覧にせず、コードの現状を文書へ重複して写さないことで、更新時の齟齬を減らしている。

通常の変更では `npm run typecheck` を基準とし、触った層に応じて `test:physics`、`test:game`、`test:render` などを追加する。import境界は `check:boundaries`、実ブラウザは `smoke:browser`、描画は Render Lab / Cloud Lab で確認する。mainへ送る前は全体テストとbuildまで通し、releaseはCIが生成する。

<p align="center">
  <a href="README.md"><strong>← WIKI</strong></a>
  ·
  <a href="02-solar-system.md"><strong>太陽系 →</strong></a>
</p>
