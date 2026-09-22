<p align="center">
  <img src="../.github/readme/wiki-title.svg" alt="Dive into Tepui 開発 WIKI" width="100%">
</p>

<p align="center">
  <a href="../README.md"><strong>README</strong></a>
  ·
  <a href="../DEVELOP/SPEC/README.md"><strong>SPEC</strong></a>
  ·
  <a href="../DEVELOP/ARCHITECTURE.md"><strong>ARCHITECTURE</strong></a>
  ·
  <a href="../DEVELOP/CODING-RULE.md"><strong>CODING-RULE</strong></a>
  ·
  <a href="../CONTEXT.md"><strong>用語集</strong></a>
</p>

# Dive into Tepui 開発 WIKI

この WIKI は、**コードベースを「責務」と「データの流れ」から読むための案内書**です。個々のクラスや関数を網羅する API リファレンスではありません。コードの現在はコード自身が原本であり、この WIKI は「どの概念を、どの層・どのディレクトリ・どの順番で読めばよいか」を説明します。

> [!IMPORTANT]
> ゲームが**どう振る舞うべきか**は [SPEC](../DEVELOP/SPEC/README.md)、層・import・状態所有の規則は [ARCHITECTURE](../DEVELOP/ARCHITECTURE.md)、コードの書き方は [CODING-RULE](../DEVELOP/CODING-RULE.md) が正本です。この WIKI はそれらを置き換えません。

<p align="center">
  <img src="../.github/readme/codebase-map.svg" alt="Dive into Tepui のコードベース地図" width="100%">
</p>

## 章構成

| 章 | 内容 | まず読む場所 |
| --- | --- | --- |
| [01. アーキテクチャ](01-architecture.md) | 状態の層、正本、フレーム位相、命令と出来事 | `src/run/`, `src/game/game.ts` |
| [02. 物理・軌道力学](02-physics-orbits.md) | ECI、RK4、摂動、CR3BP、ラグランジュ点、接触 | `src/physics/` |
| [03. ゲームモデル](03-game-model.md) | 1ランの状態、ステージ、時間加速、予測、軌道計画 | `src/game/` |
| [04. 描画](04-rendering.md) | WebGPU、地球表面、大気、雲、オーロラ、線描画 | `src/render/` |
| [05. UI・入力・基準座標系](05-ui-input-frames.md) | HUD、ポインタ、カメラ、マップ、慣性系・回転系 | `src/hud/`, `src/input/`, `src/game/viewer/` |
| [06. 船体・戦闘](06-spacecraft-combat.md) | ShipAssembly、モジュール、ドッキング、射撃、被弾 | `src/game/ship/`, `src/game/combat/` |
| [07. 起動・保存・設定](07-launch-save-settings.md) | タイトル、ラン開始、スナップショット、設定 | `src/launcher/`, `src/settings/` |
| [08. 開発方針](08-development-workflow.md) | 文書の役割、ブランチ、規約、変更の進め方 | `AGENTS.md`, `DEVELOP/` |
| [09. テスト・ツール](09-testing-tooling.md) | テスト、境界検査、ラボ、生成ツール、CI | `tests/`, `tools/` |
| [10. 読み方・調査手順](10-reading-guides.md) | 目的別の読み順、所有者・呼び出し順の追い方 | リポジトリ全体 |

## このリポジトリを理解するための3つの軸

### 1. 「何の値か」より「捨てたら作り直せるか」

Dive into Tepui では、状態の置き場を機能名だけで決めません。位置・速度・燃料・損傷のように、捨てたら他から復元できない値はモデルの正本です。一方、軌道線、マーカー、GPU メッシュ、HUD の文字列のように正本から再生成できるものは導出側へ置きます。

この判定を理解すると、なぜ `render/` がゲーム状態を所有しないのか、なぜ表示設定とセーブ内の視点状態が別なのか、なぜ入力イベントがその場でゲーム状態を書き換えないのかが一本につながります。

### 2. 「ゲーム」と「表示」は同時に見えても同じ層ではない

画面には、宇宙船・軌道線・HUD・照準・天体・雲が同時に出ます。しかし内部では、物理状態、ゲーム上の意味、表示用の導出、GPU / DOM / Audio の装置を分けています。

典型的には次の向きで値が流れます。

```text
入力
 ↓
ゲームへの命令
 ↓
モデル進行
 ↓
表示状態の導出
 ↓
WebGPU / DOM / Audio
```

逆向きに「表示しているから世界の状態を変える」という流れを作らないのが基本です。

### 3. 1フレームを読むと全体が見える

巨大なリポジトリをディレクトリ順に読むより、まず `src/run/run.ts` から1フレームの順序を追う方が理解しやすくなります。

```text
interpretInput()
    ↓
Game.advance()
    ↓
カメラ・予測・表示状態の導出
    ↓
presentation.sync()
    ↓
presentation.render()
```

この一本を掴んでから、各段階で `game/`、`physics/`、`render/`、`hud/` へ降りるのが推奨です。

## コードベースの大区分

### `src/math/`

物理・ゲーム・描画のどれにも固有でない数学道具です。独自の `Vec3`、`Quat`、射影、幾何、探索、空間データ構造などがあります。ここへゲーム上の意味を持ち込まないことが重要です。

### `src/physics/`

軌道力学・剛体・接触・大気・熱・座標変換など、Three.js に依存しない物理計算です。ECI を基本座標として、時刻と状態から物理的な答えを返します。

### `src/game/`

一回のランの中身です。宇宙船、戦闘、ステージ、軌道計画、操作対象、予測、視点、ゲーム固有 HUD などが集まります。現在はモデルと一部の表示導出が同居しているため、内部を読むときは「正本か、導出か」を意識します。

### `src/render/`

Three.js / WebGPU の資源を所有します。地球表面、雲、大気、オーロラ、線、天体、VFX、タンパク質などを描画します。ゲーム上の意味を直接判断するより、与えられた表示状態を GPU 表現へ写す側です。

### `src/hud/`

DOM ベース UI の共通部品です。HUD ルート、オーバーレイ、ウィンドウ、ウィジェット、レイアウト、ポインタ操作などの「器」を提供します。

### `src/input/` と `src/audio/`

ブラウザの入力・音声装置との境界です。入力は生のキーやポインタを集め、音声は BGM / 効果音を出します。ゲーム意味への変換は上位層で行います。

### `src/settings/`

ランを跨いで共通するユーザー設定の正本です。描画品質、テーマ、BGM、表示トグルなどを保存し、変更を購読できる形で提供します。

### `src/launcher/`

ランの外側です。タイトル画面、ステージ選択、セーブスロット、スナップショット、結果画面、周回の開始と終了を扱います。

### `src/run/`

モデル・表示・装置を組み合わせて1ランを成立させる場所です。毎フレームの位相順序もここが持ちます。

## 目的別の最短ルート

### 軌道力学を理解したい

[02. 物理・軌道力学](02-physics-orbits.md) → `physics/dynamics.ts` → `physics/frame.ts` → `physics/elements.ts` → `game/plan/`

### 地球描画を理解したい

[04. 描画](04-rendering.md) → `render/earth-surface.ts` → `earth-surface-runtime.ts` → `atmosphere.ts` → `cloud/`

### 船の構造を理解したい

[06. 船体・戦闘](06-spacecraft-combat.md) → [CONTEXT.md](../CONTEXT.md) → `game/ship/` → `physics/ship-mass-properties.ts`

### マップの座標系を理解したい

[05. UI・入力・基準座標系](05-ui-input-frames.md) → `physics/frame.ts` → `game/map/` → `game/viewer/`

### 変更を実装したい

[08. 開発方針](08-development-workflow.md) → [CODING-RULE](../DEVELOP/CODING-RULE.md) → 必要なら [ARCHITECTURE](../DEVELOP/ARCHITECTURE.md) → 対象コード → [09. テスト・ツール](09-testing-tooling.md)

## WIKI の読み方

各章では、なるべく次の順で説明します。

1. **その分野が何を担当するか**
2. **どの値が正本か**
3. **他の層から何を受け、何を返すか**
4. **代表的な処理の流れ**
5. **コードを読む順番**
6. **変更時に壊しやすい境界**
7. **関連するテスト・ツール**

ファイル名は入口を示すために挙げますが、個々の識別子の完全な一覧は作りません。現状確認が必要な場合は、その時点のコードを検索してください。

---

<p align="center">
  <a href="../README.md"><strong>← README</strong></a>
  ·
  <a href="01-architecture.md"><strong>01. アーキテクチャ →</strong></a>
</p>
