<h1 align="center">Dive into Tepui</h1>

<p align="center">
  <strong>Orbital mechanics is the battlefield.</strong><br>
  <sub>軌道遷移・姿勢制御・会合・迎撃を、そのままゲームプレイにする WebGPU 3D orbital combat simulator.</sub>
</p>

<p align="center">
  <a href="https://mikanixonable.github.io/dive-into-tepui/"><strong>▶ Play in Browser</strong></a>
  ·
  <a href="#gameplay">Gameplay</a>
  ·
  <a href="#physics--simulation">Physics</a>
  ·
  <a href="#architecture">Architecture</a>
  ·
  <a href="#development">Development</a>
</p>

<p align="center">
  <a href="https://github.com/Mikanixonable/dive-into-tepui/actions/workflows/build.yml">
    <img alt="CI" src="https://github.com/Mikanixonable/dive-into-tepui/actions/workflows/build.yml/badge.svg">
  </a>
  <img alt="WebGPU" src="https://img.shields.io/badge/rendering-WebGPU-5A4FCF?logo=googlechrome&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript&logoColor=white">
  <img alt="Three.js" src="https://img.shields.io/badge/Three.js-0.185.1-black?logo=threedotjs&logoColor=white">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white">
  <img alt="Last commit" src="https://img.shields.io/github/last-commit/Mikanixonable/dive-into-tepui">
  <img alt="Repository size" src="https://img.shields.io/github/repo-size/Mikanixonable/dive-into-tepui">
</p>

<p align="center">
  <sub>Browser-first · WebGPU · TypeScript · orbital mechanics · scientific visualization</sub>
</p>

---

## At a glance

| | |
| --- | --- |
| **Runtime** | Browser / WebGPU |
| **Renderer** | Three.js WebGPU renderer + TSL |
| **Language** | TypeScript |
| **Simulation** | RK4, Kepler dynamics, perturbations, CR3BP, rigid-body attitude |
| **Game loop** | Target → plan → burn → time warp → rendezvous → engage |
| **Persistence** | Browser local storage + export |
| **Deployment** | GitHub Pages |
| **Quality gates** | ESLint, architecture boundary checks, typecheck, tests, build verification, browser smoke test |

<p align="center">
  <a href="#gameplay">Gameplay</a> ·
  <a href="#physics--simulation">Physics</a> ·
  <a href="#earth--rendering">Rendering</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#spacecraft-model">Spacecraft</a> ·
  <a href="#development">Development</a> ·
  <a href="#scientific-data--credits">Data & Credits</a>
</p>

> [!TIP]
> **すぐ遊ぶ:** [GitHub Pages 版を起動](https://mikanixonable.github.io/dive-into-tepui/) → ステージを選択 → ゲーム中に <kbd>H</kbd> で操作説明。WebGPU 対応ブラウザが必要です。

---

## Why Dive into Tepui?

<table>
<tr>
<td width="50%" valign="top">
<h3>🛰 Real orbital combat</h3>
<p>敵の現在位置へ直進するのではなく、<strong>速度ベクトルを変えて未来の軌道を交差させる</strong>ことが戦闘になります。時間加速、相対速度、会合、離脱まで含めて軌道そのものがゲームプレイです。</p>
</td>
<td width="50%" valign="top">
<h3>🎯 6-DoF spacecraft control</h3>
<p>機体座標系の並進と RCS による姿勢制御を分離。主推進、姿勢保持、ブースター、太陽電池、ラジエーターなどを状況に応じて扱います。</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<h3>🌍 Scientific Earth rendering</h3>
<p>地球表面・地形・大気・雲・海岸線・オーロラを別系統として扱い、NASA / NOAA / ERA5 などのデータを描画パイプラインへ取り込みます。</p>
</td>
<td width="50%" valign="top">
<h3>🧩 Composable spacecraft</h3>
<p>船体は単一モデルではなく、<code>cockpit</code> / <code>tank</code> / <code>thruster</code> / <code>dock</code> などの <strong>module instance と connection edge からなる接続グラフ</strong>として扱う方向で設計されています。</p>
</td>
</tr>
</table>

### Current capability map

| Area | Current state | Notes |
| --- | :---: | --- |
| Orbital combat | **Implemented** | relative motion, lead aiming, projectile combat |
| Time warp | **Implemented** | long orbital transfersを戦闘テンポへ圧縮 |
| Maneuver planning | **Implemented** | map view + maneuver nodes + Δv handles |
| Earth / atmosphere rendering | **Implemented / evolving** | surface streaming, atmosphere, clouds, aurora |
| Creative sandbox | **Implemented** | orbital elements / Lagrange-point based placement |
| Save / settings | **Implemented** | local storage, export, graphics/BGM/theme |
| Modular ShipAssembly | **Evolving** | graph-based modules, docking, construction model |
| Long-form cislunar progression | **Design direction** | NRHO → L1/L2 → LEO の長期構造 |

> [!IMPORTANT]
> README では、**現在コードに存在する機能**と、`memos/` で検討中の**設計方向**を分けて記述します。

---

## Quick start

<table>
<tr>
<td width="50%" valign="top">
<h3>▶ Play now</h3>
<p><a href="https://mikanixonable.github.io/dive-into-tepui/"><strong>Open the browser build</strong></a></p>
<p>WebGPU 対応の Chrome / Edge などで起動し、ステージを選択します。ゲーム内ヘルプは <kbd>H</kbd>。</p>
</td>
<td width="50%" valign="top">
<h3>⌘ Run locally</h3>
<pre><code>npm install
npm run dev</code></pre>
<p>Node.js 20 以上を推奨。開発サーバーが空きポートを自動選択します。</p>
</td>
</tr>
</table>

---

<a id="gameplay"></a>
## Gameplay

### Two scales of play

<table>
<tr>
<td width="50%" valign="top">
<h4>Combat view</h4>
<p>秒〜分の時間スケール。姿勢、推力、照準、RCS、弾薬、相対速度を直接操作します。</p>
</td>
<td width="50%" valign="top">
<h4>Map view</h4>
<p>分〜時間以上の時間スケール。軌道形状、会合、マニューバーノード、時間加速を扱います。</p>
</td>
</tr>
</table>

この2つを往復することが、通常の 6-DoF シューティングと大きく異なる点です。

### 基本ループ

```mermaid
flowchart LR
    A[Detect] --> B[Plan orbit]
    B --> C[Burn Δv]
    C --> D[Time warp]
    D --> E[Rendezvous]
    E --> F[Manage relative velocity]
    F --> G[Engage]
    G --> A
```

1. <kbd>T</kbd> で敵機をターゲットに選択
2. 機首・推力方向を調整し、敵の将来軌道へ接近
3. <kbd>,</kbd> / <kbd>.</kbd> で時間加速し、会合までの長距離移動を短縮
4. 必要なら <kbd>M</kbd> でマップビューを開き、マニューバーノードを編集
5. 相対速度を管理し、射撃可能な時間倍率へ戻す
6. 照準を合わせて <kbd>Space</kbd> または左クリックで射撃

### Game modes

| Mode | Description |
| --- | --- |
| **stage 00** | 弾薬を回収してから始まる、敵の波状攻撃から生き残る無限耐久サバイバル |
| **stage 0** | 周囲 5 km 以内の色分けされた敵集団を相手にする、120 秒の撃墜数スコアアタック |
| **stage 1** | 高度 420 km の地球低軌道戦域。近傍軌道の敵 5 機を撃破 |
| **stage 2** | 通常軌道とモルニヤ級高楕円軌道が混在する戦域。マップ上の軌道遷移計画が重要 |
| **CREATIVE** | 艦艇、敵、弾薬、燃料、基地などを軌道要素やラグランジュ点から自由に配置する実験モード |

### HUD / Map view

戦闘ビューでは `SHIP STATUS`、`ORBIT`、`TARGET`、`CONTACTS` と、機首・進行方向・ターゲット・リード照準のマーカーを表示します。マップビューでは天体、実軌道、予測軌道、マニューバーノードを俯瞰し、PRO / RET、NRM / ANM、IN / OUT の各方向へ Δv を編集できます。

<details>
<summary><strong>Controls — 機体・戦闘</strong></summary>

| Key | Action |
| --- | --- |
| <kbd>W</kbd> / <kbd>S</kbd> | 機体座標系の前進 / 後退 |
| <kbd>A</kbd> / <kbd>D</kbd> | 機体座標系の左 / 右 |
| <kbd>Q</kbd> / <kbd>E</kbd> | 機体座標系の上 / 下 |
| <kbd>I</kbd> / <kbd>K</kbd> | ピッチ下げ / 上げ |
| <kbd>J</kbd> / <kbd>L</kbd> | ヨー右 / 左 |
| <kbd>U</kbd> / <kbd>O</kbd> | ロール左 / 右 |
| <kbd>P</kbd> | RCS 回転制動 |
| <kbd>F</kbd> | 機首をプログレード方向へ向ける |
| <kbd>V</kbd> | 姿勢微調整モード |
| <kbd>C</kbd> | プログレード方向への姿勢保持 |
| <kbd>1</kbd>〜<kbd>4</kbd> | 並進推進の出力レベル |
| <kbd>T</kbd> | ターゲット選択 |
| <kbd>Z</kbd> | 照準ズーム |
| <kbd>Space</kbd> / 左クリック | 機関砲を発射（時間倍率 ×4 以下） |
| <kbd>R</kbd> | マニュアル装填 / 決着画面では再出撃 |
| <kbd>5</kbd> / <kbd>6</kbd> | ブースター分離 / 点火・停止 |
| <kbd>7</kbd> / <kbd>8</kbd> | 左右の太陽電池パドルを展開・収納 |
| <kbd>9</kbd> / <kbd>0</kbd> | 左右のラジエーターを展開・収納 |

</details>

<details>
<summary><strong>Controls — 時間・マップ</strong></summary>

| Key | Action |
| --- | --- |
| <kbd>,</kbd> / <kbd>.</kbd> | 時間加速を 1 段下げる / 上げる |
| <kbd>N</kbd> | 次のマニューバーノードまで自動ワープ |
| <kbd>M</kbd> | 戦闘ビュー / マップビュー |
| <kbd>W</kbd> / <kbd>S</kbd> | ノードの Δv を PRO / RET 方向へ調整 |
| <kbd>A</kbd> / <kbd>D</kbd> | ノードの Δv を NRM / ANM 方向へ調整 |
| <kbd>Q</kbd> / <kbd>E</kbd> | ノードの Δv を IN / OUT 方向へ調整 |
| <kbd>X</kbd> | 選択中のノード、または計画全体を削除 |

マップビューでは計画軌道をクリックしてノードを配置し、円形ハンドルで実行時刻、Δv ハンドルで各推進成分を直接編集できます。

</details>

<details>
<summary><strong>Controls — カメラ・画面・保存</strong></summary>

| Key / gesture | Action |
| --- | --- |
| 矢印キー | カメラのヨー / ピッチ |
| <kbd>Num0</kbd> / <kbd>Num1</kbd>（<kbd>/</kbd> / <kbd>_</kbd>） | カメラのロール |
| <kbd>G</kbd> | カメラを機体姿勢へ追従 |
| ドラッグ | カメラ回転 |
| 二本指ドラッグ / 中ボタンドラッグ | 視点パン |
| ピンチ / ホイール | ズーム。二本指のひねりはロール |
| ダブルタップ / ダブルクリック | 対象へフォーカス |
| <kbd>H</kbd> | 操作説明 |
| <kbd>ESC</kbd> | ポーズ・設定 |
| <kbd>F3</kbd> | デバッグ情報 |
| <kbd>F5</kbd> | 手動セーブ |
| <kbd>F9</kbd> | セーブデータ画面 |

</details>

---

<a id="physics--simulation"></a>
## Physics & Simulation

ゲームプレイの下には、THREE.js に依存しない軌道力学・物理層があります。

| System | Implementation |
| --- | --- |
| **Orbit propagation** | RK4 数値積分、Kepler 軌道・外挿、軌道要素 |
| **Gravity** | 点質量重力 + J2 / C22 |
| **Three-body dynamics** | CR3BP、ラグランジュ点、Halo orbit 関連ユーティリティ |
| **Environment** | 大気抵抗、太陽放射圧、日照・遮蔽 |
| **Atmospheric entry** | 空力荷重、加熱、燃え尽き |
| **Attitude** | 姿勢状態、RCS と剛体回転のための物理処理 |
| **Contact** | 球・円筒・複合形状の接触判定と衝突応答 |
| **Combat** | リード照準、射撃 AI、実体弾 |

主要実装は `src/physics/` にあり、`cr3bp.ts`、`halo.ts`、`lagrange.ts`、`kepler-orbit.ts`、`elements.ts`、`dynamic-trajectory.ts`、`thermal.ts`、`srp.ts` などに分離されています。

---

<a id="earth--rendering"></a>
## Earth & Rendering

描画は Three.js の WebGPU renderer を中心に構成されています。地球表現は単一テクスチャではなく、地表ストリーミング、大気、雲、海岸線、オーロラ、airglow などを別の系として扱います。

```mermaid
flowchart LR
    D[Earth / climate data] --> P[Offline processing]
    P --> T[Surface tiles / terrain]
    T --> Q[Request queue]
    Q --> C[Resident cache / page table]
    C --> G[GPU material / TSL]
    G --> E[Earth surface]
    A[Atmosphere] --> F[Final Earth view]
    CL[Cloud system] --> F
    AU[Aurora / airglow] --> F
    E --> F
```

<details>
<summary><strong>Rendering building blocks</strong></summary>

- Earth surface tile streaming / residency
- terrain decode worker
- page-table based GPU lookup
- atmosphere / airglow
- cloud rendering
- aurora field
- blue-noise utilities
- ray marching
- blackbody / thermal emissive rendering
- schematic / map-oriented rendering paths

</details>

`src/render/` には WebGPU / TSL の描画コードに加えて、地球表面タイル、GPU page table、worker decode、blue noise、ray marching、熱放射などの実験・実装が含まれています。

---

## World / Design direction

> **公暦 20115 年。** 長い月面定住を経た人類は、生命維持に必要な軽元素・微量元素の供給制約に直面している。地球近傍には自動兵器群が残り、地球低軌道は資源地帯であると同時に戦場になった。

現在のゲームデザインでは、NRHO から L1 / L2、そして LEO へ進出し、資源・生産設備・宇宙農場を拡張していく長期構造が検討されています。ペプチドをモチーフにした自動兵器や「執政官の結晶」などの世界設定も設計メモで検討中です。

> [!NOTE]
> この節は実装済みゲームルールの一覧ではなく、`memos/` で検討されている長期的なゲームデザインの方向性です。

---

## Design principles

<table>
<tr>
<td width="33%" valign="top">
<h3>1. Simulation owns truth</h3>
<p>位置・速度・燃料・HP など、捨てたら再構築できない値はモデル側が所有します。</p>
</td>
<td width="33%" valign="top">
<h3>2. Presentation is derived</h3>
<p>軌道線、マーカー、HUD 表示などは正本から毎フレーム導出できる値として扱います。</p>
</td>
<td width="33%" valign="top">
<h3>3. Devices stay dumb</h3>
<p>render / HUD / audio はゲーム意味をできるだけ知らず、そのフレームに出すべき宣言を受け取ります。</p>
</td>
</tr>
</table>

この分離により、時間加速・セーブ・予測軌道・複数の表示経路が同じゲーム状態を参照しても、状態の書き手を追跡しやすくします。

---

<a id="architecture"></a>
## Architecture

このプロジェクトでは「何を表示するか」と「ゲーム世界で何が起きたか」を分離します。捨てても再生成できない値をモデルの**正本**、毎フレーム作り直せる表示状態を導出値として扱います。

```mermaid
flowchart TD
    I[Keyboard / Pointer] --> ID[Input interpretation]
    ID --> Q[Command Queue]
    Q --> G[Game model / Simulation]
    P[physics/] --> G
    G --> PR[Presentation derivation]
    PR --> R[render/]
    PR --> H[HUD / Marker / Audio declarations]
    R --> W[WebGPU]
    H --> O[DOM / Audio]
```

1 フレームは大きく次の 4 位相で進みます。

```text
Input interpretation
        ↓
Simulation / model update
        ↓
Presentation derivation & synchronization
        ↓
Render
```

設計規約の一次情報は [DEVELOP/ARCHITECTURE.md](DEVELOP/ARCHITECTURE.md)、ゲーム仕様は [DEVELOP/SPEC/](DEVELOP/SPEC/) にあります。SPEC は現状コードの説明ではなく、**「本来どう振る舞うべきか」をコードより先に記述する場所**として運用されています。

### Repository map

```text
src/
├─ math/       汎用数学・幾何・数値処理
├─ physics/    軌道力学・物理。Three.js 非依存
├─ game/       1ランの状態、ルール、表示導出
├─ render/     Three.js / WebGPU 資源と描画
├─ hud/        HUD の器・共通 UI
├─ input/      生のキーボード / ポインタ入力
├─ audio/      音声出力
├─ settings/   セーブを跨ぐユーザー設定
├─ launcher/   ステージ・セーブ・ランのライフサイクル
├─ run/        フレーム処理の組み立て
└─ main.ts     アプリ起動
```

---

<a id="spacecraft-model"></a>
## Spacecraft model

船体は **ShipAssembly** として扱い、module instance を node、構造接続・ドッキング接続などを edge とする接続グラフで表現します。

```mermaid
graph LR
    C[Cockpit] --- T1[Main tank]
    T1 --- TH[Thruster]
    T1 --- D[Dock]
    T1 --- S[Solar panel]
    T1 --- R[Radiator]
    D -. docking .- X[Another assembly]
```

健全な cockpit を失った接続グラフも即座には消滅せず、「物資」として物理世界に残ります。ドッキング後は複数の船を特別な親子関係で保持するのではなく、原則として一つの統合された ShipAssembly として扱う設計です。

用語と船体構造の設計は [CONTEXT.md](CONTEXT.md) を参照してください。

---

## Save & Settings

セーブデータはブラウザのローカルストレージに保存されます。出撃時およびプレイ中に自動保存され、<kbd>F5</kbd> で手動保存、<kbd>F9</kbd> で管理画面を開けます。

ブラウザのサイトデータ削除や環境変更で失われる可能性があるため、必要に応じてセーブデータ管理画面からエクスポートしてください。設定画面ではグラフィックス、BGM、テーマを変更できます。

---

<a id="development"></a>
## Development

### Where should I start?

| If you want to… | Start here |
| --- | --- |
| 軌道・重力・姿勢の計算を見る | `src/physics/` |
| ゲーム進行・戦闘・船を見る | `src/game/` |
| WebGPU / TSL / 地球描画を見る | `src/render/` |
| HUD の共通部品を見る | `src/hud/` |
| 1フレームの処理順を追う | `src/run/` → `src/main.ts` |
| 本来のゲーム仕様を確認する | `DEVELOP/SPEC/` |
| 層・import・正本の規則を確認する | `DEVELOP/ARCHITECTURE.md` |
| 命名・コメント・テスト規約を見る | `DEVELOP/CODING-RULE.md` |
| 進行中の設計検討を見る | `memos/` |

### Documentation model

```mermaid
flowchart LR
    S[SPEC<br/>How it should behave] --> I[Implementation]
    A[ARCHITECTURE<br/>Where it belongs] --> I
    C[CODING RULE<br/>How it is written] --> I
    I --> T[Tests / checks]
```

`DEVELOP/SPEC/` はコードの現状を追認する文書ではありません。未実装の仕様が残ることを許容し、**意図をコードより先に置く**運用です。

### Requirements

- WebGPU 対応ブラウザ（最新版 Chrome / Edge など）
- Node.js 20 以上を推奨
- 地球表面データを読み込むためのネットワーク接続

### Run locally

```bash
npm install
npm run dev
```

開発サーバーが表示する URL をブラウザで開いてください。使用可能なポートが自動的に選ばれるため、常に `8080` とは限りません。

### Build

```bash
npm run build
```

生成物は `docs/` に出力されます。

### Useful commands

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | TypeScript 型チェック |
| `npm run test` | 全テスト |
| `npm run test:physics` | 物理層のテスト |
| `npm run test:math` | 数学層のテスト |
| `npm run test:game` | ゲーム層のテスト |
| `npm run test:render` | 描画層のテスト |
| `npm run lint` | ESLint |
| `npm run check:boundaries` | アーキテクチャ境界チェック |
| `npm run ci` | CI 相当の総合チェック |
| `npm run render-lab` | 描画実験環境 |
| `npm run cloud-lab` | 雲の実験環境 |
| `npm run bgm-lab` | BGM 試聴環境 |

CI では lint、境界検査、型チェック、各種データ検証、テスト、Earth surface contract、production build、release verification、browser smoke test まで実行します。

### Labs & tooling

| Lab / tool | Purpose |
| --- | --- |
| `render-lab` | 描画だけを切り出して比較・検証 |
| `cloud-lab` | 雲モデルの独立実験 |
| `bgm-lab` | BGM の試聴 |
| `earth-surface:*` | 地球データの取得・bake・package・配信契約テスト |
| `protein:*` | タンパク質構造データの取得・生成・検証 |
| `orbits:fetch` / `export-lagrange-orbits` | 軌道カタログ・ラグランジュ軌道データ |
| `render-lab:compare` / `cloud-lab:compare` | 描画結果の比較 |

### Quality gates

```mermaid
flowchart LR
    L[Lint] --> B[Boundary check]
    B --> T[Typecheck]
    T --> V[Data validation]
    V --> U[Unit / subsystem tests]
    U --> E[Earth-surface contract]
    E --> P[Production build]
    P --> R[Release verification]
    R --> S[Browser smoke]
```

> [!NOTE]
> `npm run ci` は「コンパイルできるか」だけでなく、アーキテクチャ境界・データ生成物・リリース成果物・ブラウザ起動までまとめて検査します。

---

<a id="scientific-data--credits"></a>
## Scientific data & Credits

| Data | Source / use |
| --- | --- |
| **Planet textures** | Solar System Scope — CC BY 4.0 |
| **Phobos / Io / Europa / Ganymede / Callisto / Titan** | USGS Astrogeology Science Center の全球モザイク |
| **Earth surface / terrain / climate** | NASA Earth Observatory、NOAA NCEI ETOPO、Copernicus Climate Change Service / ERA5 |
| **Coastlines** | Natural Earth および関連収録データ |
| **Protein structures** | RCSB Protein Data Bank |

配信量削減のため、月面と雲の一部テクスチャは縮小・加工して収録しています。各データの詳しい利用条件は配布元のライセンスと `assets-src/` 内の出典情報を確認してください。

---

## Known limitations

- WebGPU 非対応ブラウザでは起動できません。
- 地球表面の高精細データは実行時に読み込むため、初回起動や低速回線では表示に時間がかかることがあります。
- ステージ、CREATIVE、船体構築などには開発中の要素が含まれます。
- セーブデータはブラウザ単位です。

<hr>

<p align="center">
  <strong>Explore the project</strong><br>
  <a href="https://mikanixonable.github.io/dive-into-tepui/">Play</a>
  ·
  <a href="DEVELOP/SPEC/">Specifications</a>
  ·
  <a href="DEVELOP/ARCHITECTURE.md">Architecture</a>
  ·
  <a href="CONTEXT.md">Domain vocabulary</a>
  ·
  <a href="memos/">Design memos</a>
</p>

<p align="center">
  <a href="https://mikanixonable.github.io/dive-into-tepui/"><strong>Launch Dive into Tepui →</strong></a>
</p>
