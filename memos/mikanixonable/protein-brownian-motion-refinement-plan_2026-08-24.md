# タンパク質敵の微細構造振動 改修計画

対象コミット: 5b1a6094

## 1. 目的

タンパク質敵の熱運動表現を、意味的コンポーネント全体の平行移動から、残基ごとに空間相関を持つ
微細な構造振動へ置き換える。

完成時には次を満たす。

1. タンパク質全体が一塊で漂う見え方ではなく、主鎖・二次構造・ドメインが連続的にたわむ。
2. 近接する残基は相関して動き、共有結合を無視した原子ごとの独立ノイズにはしない。
3. 大域的な低周波運動と、小振幅で速い局所運動を同時に表示する。
4. 分子模型・リボン・シルエットの3表現が同じ変位場を共有し、表示切替で運動が変わらない。
5. 活性部位・修飾・結合線が構造表面から取り残されない。
6. タンパク質敵が複数存在しても、CPUで全原子行列を毎フレーム更新しない。
7. 敵IDと表示時刻から同じ姿勢を再現でき、セーブデータへ乱数列の内部状態を追加しない。

本計画の「科学的に正確」は、**原子間力を逐次積分する分子動力学(MD)をゲーム内で実行すること**を
意味しない。PDB構造から作った残基単位の弾性ネットワークについて、調和平衡近傍の固有モードと
過減衰確率過程を使い、空間的な相関と相対振幅を科学的根拠のある形へ改善することを意味する。
実時間スケールと表示倍率はゲーム向けの写像であり、物理時間の再現値として表示・保存しない。

---

## 2. 現状と解消する問題

### 2.1 現在の空間モデル

`tools/protein-builder/generate-protein-asset.mjs` は、意味的コンポーネント数を自由度とする小さな
Hessianを作り、最大4モードだけを生成している。`ProteinRuntime.updateVisual()` はモード係数を
コンポーネント別の平行移動へ変換し、`proteinComponent` が付いた描画Object3Dへ適用する。

| アセット | 原子数 | Cα残基数 | 現在の運動単位 | 現在のモード |
| --- | ---: | ---: | ---: | ---: |
| 5I4R | 8,941 | 1,113 | 意味的コンポーネント4個 | 平行移動4モード |
| 1MBN ミオグロビン | 1,260 | 153 | コンポーネント1個 | 全体平行移動X/Y/Z |

5I4Rでは同じコンポーネントに属する複数Chainが同じ変位を受ける。1MBNでは内部自由度がなく、
全原子・全リボンが一体のまま移動する。利用者が「塊が少しだけ動く」と感じる直接の原因である。

### 2.2 現在の時間モデル

`ProteinBrownianSampler` は各モードを定常Ornstein–Uhlenbeck過程としてサンプルする。この選択自体は、
溶媒中で過減衰する低周波座標の表示モデルとして維持できる。ただし現状は次の調整が混在している。

- アセットの `sampleHz` は30 Hz。
- `PROTEIN_BROWNIAN_TIME_SCALE = 1 / 4` により、全モードを一律に4倍遅く表示する。
- `visualGain = 4` により、全モードを一律に4倍大きく表示する。
- 固有値から作る `relaxationRate` と `rmsAmplitude` は経験的な値で、B-factorとの較正がない。

`sampleHz`を上げるだけでは空間的な粒度は増えない。補間が細かくなるだけで、塊が動く構造は残る。

### 2.3 描画上の制約

- 分子模型の原子は元素・Chainごとの`InstancedMesh`で描かれ、現在のinstanceMatrixは静的である。
- 原子間結合はChainごとの`LineSegments`で、座標は静的である。
- リボンは二次構造runごとのMeshだが、運動タグはChainにしか結び付いていない。
- シルエットは最大約123,884頂点(5I4R)を持ち、CPU頂点更新には向かない。
- タンパク質の当たり判定は生成時にリボン三角形を抽出して固定している。

したがって、全原子・全頂点をJavaScriptから毎フレーム書き換える方式は採らない。

---

## 3. 科学モデルの決定

### 3.1 粒度: Cα残基単位のAnisotropic Network Model

各アミノ酸残基のCαを1ノードとし、平衡構造で距離がカットオフ以内のノード対を等方ばねで結ぶ。
各Cαノードを等しい有効質量として扱う3N×3N Hessianから、剛体並進・回転に対応する6個の零モードを除外し、低い側から
固有モードを生成する。

初期既定値:

| 項目 | 値 | 備考 |
| --- | ---: | --- |
| ノード | Cα 1個 / 残基 | 既存Backbone Assetを正本にする |
| 接触カットオフ | 13 Å | 10〜15 Åを検証し、ネットワーク連結性を優先 |
| 保存モード数 | 24 | 実行時LODで4/12/24を選ぶ |
| 零モード除外 | 6 | 連結成分が複数なら生成失敗とする |
| 数値精度 | Float64で固有値計算 | 出力はFloat32 |

原子を独立に揺らさない。各原子は所属残基の変位を受ける。これにより共有結合近傍の連続性を保ち、
局所的に異なる動きを出す。

### 3.2 モード生成: オフライン疎行列固有値計算

5I4Rは1,113残基、3,339自由度になる。既存の全要素Jacobi法をこの寸法へ拡大しない。
`tools/protein-builder/`のオフライン工程へ、疎対称行列用Lanczos法を持つ
`scipy.sparse.linalg.eigsh`を導入する。

- NumPy/SciPyはアセット生成時だけ使用し、ゲーム配布物へ同梱しない。
- バージョンは`tools/protein-builder/requirements-lock.txt`へ固定する。
- Node側の`run-all.mjs`からPython生成器を起動し、既存の`protein:generate`と
  `protein:generate:check`の入口を維持する。
- CIは固定依存を導入して再生成差分を検査する。生成済みJSONだけを信用する運用にはしない。
- 固有ベクトルの符号は「絶対値最大成分を正」に正規化し、生成環境による符号反転差分を防ぐ。
- 近接固有値による基底回転が起きる場合は、縮退部分空間を決定的な参照ベクトルへ射影して正準化する。

Python依存を導入できない環境のために、通常の`npm run build`は生成済みアセットだけで完結させる。
Pythonが必要なのは`protein:generate`、`protein:generate:check`、完全CIだけとする。

### 3.3 振幅: 固有値とB-factorによる相対較正

モードkの残基iにおける固有ベクトルを `e[k,i]`、固有値を `lambda[k]` とする。調和近似では、
モード分散は固有値の逆数に比例する。出力する基礎RMSは次で作る。

```text
rawVariance[k] = 1 / lambda[k]
predictedMSF[i] = sum_k(rawVariance[k] * |e[k,i]|^2)
```

PDBのB-factorから得る等方平均二乗変位は `MSF = 3B / (8*pi^2)` とする。ただしB-factorには結晶内の
静的 disorder、占有率、精密化誤差なども混ざるため、絶対温度計として扱わない。

較正手順:

1. CαのB-factorを残基ごとに読む。
2. Chainごとの中央値を使って外れ値を抑え、5〜95 percentileへclampする。
3. 予測MSFの中央値が観測MSFの中央値へ一致する単一スケールを求める。
4. 表示用上限で残基変位をclampするのではなく、モード係数のRMS側を制限する。
5. B-factor欠損・0・非有限値が多いアセットは固有値だけの相対振幅へフォールバックし、生成物へ
   `amplitudeCalibration: "eigenvalue-relative"` と記録する。

`visualGain`は科学データに混ぜない。物理由来のÅ単位変位と、表示倍率を別フィールドにする。

### 3.4 時間: 2帯域の過減衰OUモード

ENMの固有値だけでは溶媒摩擦と実時間を一意に決められない。固有値から相対的な速さを作り、画面上の
時間へ写像する。写像は科学値ではなく表示設定であることをスキーマ名に明示する。

| 帯域 | 使用モード | 表示緩和率 | 表示振幅倍率 | 役割 |
| --- | --- | ---: | ---: | --- |
| collective | 低い4モード | 0.35〜1.2 s^-1 | 0.55 | ドメイン・二次構造の大域運動 |
| local | 次の20モード | 2〜12 s^-1 | 0.20 | 小刻みな残基運動 |

- `PROTEIN_BROWNIAN_TIME_SCALE`は廃止する。
- 各モードが`displayRelaxationRate`と`physicalRmsAngstrom`を持つ。
- 全体倍率は`collectiveGain`と`localGain`へ分離する。
- OU遷移は現行どおり指数形式の厳密離散化を使い、フレームレート依存を増やさない。
- `sampleHz`は60 Hzを既定とするが、固定tick間を補間する現在の決定論的seek特性を維持する。
- 高周波の結合伸縮やフェムト秒振動を60 fpsで再現しているとは主張しない。

### 3.5 残基内原子の扱い

第1段階では、所属残基の全原子へ同じ並進変位を与える。残基間で変位が変わるため、現在より大幅に
微細になる一方、残基内部の結合長は壊れない。

回転自由度は初期実装へ含めない。Cα ANMの並進に、根拠のないランダム回転を追加するより正確である。
残基単位の回転・側鎖運動が必要になった場合は、第2段階としてRotation–Translation Block法または
主鎖フレームから導く微小回転を追加する。第2段階は本計画の完了条件に含めない。

---

## 4. データ構造

### 4.1 詳細運動を意味情報JSONから分離する

`ProteinAssetDefinition.motion`は戦闘用意味情報に、描画専用の大量な残基変位を保持している。
詳細運動を専用生成物へ分離する。

```text
assets-src/proteins/<pdb>/protein.config.json
                    │
                    ├── semanticAsset   既存: 部位・HP・作用
                    ├── structureAsset  既存: 原子・結合・表面
                    └── motionAsset     新規: 残基binding・固有モード

src/assets/models/<name>Motion.json
```

`ProteinAssetBundle`へ`motion: ProteinMotionAsset`を追加する。`ProteinRuntime`は
`ProteinAssetDefinition`単体ではなく、戦闘に必要なsemanticと描画に必要なmotionを明示的に受け取る。

Structure AssetとBackbone Assetの生成metadataへ、座標・残基対応・原子対応から求める`contentHash`を
追加する。Motion Assetの`structureHash`/`backboneHash`はこの値を参照し、Catalog組立時に文字列比較する。
巨大JSON全体をゲーム起動時に再ハッシュしない。生成器は同じ正規化手順でhashを作り、CIのvalidatorは
入力ファイルから再計算してmetadata自体の改変も検出する。

### 4.2 `ProteinMotionAsset` schemaVersion 1

```ts
interface ProteinMotionAsset {
  readonly schemaVersion: 1;
  readonly model: 'c-alpha-anm-overdamped';
  readonly source: {
    readonly pdbId: string;
    readonly structureHash: string;
    readonly backboneHash: string;
    readonly generatorVersion: number;
    readonly cutoffAngstrom: number;
  };
  readonly residueCount: number;
  readonly residues: {
    readonly chains: readonly number[];
    readonly residueNumbers: readonly number[];
    readonly centers: readonly number[]; // xyz, Å
    readonly bFactors: readonly number[];
  };
  readonly bindings: {
    readonly atomResidues: readonly number[];
    readonly backboneResidues: readonly number[];
    readonly surfaceResidues: readonly number[];
    readonly siteResidues: readonly number[];
    readonly modificationResidues: readonly number[];
  };
  readonly modes: readonly {
    readonly id: string;
    readonly band: 'collective' | 'local';
    readonly eigenvalue: number;
    readonly displayRelaxationRate: number;
    readonly physicalRmsAngstrom: number;
    readonly displacements: readonly number[]; // residueCount * xyz, unit eigenvector
  }[];
  readonly display: {
    readonly sampleHz: number;
    readonly collectiveGain: number;
    readonly localGain: number;
  };
}
```

Bindingは描画時の最近傍探索をなくすため生成時に確定する。

- 原子: `(chain, residueNumber)`の完全一致。
- Backbone: 自身のCα残基。
- リボン頂点: 生成元Backboneの前後2残基と補間係数をGeometry attributeへ焼く。
- 表面頂点: Structure生成時に記録済みの最近傍原子から残基へ変換する。
- 部位・修飾: アンカー原子を優先し、見つからない場合だけ位置の最近傍Cαを使う。

リボンは1残基だけを参照すると折れ目が見えるため、`residueA`、`residueB`、`residueT`の3属性で線形補間する。

### 4.3 サイズ予算

5I4R、24モード、1,113残基では、Float32の固有ベクトル本体は次の大きさになる。

```text
1,113 residues * 24 modes * 3 axes * 4 bytes = 320,544 bytes
```

Binding、固有値、残基表を含めても、圧縮前バイナリ相当でアセット1件あたり1 MiB未満を目標とする。
JSON文字列表現が2 MiBを超える場合は、schemaVersion 1の意味を変えずにBase64化Float32 blobまたは
別`.bin`へ移す。最初から量子化して精度検証を複雑にしない。

---

## 5. 実行時アーキテクチャ

```text
ProteinBrownianSampler
  モード係数 q[k] を敵ID・表示時刻から決定
               │
               ▼
ProteinMotionController
  residueOffset[i] = sum_k(q[k] * mode[k,i])
  ・LODに応じて4/12/24モード
  ・Float32Arrayを再利用
  ・毎フレームのnew禁止
               │
       ┌───────┴────────┐
       ▼                ▼
GPU residue buffer    CPU anchor query
原子/結合/リボン/表面  活性部位/修飾/結合線
       │                │
       └───────┬────────┘
               ▼
       同じ残基変位で同期
```

責務を次のように分ける。

| モジュール | 責務 |
| --- | --- |
| `protein-brownian-motion.ts` | OU係数の決定論的サンプル。空間構造を知らない |
| 新規`protein-motion-controller.ts` | モード係数から残基変位を合成し、LODとGPU bufferを管理 |
| `protein-runtime.ts` | 戦闘状態、部位アンカー、描画再構築との接続 |
| `protein-enemy-ship.ts` | 各表現のGeometryへ残基bindingを付与 |
| 新規`protein-motion-material.ts` | NodeMaterialのposition変形を一元化 |
| 新規`generate-protein-motion.py` | ANM、固有値、B-factor較正、binding生成 |

### 5.1 CPU側の残基変位合成

毎フレーム、敵1体について `residueCount * activeModeCount * 3` の積和を行う。5I4R・24モードで
約80,000 scalar積和であり、8,941個のMatrix4を更新するより十分小さい。

- `Float32Array(residueCount * 4)`を敵ごとに1本持つ。xyzを変位、wを将来用に予約する。
- WebGPU storage bufferまたはDataTextureへ1フレーム1回アップロードする。
- 5I4Rでは約17.4 KiB/敵/更新。10体・60 Hzでも約10.4 MiB/sである。
- 時間ワープによる大きなseekでも、モード係数は現行Samplerの直接seekを使う。
- 非表示・遠距離LODでは合成もuploadも行わない。

### 5.2 GPU頂点変形

各頂点またはインスタンスは残基indexを持ち、position計算時に残基変位を1〜2回参照する。

- 分子模型: 原子instanceへ`residueIndex`を持たせ、instance平行移動へ加える。
- 原子間結合: 各端点へ対応残基indexを持たせる。
- リボン: 前後残基の変位を`residueT`で補間する。
- シルエット: 表面頂点の最近傍残基変位を使う。必要なら近傍2残基補間を後続改善とする。
- 法線は小変位近似として元の法線を維持する。シルエットの破綻が観測された場合だけ、隣接変位から
  法線補正する。毎フレーム`computeVertexNormals()`は呼ばない。

既存のG-buffer、material、protein shadowの全パスで同じ変形positionを使う。通常描画だけが動き、
影や深度が静止する状態を受け入れない。NodeMaterial化の実現性はPhase 0で先に検証する。

### 5.3 活性部位とゲーム状態

- 活性部位、修飾、意味的結合線は所属残基の現在変位をCPU側から参照する。
- 射撃原点`activeSiteWorldPosition()`も同じ変位を加え、発光部位と弾の発射位置を一致させる。
- 保存値は増やさない。敵IDとsim/display timeから復元する。
- 詳細変位は表示専用のままにし、タンパク質本体の重心・姿勢・慣性・軌道へ加算しない。

### 5.4 当たり判定

初期実装ではリボン三角形の当たり判定を静止基準形状のまま維持する。

理由:

- 振幅はÅ単位で、ゲーム内の敵スケールに対して小さい。
- 毎フレームBVHや三角形を更新すると、描画改善に対して負荷が不釣り合いになる。
- 弾丸の狙点は部位アンカーで追従し、視覚上の大きな不一致を避けられる。

受け入れ試験で、最大変位時に見た目と判定の差が弾丸半径の25%を超える場合は、外接形状へ
`maxMotionEnvelope`を加える。変形メッシュとの厳密衝突は本計画へ追加しない。

---

## 6. LODと更新頻度

距離だけでなく、画面上の投影サイズを基準にする。距離閾値は敵の表示スケール変更で意味が変わるためである。

| LOD | 投影直径 | モード | 更新 | 表示 |
| --- | ---: | ---: | ---: | --- |
| near | 160 px以上 | 24 | 毎フレーム | collective + local |
| medium | 40〜160 px | 12 | 30 Hz | collective + local縮小 |
| far | 8〜40 px | 4 | 15 Hz | collectiveのみ |
| marker | 8 px未満 / マップ | 0 | 停止 | 剛体表示 |

- 閾値には上下15%のhysteresisを持たせる。
- LOD切替時は0.25秒でモード係数寄与をcross-fadeし、形状を瞬間移動させない。
- medium/farの更新frameは敵IDのhashで位相をずらし、複数敵の合成とuploadを同じframeへ集中させない。
- ターゲット中の敵は最低mediumを保証する。
- 表示形態を切り替えて再構築しても、SamplerとControllerは作り直さず同じ時刻の変位を引き継ぐ。

---

## 7. 実装フェーズ

### Phase 0 — 基準計測とWebGPU変形スパイク

目的: 大量実装の前に、Three.js WebGPUで必要なbindingと全描画パスの整合を確認する。

1. Render Labへ5I4Rの分子模型・リボン・シルエットを各1体/10体出すケースを追加する。
2. 現状のCPU update、G-buffer、world、protein shadowのp50/p95を記録する。
3. 8個の人工残基変位をstorage bufferから読むNodeMaterialスパイクを作る。
4. InstancedMeshのinstanceごとの残基index、LineSegments端点、Mesh頂点の3経路を確認する。
5. G-buffer・影・深度が同じ変位を使うことをスクリーンショット差分で確認する。

ゲート: 3表現すべてでposition変形が通らない場合は、以降へ進まず、CPU頂点更新へ妥協せずに
描画マテリアル境界を再設計する。

### Phase 1 — Motion Asset生成器と検証

1. `generate-protein-motion.py`と固定Python依存を追加する。
2. Cα接触グラフ、疎Hessian、24固有モード、B-factor較正を実装する。
3. 原子・Backbone・表面・部位・修飾の残基bindingを生成する。
4. 5I4Rと1MBNのMotion Assetを生成する。
5. CatalogへMotion Asset importを追加する。
6. 既存`ProteinAssetDefinition.motion`は移行完了まで読み取り互換を残し、全アセット移行後に削除する。

ゲート: 再生成が決定的で、下記生成テストをすべて通ること。

### Phase 2 — 残基モーションController

1. `ProteinMotionController`を追加する。
2. 現行Samplerを任意モード数へ使い、帯域別gainとLODを適用する。
3. 残基変位bufferを再利用し、1,000フレームでallocationが増えないことを確認する。
4. 直接seek、逆方向seek、異なるフレームレートで同じ変位になることをテストする。
5. `ProteinRuntime`からコンポーネント平行移動tableを除去する。

### Phase 3 — 分子模型と結合

1. 原子InstancedMeshへ残基indexを付ける。
2. 原子位置をGPUで変形する。
3. 原子間結合の両端を対応残基で変形する。
4. 原子と結合が離れないことをテストする。
5. 1MBNで全体平行移動ではなくヘリックス間の微細な相対運動が見えることを確認する。

### Phase 4 — リボン、シルエット、機能アンカー

1. リボン頂点へ前後残基bindingを追加する。
2. 表面頂点へ残基bindingを追加する。
3. 活性部位、修飾、意味的結合線を同じ変位場へ接続する。
4. 射撃原点を現在の部位変位へ追従させる。
5. 表示形態切替前後で、同じ残基・時刻の位置が一致することをテストする。

### Phase 5 — LODと性能ゲート

1. 投影直径ベースLOD、hysteresis、cross-fadeを追加する。
2. 負荷確認UIへ`protein motion CPU`、upload bytes、near/medium/far体数を追加する。
3. Render Labの基準ケースを再計測する。
4. 予算を超えた場合は、順に「localモード数」「更新頻度」「シルエット補間数」を落とす。
5. 原子数、表面頂点数、敵数に対するスケーリングを記録する。

### Phase 6 — 科学較正と仕様更新

1. 5I4R・1MBNの各残基RMS分布を出力し、B-factor由来分布と比較する。
2. rigid-body零モード混入、重心drift、Chain境界の不連続がないことを確認する。
3. 表示gainをゲーム画面で調整し、物理由来値と表示値を混ぜずに確定する。
4. 確定した挙動を`DEVELOP/SPEC/RENDERING.md`へ追加する。
5. 完了した計画項目を歴史として残さず、維持すべき仕様・生成規約をSPECとコードコメントへ移す。

---

## 8. テスト計画

### 8.1 生成器

- Cα接触グラフが1連結成分である。
- Hessianが対称である。
- 除外前に6個の零モードが存在し、保存モードに零モードが混ざらない。
- 固有値は正かつ昇順である。
- 固有ベクトルのノルムが1、相互内積が許容誤差以下である。
- 各非零モードの質量中心並進が許容誤差以下である。
- atom/backbone/surface/site/modification bindingの長さとindex範囲が正しい。
- 同じ入力と固定依存からbyte-identicalなMotion Assetが生成される。
- Structure/Backbone hash不一致をCatalog読込時に拒否する。

### 8.2 確率過程

- 24モードで定常RMSが各`physicalRmsAngstrom`に一致する。
- 自己相関が `exp(-displayRelaxationRate * dt)`へ一致する。
- 30/60/120 fpsで同一時刻の係数・残基変位が一致する。
- 長時間seek後も逐次更新と一致する。
- 非有限時刻、負時刻、巨大時刻でNaNを出さない。
- 敵IDが異なる個体は異なる位相を持ち、同じIDは再現する。

### 8.3 描画整合

- 同一残基の原子と結合端点が一致する。
- リボンの隣接残基境界に可視の亀裂がない。
- シルエットから内部リボンが大きくはみ出さない。
- 活性部位markerと射撃原点が一致する。
- 分子模型/リボン/シルエット切替で部位位置が許容誤差内に留まる。
- rootのposition/quaternion/scaleをMotion Controllerが変更しない。
- collision geometryを変更しない。
- clear/rebuild後に基準姿勢を二重加算しない。

### 8.4 視覚受け入れ

- 1MBNを5秒観察し、全体だけが同じ方向へ平行移動し続ける時間が1秒以上ない。
- 5I4Rで大域運動を認識できる一方、各ドメイン内部にも小振幅の相対運動が見える。
- 局所運動がテレビのノイズや沸騰のような独立点振動に見えない。
- 60 fpsで残基の位置が1フレームごとに不連続に跳ばない。
- LOD境界の往復で形状がpopしない。
- 静止スクリーンショットでは基準PDB構造から過度に崩れて見えない。

---

## 9. 性能予算と計測条件

性能値は実装前後を同じ端末・解像度・カメラ・敵配置・表示形態で比較する。平均だけでなくp95を記録する。

基準シーン:

1. 5I4R 1体、画面直径400 px、各表示形態。
2. 5I4R 10体、near 2 / medium 4 / far 4。
3. 1MBN 20体、medium。
4. 5I4Rシルエット1体を画面いっぱいに表示。
5. 時間ワープ後の直接seekを100回連続実行。

受け入れ予算:

| 指標 | 1体near | 10体混在 |
| --- | ---: | ---: |
| Motion CPU p95 | 0.30 ms以下 | 1.50 ms以下 |
| Motion buffer upload | 20 KiB/frame以下 | 120 KiB/frame以下 |
| GPU frame増分 p95 | 0.60 ms以下 | 2.00 ms以下 |
| Motion処理由来の毎フレームGC allocation | 0 bytes | 0 bytes |
| Motion Assetバイナリ相当 | 1 MiB/asset以下 | 共有のため不変 |

絶対値は参照端末に依存するため、さらに現行比の上限を設ける。

- 1体near: GPU frame p95の増加20%以下。
- 10体混在: GPU frame p95の増加30%以下。
- いずれか一方でも超える場合は、既定LODを下げてから再計測する。

CPUで原子ごとのMatrix4を更新するフォールバックは設けない。5I4Rでは8,941行列に加え、9,141本の
結合頂点更新が必要になり、敵数に比例するJavaScript処理とGPU転送が恒常化するためである。

---

## 10. 失敗時の縮退順序

品質または性能が予算を満たさない場合は、次の順で縮退する。

1. local帯域を20モードから12モードへ減らす。
2. mediumの更新を30 Hzから20 Hzへ下げる。
3. シルエットを2残基補間から最近傍1残基へ下げる。
4. farの構造運動を停止する。
5. near判定の投影直径を160 pxから240 pxへ上げる。

次は縮退手段にしない。

- 原子を独立ランダム変位へ置き換える。
- 原子だけ動かし、結合・リボン・影を静止させる。
- フレームごとにGeometryまたはMaterialを再生成する。
- collision geometryを毎フレーム再構築する。
- 固有モード生成をランタイムへ移す。

---

## 11. リスクと対策

| リスク | 結果 | 対策 |
| --- | --- | --- |
| WebGPU NodeMaterialでinstance/vertex bindingを共通化できない | 表現ごとに別方式となり保守不能 | Phase 0を実装ゲートにする |
| 固有値の縮退で生成差分が揺れる | CIのgenerate checkが不安定 | 符号・縮退部分空間を正準化し依存を固定 |
| B-factorを絶対熱振幅と誤認する | 科学的主張が過剰になる | 相対較正に限定しmetadataへ方式を記録 |
| モード数を増やすだけで高周波に見えない | 大きくゆっくりした変形が残る | collective/localの緩和率とgainを分離 |
| 残基一様並進でリボンに折れ目が出る | 微細化が視覚品質を下げる | 前後残基変位を頂点で補間 |
| シルエット変形と法線がずれる | 光沢が不自然になる | まず小変位制限、必要時だけ法線補正 |
| 表示部位と判定がずれる | 狙撃の納得感が落ちる | 部位・射撃原点を追従、判定差を定量試験 |
| 多数の敵でbuffer uploadが増える | GPU待ち・帯域増 | 投影LOD、非表示停止、buffer再利用 |
| Python科学依存が開発を難しくする | アセット再生成できない | 固定lock、1コマンドbootstrap、通常buildから分離 |

---

## 12. 完了条件

次をすべて満たした時点で完了とする。

- 5I4Rと1MBNに24個の残基ANMモードが生成され、生成検証を通る。
- 意味的コンポーネント単位の旧motion schemaと旧translation tableが削除される。
- 3表示形態、原子間結合、部位、修飾、意味的結合線が同じ残基変位を使う。
- 1MBNが全体平行移動だけではなく内部変形する。
- OU過程の決定論的seekと統計テストが通る。
- root姿勢、セーブ形式、通常敵、当たり判定へ回帰がない。
- LOD切替にpopがなく、性能予算を満たす。
- `npm run typecheck`、タンパク質生成・検証、物理テスト、production build、browser smokeが通る。
- 確定仕様が`DEVELOP/SPEC/RENDERING.md`へ反映される。

---

## 13. 科学的根拠と参照資料

- Atilgan et al., *Anisotropy of Fluctuation Dynamics of Proteins with an Elastic Network Model*,
  Biophysical Journal 80 (2001). Cα残基単位ANMと方向付き集団運動の基礎。
  https://doi.org/10.1016/S0006-3495(01)76133-X
- Tirion, *Large Amplitude Elastic Motions in Proteins from a Single-Parameter, Atomic Analysis*,
  Physical Review Letters 77 (1996). 単純な弾性ポテンシャルで低周波運動を扱う根拠。
  https://doi.org/10.1103/PhysRevLett.77.1905
- Yang, Song, Jernigan, *How Well Can We Understand Large-Scale Protein Motions Using Normal Modes of
  Elastic Network Models?* (2007). 低周波モードが集団運動に強く、非集団的局所運動には限界があること。
  https://pmc.ncbi.nlm.nih.gov/articles/PMC1913142/
- Reetz et al., *Utility of B-Factors in Protein Science* (2019). B-factorを柔軟性指標として使う際の
  有用性と限界。
  https://doi.org/10.1021/acs.chemrev.8b00290

本実装はこれらの手法をゲーム表示へ適用する粗視化モデルであり、特定温度・溶媒条件のMD軌跡、
結合振動スペクトル、反応座標を再現するものではない。
