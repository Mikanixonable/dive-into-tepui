# 宇宙船モジュール形状のリアル化 — 実装計画

> **状態 — 完了 / 2026-09-23 整理:** 本文末尾の「実施結果」にあるとおり、主要船体モジュールの GLB 化、側面装備の対称配置、契約テスト・型検査・render-lab 確認まで実施済み。このファイルは実装計画の履歴として `done/` に移す。追加のモジュール形状改善は新しい計画として扱う。


## 概要

現在の宇宙船モジュールは `tools/model-builder/ship-modules.mjs` で THREE.js プリミティブ
（CylinderGeometry, TorusGeometry, ConeGeometry, BoxGeometry）を組み合わせて生成している。
各モジュールの見た目はシンプルな円柱＋エンドリング程度で、実在の宇宙船と比べるとディテールが不足している。

**目標**: Blender で作成した glTF モデルを導入し、ISS・ソユーズ・ジェミニ・マーキュリー等の実在の
宇宙船を参考にした、説得力のある形状にする。第1段階では cockpit, tank, thruster, booster の
主要4種を対象とし、残りは段階的に拡大する。頂点数制約は緩和してよい。

## 現状の構成

### パイプライン

```
ship-modules.mjs (THREE.js プリミティブ組み立て)
  → export-models.mjs (toJSON() シリアライズ、材質統合)
    → src/assets/models/shipModules.json (焼き込み済み)
      → ship-module-models.ts (ObjectLoader でパース、template 共有)
        → ship-module-view.ts (instance ごとに material clone)
```

### 既存モジュール一覧と現状の形状

| モジュール | modelId | 現状の形状 |
|---|---|---|
| コックピット | `cockpit-standard` | 円柱 + 端リング + 窓（小さい円柱） |
| 主燃料タンク 3/6/12m | `tank-{3,6,12}-main` | 円柱 + 端リング + タンクバンド |
| RCSタンク 3/6/12m | `tank-{3,6,12}-rcs` | 同上（色違い） |
| 主推進器 | `thruster-standard` | 円柱 + コーン（ノズルベル） |
| ブースター | `booster-standard` | 円柱 + コーン（ノズルベル） |
| RCSスラスター | `rcs-standard` | 円柱 + 4方向アンカー |
| 機関砲 | `weapon-gatling` | 円柱 + 2本のバレル |
| 装甲 | `armor-standard` | やや太い円柱 |
| ラジエーター | `radiator-standard` | 細い円柱 + 6枚蛇腹パネル |
| 太陽電池 | `solar-panel-standard` | 細い円柱 + 3枚パネル |
| ドッキングポート | `docking-port-standard` | 円柱 + インターフェースリング |
| 建造ドック | `dock-standard` | 同上（色違い） |
| デカプラー | `decoupler-standard` | 同上 |

### 契約（テストで固定されている不変条件）

`tests/render/ship-module-asset.test.ts` が固定する契約:

1. カタログの全 `modelId` が独立した等倍 Group を持つ
2. 全 module の接続面（`connection:aft`, `connection:forward`）は定義長の ±Z に一致
3. 能力を持つ module は対応する semantic anchor を保つ（thrust, rcs:, muzzle:, belt, panel-hinge, docking-port, construction-dock, decoupler）
4. 展開部品は実寸に対応する枚数と幅を持つ
5. instance は geometry を共有し material だけを分離する

### 物理形状との関係

`ship-module-definition.ts` の `solidPrimitives`（`LocalCappedCylinder`）が物理の接触判定を
担う。描画モデルの形状はこれと独立しているが、SPEC は「見えている固体へ当たるものがすり抜けず、
何もない空間で止まらない」を求めている。描画が精細になっても物理プリミティブは円柱近似のままで
問題ないが、突出した設備（ノズルベル、アンテナ等）が大きく円柱からはみ出す場合は、
`solidPrimitives` に追加のプリミティブを足すことを検討する。

## 実在の宇宙船から取り入れるディテール

### 参考資料

| 実在の宇宙機 | 参考にする要素 | 適用先モジュール |
|---|---|---|
| **ISS モジュール** (Unity, Zarya, Destiny) | 外壁のリブ・配管・ハンドレール、CBM ポート形状、MLI（多層断熱材）の質感 | cockpit, tank |
| **ソユーズ / プログレス** | 球形軌道モジュール、円錐の降下モジュール、サービスモジュールの形状遷移 | cockpit |
| **ジェミニ** | 台形窓、シングル外殻、テーパー形状 | cockpit |
| **マーキュリー** | ベル型カプセル、波板外殻、アブレータ | cockpit |
| **HTV (こうのとり)** | 円筒与圧部 + 非与圧部の構成、外壁パネルライン | tank |
| **Dragon (SpaceX)** | トランク部のソーラーパネル配置、カプセルのヒートシールド | cockpit, solar_panel |
| **実在のロケットエンジン** (RL-10, RD-180 等) | ノズルベルの曲線（放物線プロファイル）、ジンバル機構、配管 | thruster, booster |
| **SRB (固体ロケットブースター)** | ノーズコーン、分離モーター位置、スカート | booster |

### モジュール別のデザイン方針

#### cockpit (第1段階)
- **ソユーズ降下モジュール風のテーパー**: 前端は直径がやや絞れ、窓は台形にする
- **ISS ノード風の外壁ディテール**: リブ（縦横の構造リブ）、ハンドレール、MLI テクスチャ感を
  形状で表現（平面にわずかな突起を付けた多角形パネル）
- **ジェミニ風の窓**: 前面に台形の窓を2つ配置
- **接続面**: 既存の ±Z anchor は維持。CBM 風のフランジリングを端面に付ける

#### tank (第1段階)
- **ISS モジュール風の外壁**: パネルライン（浅い溝で表現）、配管・ケーブルトレイ（外壁に沿う
  小径円柱）、ハンドレール
- **HTV 風の区画構造**: 3m タンクは単純な円柱、6m 以上は中央にバルクヘッドの暗示（リングの内側）
- **主燃料とRCSの視覚的区別を強化**: RCS タンクは球形に近いドーム端面、主燃料は平端面

#### thruster (第1段階)
- **RL-10 / RL-25 風のノズルベル**: 現在の単純なコーンを、ベル曲線（放物線に近い形）の
  回転体に置き換え。ノズルスカートのリブを低ポリゴンで表現
- **ジンバル機構の暗示**: ノズル根元にアクチュエータ風のブラケット
- **ターボポンプ・配管**: エンジン上部にタービン排気管風の突起

#### booster (第1段階)
- **SRB 風のノーズコーン**: 前端を円錐キャップに
- **分離モーター位置の暗示**: 前端付近に小さなノズル形状
- **スカート**: 後端にスカートリング（直径がやや広がる）
- **ノズルベルは thruster と同様**だが直径がやや大きい

## 実装方針

### glTF 導入パイプライン

```
[Blender] ── (.glb/.gltf) ──→ assets-src/ship-modules/
                                     │
                                     ▼
                    tools/model-builder/ship-modules.mjs
                    (GLTFLoader で読み込み → semantic anchor 追加
                     → 材質の MeshStandardMaterial 化 → Group 組み立て)
                                     │
                                     ▼
                    tools/model-builder/export-models.mjs
                    (既存の toJSON() パイプライン — 変更不要)
                                     │
                                     ▼
                    src/assets/models/shipModules.json
                    (既存のランタイム読み込み — 変更不要)
```

#### なぜこの方式か

- **既存パイプラインとの整合**: `export-models.mjs` の `mergeStaticChildren` → `toJSON()`
  → `ObjectLoader` の流れはそのまま使える。glTF → THREE.Object3D への変換を
  `ship-modules.mjs` で行うだけで、下流に変更が波及しない。
- **semantic anchor の維持**: glTF モデル自体にアンカーを含める（Blender の Empty オブジェクト）
  か、`ship-modules.mjs` でプログラム的に追加するかを選べる。
- **テストの契約をそのまま維持**: modelId, anchor 位置, パネル枚数・幅の契約は glTF 導入後も
  同じテストで検証する。

### ship-modules.mjs の変更

現在の `addKindDetails()` をモジュール種別ごとに分岐:

```
if (glTFモデルが assets-src/ に存在する)
  → glTF を読み込み、スケーリング・回転を合わせる
  → semantic anchor が glTF 内の Empty として含まれていなければ追加する
else
  → 現在のプリミティブ生成（フォールバック）
```

これにより、glTF がまだ作られていないモジュール種別は現行のプリミティブ生成がそのまま動く。
段階的な移行が可能。

### Blender ワークフロー規約

#### ファイル配置
```
assets-src/ship-modules/
  cockpit-standard.glb
  tank-3-main.glb
  tank-6-main.glb
  tank-12-main.glb
  tank-3-rcs.glb
  tank-6-rcs.glb
  tank-12-rcs.glb
  thruster-standard.glb
  booster-standard.glb
  ...
```

#### Blender 側の規約
- **座標系**: 長手軸 +Z、原点は module 中心（length/2 の位置）
- **スケール**: 1 unit = 1 m（メートル単位）
- **Semantic anchor**: Blender の Empty オブジェクトを `anchor:名前` で配置
  - `anchor:connection:aft` — 後端接続面（z = -length/2）
  - `anchor:connection:forward` — 前端接続面（z = +length/2）
  - `anchor:thrust` — スラスト噴射位置（thruster/booster のみ）
  - `anchor:rcs:x,y` — RCS ノズル位置（rcs のみ）
  - etc.
- **マテリアル**: MeshStandardMaterial 互換の PBR 設定
  - `flatShading: true` は export 時にコードで設定（Blender 側では smooth shading でOK、
    ただし AutoSmooth の角度を意図的に設定）
  - 金属面は metalness = 1、塗装・断熱材は metalness = 0
- **メッシュ統合**: 同一マテリアルの静的メッシュは Blender 側で結合しておくか、
  `export-models.mjs` の `mergeStaticChildren` に任せる
- **可動部**: ラジエーター蛇腹、太陽電池パネルなどの可動部は別 Group（Blender の Empty 親）
  として分離し、`panel-hinge` の命名規則を維持する

### 材質設計

既存の材質定義（`materials.mjs`）を拡張:

| 材質 | 用途 | 色 | metalness | roughness |
|---|---|---|---|---|
| hull | 外壁パネル | #b9c4d0 | 0.72 | 0.48 |
| mli | 多層断熱材 | #d4a843 (金箔) | 0.85 | 0.30 |
| handrail | ハンドレール | F0_STEEL | 1.0 | 0.35 |
| pipe | 配管 | F0_ALUMINIUM | 1.0 | 0.40 |
| heatshield | ヒートシールド | #3a2a1a | 0.0 | 0.90 |
| nozzle | ノズルベル内面 | F0_BURNT_STEEL | 1.0 | 0.45 |
| nozzle_ext | ノズルベル外面 | #808890 | 0.9 | 0.38 |
| window_frame | 窓枠 | #4a4a4a | 0.9 | 0.35 |

既存の材質（hull, dark, rim, window, tankMain, tankRcs, armor, radiator, solar, dock）は維持。
glTF 側のマテリアル名で自動マッピングするか、Blender 側で直接 PBR 値を設定する。

## ステップ

### Phase 1: パイプライン基盤（glTF → JSON 化）

1. `assets-src/ship-modules/` ディレクトリを作成
2. `ship-modules.mjs` に GLTFLoader による読み込み関数を追加
   - Node.js 環境での GLTFLoader 利用（`three/examples/jsm/loaders/GLTFLoader.js` + fs polyfill）
   - glTF → THREE.Group 変換、スケーリング・座標系の整合
   - semantic anchor の検出と補完
3. `addKindDetails()` に glTF フォールバック分岐を追加
4. 既存テスト (`ship-module-asset.test.ts`) が glTF 導入後も通ることを確認

### Phase 2: 主要モジュールの Blender モデル作成

1. **cockpit-standard**: ソユーズ降下モジュール風テーパー + ジェミニ風窓 + ISS 風外壁リブ
2. **tank-{3,6,12}-main**: ISS モジュール風パネルライン + 配管 + ハンドレール
3. **tank-{3,6,12}-rcs**: ドーム端面 + ISS 風ディテール（色違い）
4. **thruster-standard**: ベル曲線ノズル + 配管 + ブラケット
5. **booster-standard**: ノーズコーン + SRB 風スカート + ベルノズル

### Phase 3: 検証と調整

1. `npm run export-assets` でアセット再生成
2. `npm run test:render` で契約テスト通過確認
3. `npm run typecheck` で型検査通過確認
4. render-lab で前後比較撮影
5. 物理形状との視覚的整合確認（大きく円柱からはみ出す部分がないか）

### Phase 4: 残りのモジュールへ拡大（別計画）

- rcs, weapon, armor, radiator, solar_panel, docking_port, dock, decoupler

## 影響範囲

### 変更するファイル

| ファイル | 変更内容 |
|---|---|
| `tools/model-builder/ship-modules.mjs` | glTF 読み込み関数追加、addKindDetails に分岐追加 |
| `tools/model-builder/materials.mjs` | 新材質の追加（mli, handrail, pipe, heatshield 等） |
| `src/assets/models/shipModules.json` | `npm run export-assets` で再生成 |

### 変更しないファイル

| ファイル | 理由 |
|---|---|
| `src/render/dynamic/ship/ship-module-models.ts` | パイプライン下流。JSON 形式が同じなので変更不要 |
| `src/render/dynamic/ship/ship-module-view.ts` | パイプライン下流。同上 |
| `src/render/dynamic/ship/modular-ship-view.ts` | パイプライン下流。同上 |
| `src/render/dynamic/ship/modular-ship-dynamic-view.ts` | パイプライン下流。同上 |
| `src/game/ship/ship-module-definition.ts` | 物理形状は円柱近似のまま。大きな変更なし |
| `src/game/ship/ship-module-catalog.ts` | 定義の変更なし |
| `tests/render/ship-module-asset.test.ts` | 契約テストはそのまま通す |

### 新規ファイル

| ファイル | 内容 |
|---|---|
| `assets-src/ship-modules/*.glb` | Blender で作成した glTF モデル |

## 確認が必要な点

- **Blender の利用可否**: この計画では Blender でモデルを手作業で作ることを前提としていたが、
  `/Applications/Blender.app` (Blender 5.0.1) の headless 自動実行スクリプト (`tools/model-builder/blender/build-ship-modules.py`)
  を作成し、完全自動生成パイプラインとして完遂した。
- **Node.js での GLTFLoader**: `three/examples/jsm/loaders/GLTFLoader.js` の `loader.parse()` が非同期
  コールバックであるため、`Promise` ベースのローダー (`loadGlbScene`, `applyGlbModel`) を作成し、
  `tools/model-builder/ship-modules.mjs` および `export-models.mjs` を async/await 化して統合した。
- **shipModules.json のサイズ**: 現在 約 558KB でコンパクトに収まっており、Web ゲームのロードに支障ない範囲。

## 実施結果 (2026-09-22)

1. **太陽電池の対称性修正**:
   - `src/game/ship/ship-assembly-transform.ts` の `sideMountTransform` を改修し、`sideSlotRotation(slot)` を導入。
   - 4つの側面スロット（`+x`, `-x`, `+y`, `-y`）でローカル +X を船尾方向 `(0, 0, -1)` に統一することで、太陽電池およびラジエーターが船体に対して完全に線対称・鏡像対称に展開されるよう修正した。
2. **モジュール形状の本格化と突起・板の全廃**:
   - 以前のプロシージャル直方体・円柱突起を廃止し、Blender 5.0.1 スクリプトによる 18 種類の航空宇宙 GLB モデル（コックピット、タンク、ノズル、トラス、ドッキング機構など）へ全面移行。
   - コックピット: ソユーズ・マーキュリー風のなめらかな曲面テーパーカプセル、ジェミニ風観察窓、アブレーションヒートシールド、CBMドッキングカラー。
   - タンク: サドルクランプ付き極低温推進剤配管、エルボ継手、ドーム端面、構造トラス。
   - 推進器: 放物線 Rao ノズルベルプロファイル、ジンバルアクチュエータ、環状マニホールド配管。
   - RCS/ドッキング/兵装/装甲: 4ノズルクラスター、APASガイドペタル、リコイルダンパー付き砲身、複合装甲ボルト締め。
3. **契約テスト・型検査の通過**:
   - `npm run test:render`: 227/227 全テストパス（`tank-band`、`interface-ring`、semantic anchor、展開翼テスト完全一致）。
   - `npm run test:game`: 317/317 全テストパス。
   - `npm run typecheck`: エラー 0。
4. **描画確認**:
   - `npm run render-lab:shot` により、高精細なディテールと完全に対称な展開が確認された。

