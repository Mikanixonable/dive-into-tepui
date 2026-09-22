<h1 align="center">Dive into Tepui</h1>

<p align="center">
  <strong>Orbital mechanics is the battlefield.</strong><br>
  <sub>軌道遷移・姿勢制御・会合・迎撃を、そのままゲームプレイにする WebGPU 3D 軌道力学シューティング。</sub>
</p>

<p align="center">
  <a href="https://mikanixonable.github.io/dive-into-tepui/"><strong>▶ Play in Browser</strong></a>
  ·
  <a href="#gameplay">Gameplay</a>
  ·
  <a href="#orbital-maneuvering">Maneuvering</a>
  ·
  <a href="#earth-rendering">Rendering</a>
  ·
  <a href="#development">Development</a>
</p>

<p align="center">
  <a href="https://github.com/Mikanixonable/dive-into-tepui/actions/workflows/build.yml">
    <img alt="CI" src="https://github.com/Mikanixonable/dive-into-tepui/actions/workflows/build.yml/badge.svg">
  </a>
  <img alt="WebGPU" src="https://img.shields.io/badge/WebGPU-ff3155?logo=googlechrome&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3478ff?logo=typescript&logoColor=white">
  <img alt="Three.js" src="https://img.shields.io/badge/Three.js-0.185.1-0e1014?logo=threedotjs&logoColor=white">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-48506a?logo=nodedotjs&logoColor=white">
  <img alt="Last commit" src="https://img.shields.io/github/last-commit/Mikanixonable/dive-into-tepui?color=ff6b82">
</p>

<p align="center">
  <img src=".github/readme/hero-orbit.svg" alt="Dive into Tepui orbital combat overview" width="100%">
</p>

## At a glance

| | |
| --- | --- |
| **Runtime** | Browser / WebGPU |
| **Renderer** | Three.js WebGPU renderer + TSL |
| **Language** | TypeScript |
| **Simulation** | RK4, Kepler dynamics, degree-2 gravity, drag, SRP, rigid-body attitude |
| **Navigation** | Maneuver nodes, Lagrange points, inertial / rotating reference frames |
| **Persistence** | Browser local storage + export |
| **Deployment** | GitHub Pages |

> [!TIP]
> [GitHub Pages 版を起動](https://mikanixonable.github.io/dive-into-tepui/)し、ステージを選択してください。ゲーム中は <kbd>H</kbd> で操作説明を表示できます。

---

<a id="gameplay"></a>
## Gameplay

<p align="center">
  <img src=".github/readme/gameplay-loop.svg" alt="Target, maneuver, time warp, rendezvous and combat gameplay loop" width="100%">
</p>

戦闘ビューでは姿勢・推力・照準を直接操作し、マップビューでは軌道・マニューバーノード・時間加速を扱います。**近距離戦と軌道遷移が同じゲーム状態の上で連続しています。**

### Game modes

| Mode | Description |
| --- | --- |
| **stage 00** | 弾薬を回収してから始まる無限耐久サバイバル |
| **stage 0** | 周囲 5 km の敵を相手にする 120 秒スコアアタック |
| **stage 1** | 高度 420 km の LEO で近傍軌道の敵 5 機を撃破 |
| **stage 2** | 通常軌道と高楕円軌道が混在する戦域 |
| **CREATIVE** | 軌道要素・ラグランジュ点などを使って物体を配置するサンドボックス |

---

<a id="orbital-maneuvering"></a>
## Orbital maneuvering

<p align="center">
  <img src=".github/readme/maneuver-navigation.svg" alt="Maneuver nodes for low orbit transfers and Lagrange-point navigation" width="100%">
</p>

マニューバーノードは噴射後の状態と実行時刻を持ち、**PRO / RET、NRM / ANM、IN / OUT** の3軸で Δv を編集できます。L1〜L5 は二天体系の回転座標から ECI 状態へ変換され、ナビゲーションやマップ表示の基準として使われます。

自動で最適遷移を生成するのではなく、プレイヤーが予測軌道を見ながらノードを置いて軌道を組み立てます。

---

## Spacecraft assembly

<p align="center">
  <img src=".github/readme/ship-assembly.svg" alt="Graph-based spacecraft assembly" width="100%">
</p>

船体は **ShipAssembly** として、module instance と connection edge のグラフで保持されます。cockpit、tank、thruster、RCS、weapon、dock、solar panel、radiator、booster などが個別の状態を持ちます。

ドッキングした船体は統合された assembly として扱われ、燃料・損傷・展開状態などもモジュール単位で保存されます。

---

## Rendezvous & combat

<p align="center">
  <img src=".github/readme/combat-rendezvous.svg" alt="Relative motion, lead aiming and projectile combat" width="100%">
</p>

敵との交戦では距離だけでなく**相対速度**が重要です。ターゲット運動と弾速からリード点を求め、実体弾を発射します。射撃は高倍率の時間加速中には行えません。

---

<a id="earth-rendering"></a>
## Earth rendering

<p align="center">
  <img src=".github/readme/earth-rendering.svg" alt="Earth surface and atmospheric rendering layers" width="100%">
</p>

地球は一枚の画像ではなく、**surface tiles / terrain / atmosphere / clouds / airglow / aurora / illumination** を別系統として構成します。地表はタイル要求・resident cache・page table を経て GPU material へ渡されます。

描画側には WebGPU / TSL、ray marching、blue noise、熱放射、雲の複数描画経路などの独立した実装があります。

---

## Orbit dynamics

<p align="center">
  <img src=".github/readme/orbital-perturbations.svg" alt="Orbital perturbations including J2, C22, atmospheric drag and solar radiation pressure" width="100%">
</p>

軌道伝播は単純な二体問題だけではありません。点質量重力に加えて **J2 / C22 の2次重力場、多体重力、大気抵抗、太陽放射圧、日照・遮蔽**を扱います。地球では主に J2、非軸対称性を持つ天体では C22 も評価できます。

大気圏では空力荷重・加熱・燃え尽きも計算します。物理計算は `src/physics/` に分離され、Three.js に依存しません。

---

## Orbital UI & reference frames

<p align="center">
  <img src=".github/readme/orbital-ui.svg" alt="Orbital map UI with inertial and rotating reference frames" width="100%">
</p>

マップビューは表示原点と回転を分けて選択でき、**慣性系、公転回転系、自転系**を扱います。軌道線は各サンプル時刻で座標変換されるため、回転する基準系でも時間変化を保ったまま表示できます。

同じ画面上でラグランジュ点、予測軌道、マニューバーノード、Δv gizmo を確認できます。

---

## Controls

<details>
<summary><strong>Flight & combat</strong></summary>

| Key | Action |
| --- | --- |
| <kbd>W</kbd> / <kbd>S</kbd> | 前進 / 後退 |
| <kbd>A</kbd> / <kbd>D</kbd> | 左 / 右並進 |
| <kbd>Q</kbd> / <kbd>E</kbd> | 上 / 下並進 |
| <kbd>I</kbd> / <kbd>K</kbd> | Pitch |
| <kbd>J</kbd> / <kbd>L</kbd> | Yaw |
| <kbd>U</kbd> / <kbd>O</kbd> | Roll |
| <kbd>P</kbd> | RCS 回転制動 |
| <kbd>F</kbd> | Prograde |
| <kbd>C</kbd> | Prograde hold |
| <kbd>1</kbd>〜<kbd>4</kbd> | 推力レベル |
| <kbd>T</kbd> | ターゲット選択 |
| <kbd>Z</kbd> | 照準ズーム |
| <kbd>Space</kbd> / 左クリック | 射撃 |
| <kbd>5</kbd> / <kbd>6</kbd> | ブースター分離 / 点火 |
| <kbd>7</kbd> / <kbd>8</kbd> | 太陽電池パドル |
| <kbd>9</kbd> / <kbd>0</kbd> | ラジエーター |

</details>

<details>
<summary><strong>Orbit & map</strong></summary>

| Key | Action |
| --- | --- |
| <kbd>,</kbd> / <kbd>.</kbd> | 時間倍率を下げる / 上げる |
| <kbd>N</kbd> | 次のマニューバーノードまでワープ |
| <kbd>M</kbd> | Combat / Map view |
| <kbd>W</kbd> / <kbd>S</kbd> | Δv: PRO / RET |
| <kbd>A</kbd> / <kbd>D</kbd> | Δv: NRM / ANM |
| <kbd>Q</kbd> / <kbd>E</kbd> | Δv: IN / OUT |
| <kbd>X</kbd> | ノード / 軌道計画を削除 |

</details>

<details>
<summary><strong>Camera & save</strong></summary>

| Key / gesture | Action |
| --- | --- |
| 矢印キー / ドラッグ | カメラ回転 |
| 二本指 / 中ボタンドラッグ | Pan |
| ピンチ / ホイール | Zoom |
| ダブルタップ / ダブルクリック | Focus |
| <kbd>G</kbd> | 機体姿勢へ追従 |
| <kbd>H</kbd> | 操作説明 |
| <kbd>ESC</kbd> | ポーズ / 設定 |
| <kbd>F3</kbd> | デバッグ情報 |
| <kbd>F5</kbd> | 手動セーブ |
| <kbd>F9</kbd> | セーブ管理 |

</details>

---

## Runtime structure

<p align="center">
  <img src=".github/readme/runtime-structure.svg" alt="Simulation, game model, presentation and rendering structure" width="100%">
</p>

物理・ゲーム状態を正本とし、HUD・軌道線・マーカーなどはそこから導出します。描画や DOM がゲーム状態の所有者にならないよう、フレーム処理は概ね **Input → Simulation → Presentation → Render** の順に進みます。

### Repository map

```text
src/
├─ math/       数学・幾何・数値処理
├─ physics/    軌道力学・物理
├─ game/       ゲーム状態・戦闘・船・軌道計画
├─ render/     Three.js / WebGPU 描画
├─ hud/        共通 UI
├─ input/      入力
├─ audio/      音声
├─ settings/   ユーザー設定
├─ launcher/   ステージ / セーブ
└─ run/        フレーム処理
```

---

<a id="development"></a>
## Development

### Run locally

```bash
npm install
npm run dev
```

Node.js 20 以上、WebGPU 対応ブラウザを推奨します。

### Useful commands

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | TypeScript 型チェック |
| `npm run test` | 全テスト |
| `npm run test:physics` | 物理テスト |
| `npm run test:game` | ゲームテスト |
| `npm run test:render` | 描画テスト |
| `npm run lint` | ESLint |
| `npm run check:boundaries` | アーキテクチャ境界検査 |
| `npm run render-lab` | 描画実験環境 |
| `npm run cloud-lab` | 雲の実験環境 |
| `npm run bgm-lab` | BGM 試聴環境 |
| `npm run ci` | 総合検証 |

CI は UI style、lint、境界検査、型チェック、テスト、Earth surface contract、外部地表データ、production build などを検査します。

---

## Scientific data & credits

| Data | Source / use |
| --- | --- |
| **Planet textures** | Solar System Scope — CC BY 4.0 |
| **Planetary mosaics** | USGS Astrogeology Science Center |
| **Earth surface / terrain / climate** | NASA Earth Observatory、NOAA NCEI ETOPO、ERA5 |
| **Coastlines** | Natural Earth |
| **Protein structures** | RCSB Protein Data Bank |

---

## Known limitations

- WebGPU 非対応ブラウザでは起動できません。
- 地球表面の高精細データは実行時に読み込みます。
- セーブデータはブラウザのローカルストレージに保存されます。

<p align="center">
  <a href="https://mikanixonable.github.io/dive-into-tepui/"><strong>Launch Dive into Tepui →</strong></a>
</p>
