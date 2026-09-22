# 10. 読み方・調査手順

この章は「何かを理解・修正したいが、どこから読めばよいか分からない」ときのための実践的な入口です。Dive into Tepui は分野が広いため、リポジトリを先頭から読むより**問いの種類を決めてから追跡する**方が効率的です。

## 1. 最初に問いを分類する

大半の調査は次のどれかです。

### A. 値の所有者を知りたい

「燃料を誰が持つか」「カメラの基準系を誰が保存するか」。

→ ownership を追う。

### B. いつ呼ばれるか知りたい

「この処理は進行前か後か」「1フレーム何回呼ばれるか」。

→ call stack / frame phase を追う。

### C. 誰が呼ぶか知りたい

「この関数を消せるか」「変更するとどこへ波及するか」。

→ inverse call stack を追う。

### D. 値がどこで変換されるか知りたい

「ECI が画面座標になるまで」「イベントが音になるまで」。

→ data flow を追う。

### E. 見た目がおかしい

→ model / derivation / device のどこで崩れたか切り分ける。

## 2. まず Run.frame を読む

全体の入口として `src/run/run.ts` の `frame()` を読むと、

- 進行
- 入力
- snapshot
- sync
- render

の順序が見えます。

具体的な機能を追う前に、**その機能がどの位相に属するか**を決めると迷いにくくなります。

## 3. 所有者を探す方法

ある値の名前で検索したら、最初に「代入箇所」を探します。

### 悪い読み方

利用箇所を100件読む。

### 良い読み方

1. フィールド宣言
2. constructor
3. 変更メソッド
4. serialize
5. deserialize
6. 読み取り口
7. 呼び手

の順に見る。

これで、その値が正本かキャッシュかを判定できます。

## 4. serialize が手掛かりになる

モデル正本はセーブ対象になることが多いため、`serialize()` を見ると所有関係が分かります。

逆に、

- render resource
- marker
- DOM
- temporary drag

に serialize が無ければ、導出・装置側である可能性が高いです。

## 5. create / deserialize を対で読む

生成処理と復元処理を対で見ると、

- 何が保存されるか
- 何が再生成されるか
- 何に外部依存するか

が分かります。

## 6. dispose も読む

所有者を知るときは destructor 側も重要です。

`dispose()` が、

- GPU resource
- event listener
- worker
- pool
- DOM

を捨てているなら、そのクラスがそれらを所有している可能性が高いです。

## 7. import 方向を見る

ファイルの冒頭 import は、責務を理解する高密度な情報です。

例えば render ファイルが game の具体クラスを多数 import していれば、境界違反の可能性があります。

一方 Presenter が game と render の両方を import するのは、意味から装置語彙へ変換する役割として自然です。

## 8. type-only import を区別する

TypeScript では `import type` が多く使われます。

実行時依存と型依存は同じではありません。

循環や層を見るときは、値として import しているかも確認します。

## 9. 「表示が変」なときの切り分け

### Step 1: モデル値は正しいか

位置・速度・温度・燃料など。

### Step 2: 導出値は正しいか

座標変換、色、表示可否、マーカー位置。

### Step 3: device への宣言は正しいか

Three.js / DOM / Audio へ何を渡したか。

### Step 4: device 側の資源状態は正しいか

GPU buffer、texture、CSS、z-index。

この順で見ると、「シェーダが悪いと思ったら元の座標系が間違っていた」という遠回りを減らせます。

## 10. 軌道がおかしいとき

確認順:

1. 単位
2. 時刻
3. 元期
4. ECI / rotating / body frame
5. 中心天体
6. (mu)
7. 摂動
8. integration dt
9. prediction と actual の取り違え

特に km と m、degree と radian の混同は最初に除外します。

## 11. 回転系表示がおかしいとき

確認順:

1. 表示原点
2. 回転基準
3. 基準天体
4. sample time
5. camera transform
6. marker transform
7. line transform

「点は合うが軌道線だけずれる」なら、各サンプルへ現在時刻の回転を一括適用していないかを疑います。

## 12. カメラがおかしいとき

カメラ問題は、

- Viewer の論理選択
- CameraSystem の導出
- CameraView
- Render camera

のどこかです。

Three.js camera だけを直しても、次フレームの sync で論理状態から上書きされる場合があります。

## 13. HUD が更新されないとき

確認順:

1. モデル値
2. Presenter が読んでいるか
3. declaration が更新されているか
4. HUD component が sync されるか
5. DOM の visibility / layer

UI クリックでモデルが変わらないなら逆方向も追います。

## 14. 入力が効かないとき

確認順:

1. `Input` が event を受けているか
2. binding が一致するか
3. GameInputRouter の port が有効か
4. 先の port に消費されていないか
5. pause / modal / construction gate
6. command queue へ入るか
7. 進行位相で適用されるか

## 15. 入力が二重に効くとき

- edge と held を両方処理
- browser dblclick と touch double tap の二重計上
- 複数 port が同じ key を取る
- DOM handler と frame input の両方で命令

を疑います。

## 16. セーブが壊れるとき

確認順:

1. serialize
2. 保存された JSON
3. version / migration
4. deserialize
5. ID 解決
6. Viewer の参照
7. derived resource rebuild

「保存直後は動くが reload 後だけ壊れる」なら、正本の serialize 漏れが典型です。

## 17. ShipAssembly が壊れるとき

確認順:

1. module ID
2. edge
3. port occupancy
4. validation
5. connected component
6. totals
7. mass properties
8. physics shape
9. render adapter
10. save

グラフ構造は一箇所だけ直して終わらないため、派生値を順に追います。

## 18. ドッキングがおかしいとき

成立前:

- 距離
- 軸
- 相対速度
- port 状態

成立後:

- assembly merge
- module IDs
- connections
- mass
- inertia
- motion
- save

を分けて確認します。

## 19. 地球表面が欠けるとき

確認順:

1. tile key
2. source descriptor
3. request queue
4. HTTP
5. decode
6. resident
7. page table
8. material binding
9. shader lookup

ネットワーク失敗と GPU lookup 失敗は見た目が似るため、各段の metrics を使います。

## 20. 地球表面がちらつくとき

- generation の取り違え
- old request の到着
- parent fallback
- resident eviction
- page table update
- LOD hysteresis

を疑います。

## 21. 雲がおかしいとき

まず Cloud Lab へ切り出します。

その後、

- 入力 field
- coverage
- height
- opacity
- sampling
- lighting
- composite

を分けて見ます。

## 22. GPU が重いとき

CPU と GPU を分けます。

### CPU

- tile decode
- prediction
- entity update
- DOM
- JS allocation

### GPU

- ray marching
- overdraw
- large textures
- instancing
- shader complexity
- draw count

Scene の GPU timing と performance counters を使って切り分けます。

## 23. 大量エンティティが重いとき

- simulation count
- collision candidate
- AI
- trajectory prediction
- marker count
- draw count

を分けます。

同じ「1000個」でも、弾と複雑な modular ship では費用が違います。

## 24. 予測軌道が重いとき

表示需要がどこまで予測を伸ばしているかを見ます。

予測対象・期間を減らすことはできますが、表示設定によって実進行が変わってはいけません。

## 25. 関数を消せるか調べる

1. 定義を検索
2. import を検索
3. 呼び出しを検索
4. callback として渡されていないか
5. interface 実装か
6. test から使われていないか
7. string lookup / dynamic import で使われないか

TypeScript の直接参照だけで結論を出さない場面もあります。

## 26. 新しい機能をどこへ置くか

### 純数学

`math/`

### 時刻と物理だけで答えが決まる

`physics/`

### ラン中の正本

`game/`

### 3D / GPU 資源

`render/`

### 共通 DOM UI

`hud/`

### 生入力

`input/`

### アプリ共通設定

`settings/`

### ランの外側

`launcher/`

### 組み立て

`run/`

## 27. 新しい値をどこへ保存するか

問い:

1. ラン中に変わるか
2. セーブごとか
3. セーブを跨ぐか
4. 再生成できるか

### 例

船の燃料:
→ Game model + save

テーマ:
→ Settings

軌道線:
→ Derived, save しない

現在のマップ注視:
→ Viewer

## 28. 検索語を選ぶ

概念名だけでなく、関連する型名・動詞も使います。

例: docking

- dock
- docking
- connection
- merge
- port
- assembly

例: camera

- focus
- frame
- viewport
- projection
- follow

語彙揺れを考えると調査漏れが減ります。

## 29. テストから読む

実装が複雑な場合、テストは「どんな入力を重要視しているか」を知る良い入口です。

特に、

- edge case
- serialize round trip
- coordinate transform
- validation

はテストの方が短く読めることがあります。

## 30. コメントから読む

このリポジトリのコメントは日本語で、責務や順序理由が多く書かれています。

ただしコメントだけを原本とは考えず、コードと合わせて読みます。

## 31. 変更前に最小再現を作る

バグ修正では、いきなり実装を書き換えるより、

- test
- lab
- fixed seed
- fixed camera
- minimal assembly

などで再現条件を固定すると、修正の成否を判断しやすくなります。

## 32. デバッグコードを正本にしない

一時ログや debug flag で問題が見えたら、その情報を正式な metrics / test へ移す必要があるか判断します。

調査専用コードをそのまま runtime に残さないようにします。

## 33. 読む深さを決める

調査前に「何を答えたいか」を決めます。

### 浅い

置き場だけ知りたい。

### 中

所有者・主要フローを知りたい。

### 深い

全呼び出し、状態遷移、例外、テストまで必要。

毎回深く読むと context が膨らみ、重要な関係が見えにくくなります。

## 34. 目的別チェックリスト

### 物理変更

- [ ] 単位
- [ ] 座標系
- [ ] 時刻
- [ ] 正本
- [ ] test:physics
- [ ] typecheck

### game 変更

- [ ] 所有者
- [ ] command
- [ ] serialize
- [ ] event
- [ ] test:game
- [ ] typecheck

### render 変更

- [ ] resource lifecycle
- [ ] coordinate transform
- [ ] lab
- [ ] test:render
- [ ] typecheck

### UI 変更

- [ ] modal
- [ ] touch
- [ ] settings / viewer
- [ ] responsive
- [ ] input priority
- [ ] typecheck

## 35. 主要な入口まとめ

| 調べたいこと | 入口 |
| --- | --- |
| フレーム全体 | `src/run/run.ts` |
| 1ランの正本 | `src/game/game.ts` |
| 表示導出 | `src/game/game-presentation.ts` |
| 動的エンティティ | `src/game/dynamic/dynamic-system.ts` |
| 軌道力学 | `src/physics/dynamics.ts` |
| 座標系 | `src/physics/frame.ts` |
| ラグランジュ点 | `src/physics/lagrange.ts` |
| 船体 | `src/game/ship/ship-assembly.ts` |
| 地球描画 | `src/render/earth-surface.ts` |
| 生入力 | `src/input/input.ts` |
| 視点 | `src/game/viewer/viewer.ts` |
| セーブ | `src/launcher/save/` |
| 設定 | `src/settings/user-settings.ts` |

## 36. 最後に

このコードベースでは、「どのファイルが大事か」より、

- **誰が状態を持つか**
- **いつ書き換えるか**
- **どの座標系か**
- **どの寿命か**
- **表示か世界か**

を把握する方が、長期的に役立ちます。

ファイル名やクラス構成は変わっても、この5つの問いを使えば新しい構造を再び追えます。

---

<p align="center">
  <a href="09-testing-tooling.md"><strong>← 09. テスト・ツール</strong></a>
  ·
  <a href="README.md"><strong>WIKI 目次</strong></a>
  ·
  <a href="../README.md"><strong>プロジェクト README →</strong></a>
</p>
