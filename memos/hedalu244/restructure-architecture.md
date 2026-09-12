# ゲーム全体の再設計 — 状態の種類から層と依存方向を決め直す

調査時点: `workspace4` @ `3ee0aeb3`。以下に出てくる `path:line` はこの時点での着手点で、実施時はコードで確かめ直す。

## 目的

現行の `DEVELOP/CODING-RULE.md` の層境界(1.3)、配列の対応付けの禁止(1.6)、フレーム位相(1.10)、
`entity` / `motion` / `view` の定義(2.2)は、「依存の向きはともかく、とりあえず分離する」ために
置いたものである。ここに適合しているかどうかでコードを評価すると、いまの形を肯定して固定するだけになる。

この計画は、**状態の種類と、その値を誰が読むかという事実だけから規則を設計し直し**、コードをその規則へ
移す。目標とする規則は「従えば、immutable と mutable が分かれ、責務も分かれる」ものである。

いまのコードの問題は、次の3つが `src/game/` に同居していることにある。

- **1ランの mutable な正本。** シミュレーション、ステージの進行、操作状態、表示の選択。
- **表示の導出。** 状態から表示の宣言を作る処理、1体ごとの View・マーカー・軌道線、HUD のパネル、ピック判定、入力の解釈。
- **immutable な天体。** 構築時の値と時刻だけで状態が決まる。

同居していることの結果として、次が起きている。

- `src/game/` から `render/` への import が 82 ファイル・207 行ある。`hud/`・`game/hud`・`game/marker` を除く `src/game/` のうち、`audio/` を import するものが 28 ファイル、`hud/notifier` が 23 ファイル、`input/` が 22 ファイル。
- 実体の構築経路のすべてに `scene` / `Notifier` / `WorldSfx` / `FlashEffects` / `MarkerSlots` が通されている。
- 表示の選択が規則へ漏れている。
  - 計画ノードの消化は、戦闘ビューを表示しているときだけ走る。
  - 表示期間と軌道線の表示トグルが予測弧の有無と長さを決め、実シミュレーションは弧が届く範囲で積分せず弧をなぞる。
  - 主星の決定を描画 View の `stellarLight` から引いている。
- ループ音の停止が呼び出し側に散らばっている。そのうち決着時の停止は、次の sync で上書きされて効いていない。

修正後に期待する状態は、以下の規則が `DEVELOP/CODING-RULE.md` の正本になり、コードがそれに従っていること。

### 書き込む規則の案

手順 1 で、次の文面を `DEVELOP/CODING-RULE.md` に書き込む。置き換えるのは 1.3 のフォルダ境界と「設定の正本を consumer へ渡さない」「launcher/」の各節、1.6「配列に対して外部から対応付けを行う設計を避ける」の具体例の段落、1.10 の全体、2.2 の `entity` / `motion` / `view` の節。そこへ下の R1〜R11 を入れる。1.3 のうち `physics/` の正確さ・調整値・接触の各節は、層の中身の規則としてそのまま残す。

**R1. 状態の種類で層を決める。**

| 層 | 持ってよい mutable な値 | その層に入る条件 |
| --- | --- | --- |
| 定義層 | なし | 実行中に値が変わらない(定数・データ表・型・純関数) |
| 時刻層 | 結果を変えないメモ化キャッシュだけ | 構築時に決めた immutable な値と時刻 t だけで答えが決まる |
| モデル層 | 正本 | 捨てたら、ほかの層からは作り直せない |
| 導出層 | R5 の5種だけ | 捨てても、ほかの層から毎フレーム作り直せる |

- 値の置き場は「その値を捨てたら作り直せるか」で判定する。作り直せないならモデル層(ランを跨ぐならアプリ寿命の正本、R10)。作り直せるなら導出層のキャッシュ。
- 乱数で決めた値は作り直せないのでモデル層に置き、結果を保存する。乱数の系列そのものは保存しない。ランの再現性は目標にしない。

**R2. import は不変な側へだけ向く。**

- 定義層と時刻層は、どこから import してもよい。不変な値は、誰に読まれても整合性を壊さない。
- モデル層を import してよいのは、表示の導出とアプリの組み立て(`main.ts` / `launcher/`)だけ。
- 表示の導出を import してよいのは、アプリの組み立てだけ。
- 装置(`render/` / `hud/` / `marker/` / `audio/` / `input/`)が import してよいのは、定義層・時刻層と自分自身だけ。装置どうしは import し合わない。装置を import するのは表示の導出とアプリの組み立てだけ。
- 時刻層が import してよいのは定義層と時刻層だけ、定義層は定義層だけ。
- import を1本も持たないモジュール(union や定数だけの語彙)は、どのフォルダにあっても定義層として扱う。
- フォルダは層に揃える。

| フォルダ | 層 |
| --- | --- |
| `math/` | 定義 |
| `physics/` | 時刻(法則・暦・時刻系) |
| `celestial/`(新設) | 時刻(この宇宙の天体系: 天体の定義データ・系の構築・索引) |
| `theme.ts` | 定義(全配色の表とトークン。どれを使うかは settings の値) |
| `game/` | モデル(進行と視点。ゲーム内容の定義も持つ) |
| `game/viewer/`(新設) | モデルのうち視点(R4) |
| `presentation/`(新設) | 導出のうち表示の導出(意味を知る側、入力の解釈、表示担当) |
| `render/` / `hud/` / `marker/` / `audio/` / `input/` | 導出のうち装置 |
| `settings/` | アプリ寿命の正本 |
| `launcher/` / `main.ts` | アプリの組み立て |

**R3. 正本には書き手が1つあり、書くのは進行の位相だけ。**

- モデル層の値を書くのは、その値を所有するモジュールだけ。外から変えるときは、所有者が公開する命令(メソッド)を呼ぶ。
- 命令は受け付けた時点では状態を変えない。次の進行の位相の先頭で、受け付けた順に適用する。
- 外から読むときは、所有者が公開する読み取り専用の面を通す。可変オブジェクトそのものを外へ渡さない。

**R4. モデル層は「進行」と「視点」に分け、進行は視点を読まない。**

- **進行**: 規則が読む値。積分、接触、AI、ステージの進行と勝敗、計画の実行、spawn、操作対象、計画、ワープ段、一時停止。
- **視点**: ユーザーが何をどう見ているか。カメラ、ビュー、表示期間、表示座標系、軌道要素の基準、航法ターゲット、実体ごとの表示設定、他へ影響するウィンドウの開閉。
- 進行は視点を import しない。視点が進行に効いてよいのは、表示の導出がフレームごとに渡す**需要**(予測を伸ばす対象と長さ、履歴を残す長さ)だけ。
- **需要が変えてよいのは計算量だけ。** 同じ命令の列からは、需要によらず同じ進行の状態にならなければならない。
- 視点は進行を読んでよい(例: 注視対象が消えたら戻す)。

**R5. 導出層は、捨てても作り直せるものだけを持つ。**

- 導出層が持ってよい mutable な値は次の5種だけ。
  1. 結果に効く入力をすべてキーにしたキャッシュ。
  2. GPU・DOM・音声の資源。
  3. 外界の写し(押下中のキー、ポインタ、画面寸法、タブの可視状態)。
  4. 捨ててよい操作途中の状態(ドラッグ中の量、入力途中の文字、開いているメニューやプロパティ窓)。
  5. 表示を安定させるための前フレームの記憶(ヒステリシス、猶予)。
- 4 と 5 は、表示と入力の解釈以外に影響してはならない。影響するなら視点に置く。
- どれにも当たらない値は、視点か `settings/` に置く。ユーザーが選んだもの、時間をかけて積み上がったもの、他へ影響するものがこれに当たる。
- 導出層のアニメーション(遷移・寿命・フェード)は dt で積まず、開始時刻とそのフレームの実時刻から計算する。実時刻はフレームの先頭で1度だけ読み、入力として配る。

**R6. 1体ぶんの表示物は、表示の導出の中で1つの表示担当オブジェクトが持つ。**

- モデル層の実体は、表示物への参照を持たない。
- 表示の導出は、実体の族ごとに突き合わせ役を1つ置く。突き合わせ役はモデル層の実体の集合とその改版番号から、実体1つにつき1つの表示担当を作り、消えた実体の表示担当を捨てる。鍵は実体オブジェクトの同一性。突き合わせ役以外のモジュールは、表示担当を作らず、捨てない。
- 実体1つぶんの表示物は、すべてその表示担当のフィールドであり、表示担当自身の sync の中で更新する。3D の View、マーカー、軌道線、一覧の行、メニュー、プロパティ行がこれに当たる。管理者ごとに id で別々の表を持つ形にしない。
- 表示担当の具象は、実体の種別をタグとするクラス辞書で引く(セーブの復元と同じ形)。
- 集合が構築後に変わらない族(天体)は突き合わせず、構築時に1度だけ作る。
- 実体ごとの視点の値(軌道線の表示トグルなど)は、視点が同じ突き合わせで持つ記録に置く。実体のフィールドには置かない。

**R7. 装置は意味を知らず、宣言だけを受ける。**

- 装置の入力は、そのフレームに見せる(鳴らす)べきものの全体の宣言である。装置は内部で前回との差分を取る。`show` / `hide` / `set` / `play` / `stop` の類の命令 API を外へ公開しない。
- 装置の入力型は、装置が自分の語彙で定義する。実体の種別、ステージ、選択といったモデルの意味を持ち込まない。意味から装置の語彙への写しは、表示の導出が行う。
- 一回きりの出来事(効果音、通知、閃光)は、モデル層が進行の位相で記録する「直近の進行で起きた出来事」を使う。出来事には通し番号が付く。表示の導出がそれを読んで装置へ宣言として渡し、装置は同じ番号を二度扱わない。
- 装置の出力(描いた線の点列、マーカーを出したか、投影)を読んでよいのは、表示の導出の入力解釈(ピック判定)だけ。
- ブラウザの制約(音声のロック解除、タブの可視状態)は、その制約を受ける装置が自分で扱う。

**R8. フレームの位相はデータの流れに合わせる。**

1. **入力の解釈**(表示の導出): 生の入力と前フレームの装置の出力を読み、命令、そのフレームの操作量、需要を作る。
2. **進行**(モデル層): 命令を適用し、操作量と dt で進め、出来事を記録する。dt を受け取るのはこの位相だけ。一時停止中も命令は適用するが、シミュレーションは進めない。
3. **導出と同期**(表示の導出 → 装置): 読み取り面と表示時刻から表示の宣言を作り、装置へ渡す。モデル層を書かない。
4. **描画**(装置): 描画命令を発行するだけ。

- DOM イベントはフレームの外で起きるが、そこで作ってよいのは命令と R5-4 の状態だけ。
- セーブは位相 2 と 3 の間で、モデル層だけを直列化する。

**R9. 型と定数は、その値の正本の所有者に置く。**

- 値の型は、その値の正本を持つモジュールに置く。装置の入力型は装置に置き、表示の導出が写す。
- 同じ意味・同じ情報量の型を層ごとに作らない。装置が同じ語彙を要るなら、import を持たない語彙モジュールとして所有者の側に置き(R2 により誰でも読める)、装置はそれを読む。

**R10. アプリ寿命の正本と組み立て。**

- `settings/` は、ラン跨ぎのユーザー設定の正本である。パネルの折り畳みやタブ選択のように、ランを跨いで残す UI の選択もここに含む。表示の導出へは、読み取り専用の面と変更の callback で渡す。モデル層がラン跨ぎの設定を要するなら、ランの構築時の値として受ける。値の型・妥当性の判定・保存文字列との変換は、その値を解釈する層が持つ。`settings/` がそれを import してよいのは、定義層・時刻層だけを import する値の定義モジュールに限り、その範囲なら層を問わない。
- `launcher/` は、ランの外の記録(セーブスロット、解放記録)の正本を持ち、ラン(モデル層と表示の導出の組)を起こし畳む判断を持つ。
- `main.ts` は組み立てと rAF ループを持ち、R8 の位相の順序を決める。
- モデル層は `settings/` と `launcher/` を import しない。

**R11. セーブはモデル層そのものである。**

- スナップショットは、モデル層(進行と視点)の直列化である。表示の導出は含めない。読み込みはモデル層を組み直すだけで、表示の導出は突き合わせ(R6)で作り直される。
- モデル層の値のうちセーブしないものは、所有者のコメントに理由とともに書く(例: 一時停止)。
- 時刻層の天体系は、構築に使った immutable な値だけを保存する。元期、暦プロファイル、暦パック、自転初期位相、位相オフセット、系の選択がそれに当たる。

## 決めたこと

判断材料は事実だけにした。事実とは、状態の書き手と読み手、書く位相、寿命、セーブの有無、import の辺である。**現行の CODING-RULE に適合するかは判断材料にしていない。** 以下はどれもユーザーが覆せる。覆したときに変わる手順も書く。

### K1. 方針の評価と修正点

「フロントを純粋にし、mutable な正本をバックエンドへ集め、依存を逆転する」という方針は、R1〜R11 と一致する。そのうえで、事実から次の4点を修正した。

1. **逆転する相手は `render/` ではない。**
   - 直近で純粋化した `render/` は、自分の語彙で入力を定義し、game を知らない装置として正しい形にある(R7)。
   - 逆向きになっているのは、`game/` に混ざった表示の導出とモデル層の間である。
   - したがって「import 方向の逆転」は、表示の導出を `presentation/` へ出し、`presentation → game` の向きにすることで実現する。`render/` が `game/` を読む形にはしない。
   - 覆して2層(render/hud がモデルを直接読む)にする場合: 手順 20〜23 が変わり、render の入力型をモデルの読み取り面へ置き換える作業が加わる。
2. **「mutable ≈ セーブされる領域」は、R11「モデル層 = セーブ対象」として規則にできる。** ただし現状では、モデル層に入る値の一部がセーブされていない。ワープ段、表示期間、軌道要素の基準、基地の計画、creative の手動 spawn 設定、デバッグステージの状態がそれに当たる。どれをセーブへ加えるかは保存形式の変更を伴う仕様判断なので、**この計画では保存形式を変えず、加えない値は R11 に従って所有者に理由を書く**。
3. **天体系は「パック + 元期 + 時刻」だけでは決まらない。** 自転初期位相・位相オフセット・系の選択(ステージが決める原点と星系)も要る。これらを1つの immutable な構築値として扱えば、時刻層として救出できる(手順 18)。
4. **1体の表示物の持ち方は「実体に分散」でも「全知の層 + id の対応表」でもない。**
   - R6 のとおり、表示の導出の側で**実体ごとに1つの表示担当へ分散**させ、生成と破棄だけを族ごとに1つの突き合わせ役が行う。
   - 実体側に表示物の参照(不透明な型のフィールドへ具象を注入する形)を置く案は採らない。理由は次の3つ。
     - 表示の導出側で具象へ戻すのに、型アサーションか全体に及ぶ型引数が要る。
     - update 中に生まれる弾・破片の構築経路のすべてに、工場を通すことになる。これは今の `scene` / `WorldSfx` / `MarkerSlots` の貫通と同じ形である。
     - モデル層が表示物の寿命を持ち続ける。
   - 管理者ごとの id 対応表(いまの軌道線、マーカーの文字列キー、赤道交点の Map)は、別々の表が別々に整合を取る形なので採らない。

### K2. 規則を当てた結果(置き場の判定)

| 状態・モジュール | 置き場 | 根拠(事実) |
| --- | --- | --- |
| 操作対象(`control-selection.ts`) | 進行 | AI の追尾(`enemy.ts:339-355`)、交戦範囲外の弾の消滅(`bullet-reaction.ts:63-64`)、ステージの補給・勝敗(`stage.ts:222`)が読む |
| 計画・計画実行モード・`fineAttitude` | 進行 | 'instant' の実行(`creative-stage.ts:184-205`)と、角加速度の上限(`throttle.ts:241`)が読む |
| ワープ段・`autoWarpUntil` | 進行 | 積分の刻み(`simulator.ts:81-92`)、AI の射撃可否(`enemy.ts:347`)、接触(`engagement-zone.ts:51`)、補給(`logistics.ts:129-139`)が読む |
| 一時停止 | 進行(セーブしない) | `advanceSimulation` 全体を止める(`game.ts:378`)。停止中の自動セーブは意図して抑止している(`autosave.ts:22`) |
| 敵の識別色 `accent` | 進行の不変な属性 | 同じ色の敵を1集団として、同時に攻撃する数を制限している(`enemy.ts:385`) |
| `orbitLineColor`・名前 | 実体の不変な属性 | 表示とセーブだけが読む。不変なので実体が持ってよい(R2) |
| 航法ターゲット(id と名前) | 視点 | 読むのは表示・予測の需要・ピック判定だけ。AI・ステージ・simulator からの参照は無い |
| `Targeter.aliveTarget` | 導出 | NavTarget と roster から毎回計算している(`nav-target.ts:140-143`) |
| `Targeter.boardMarks` | 導出(出来事から作る) | 読むのは的のマーカーだけ(`targeter.ts:242-252`)。材料は、弾が的面を通過したという出来事 |
| カメラ(注視・offset/pan/up・FOV・投影・基準面・回転モード・追従) | 視点 | 規則・予測・音は読まない。セーブはされる(`focus-camera.ts:661-683`) |
| ズームの遷移・猶予カウンタ・`viewpoint` | 導出(R5-5 と計算値) | 状態と入力から毎フレーム求まる |
| ビュー(戦闘/マップ) | 視点 | 予測の範囲に効く経路が4本ある。規則に効く2本は後述の SPEC 判断で断つ |
| 表示期間・スライダー・任意期間・目盛りラベル・通過時刻併記 | 視点(セーブしない) | 予測の horizon と履歴の保持長を決める(`game.ts:385, 401`)。これは需要として渡す |
| 表示座標系・`followCamera` | 視点 | 表示だけが読む。`followCamera` の正本は HUD の public フィールド(`trajectory-frame-panel.ts:20`)にあるので、視点へ移す |
| 軌道要素の基準モード | 視点(セーブしない) | 表示だけが読む(`orbit-reference.ts:54`) |
| 軌道分析ウィンドウの開閉 | 視点 | 予測の需要に効く(`orbit-analysis-window.ts:31-32`) |
| プロパティ窓・部品窓・軌道線窓の開閉 | 導出(R5-4) | ほかに影響しない。中の軌道線トグルは視点の値を書く命令にする |
| PlanEditor の選択ノード | 導出(R5-4) | 読むのは入力の解釈と表示だけ |
| 実体ごとの軌道線表示トグル、タンパク質の表示設定 | 視点の記録(R6) | 読むのは表示・予測の需要・セーブ。当たり判定は表示設定によらない(`protein-enemy.ts:106-109`) |
| 予測(`Predictor`・`predictedArc`) | 進行が持つメモ化 | 実シミュレーションは弧が届く歩で積分をせず弧をなぞる(`dynamic-motion.ts:306, 419-424`)。R4 の「需要は結果を変えない」を満たすことを手順 11 で確かめる |
| 予測を読む者のフラグ3種 | 廃止し、需要の入力にする | 導出側が進行のフラグを書いている(`entity-line-manager.ts:68`、`orbit-analysis-window.ts:31`、`nav-target.ts:101`)。分析窓の `dispose` が呼ばれず、フラグが残る不具合もある |
| 閃光 `FlashEffects` | 導出(出来事から作る) | 読むのは `FlashEffectsView` だけ(`game.ts:562`)。寿命は、発生した時刻と表示時刻から計算する |
| ループ音(推進・RCS) | 導出(状態から導く) | 操作対象・生存・推力とトルク・一時停止・決着から決まる |
| 効果音・ヒント・トースト | 出来事 → 導出 | 文言は表示の導出が組む。出来事が持つのは種別と値だけ |
| BGM | 装置が「ランの状態」の宣言から導く | どの曲を流すかは Conductor が決め、開始と停止だけを launcher が決めている |
| 音声のロック解除 | 装置(audio の内部) | ブラウザの制約(R7) |
| `FrameAnchors` の猶予、`NearbySystemTracker`、ラベル間引きのヒステリシス | 導出(R5-5) | 積分と予測には効かない。表示とピック判定だけに効く |
| 自転初期位相・位相オフセット・元期・暦 | 時刻層の構築値(R11) | 自転初期位相を読むのは表示とセーブだけ(地球は `c22: 0`)。位相オフセットはケプラー軌道の初期位相に効く |
| 主星の決定 | 時刻層(天体の分類から決める) | いまは描画 View の `stellarLight` から決めていて(`celestial-system.ts:142`)、自機と敵の散布(`fire-control.ts:313`、`enemy.ts:411`)へ届いている |
| 描いた線の点列、マーカーを出したか、計画折れ線が抱える射影 | 導出の入力解釈が装置の出力を読む(R7) | 読み手はピック判定と計画の編集だけ |
| タンパク質の当たり判定の幾何(`render/protein/protein-anchors.ts`) | 定義層(純粋な幾何) | 規則(`protein-enemy.ts:10`)が装置の中の関数を呼んでいる |
| 配色 `theme.ts` の `activePalette` | settings の値 → 導出の入力 | 設定を切り替えると再読み込みなしで反映される(`main.ts:155`) |
| `panel-shell.ts` の `currentView`・折り畳みとタブの localStorage | 視点の読み取り / settings | ビューの写しをモジュール変数に持っている。ランを跨ぐ UI の選択は R10 により settings |
| エンティティの採番(`EntityIdAllocator` の static) | 進行(ランのインスタンスが持つ) | モジュール寿命の可変状態で、ランを跨いで残る |
| creative の spawn 距離・表示設定・連番 | 進行 | spawn の規則が読む。陣形の連番は保存されず、復元後に既存の陣形 id と衝突しうる |
| ステージの StatusPanel・ステージごとの UI・結果とブリーフィングの文面 | 表示の導出(ステージクラスごとの表示) | ステージの挙動は一般化しない。表示も同じく並列に置く |
| 入力の連打判定(`throttle.ts:145` の実時刻ラッチ) | 導出の入力解釈 | 入力の解釈そのもの |
| `Hud`(ページの寿命)と game 用パネル(ランの寿命) | 前者は装置、後者は表示の導出 | 寿命が違うものを1つにまとめている |

### K3. 規則が強いる仕様判断

規則に従うと挙動が変わる箇所がある。**先に SPEC を直す(`/modify-feature`)。**

1. **計画ノードの消化**(期限切れの破棄と達成。`plan-guide.ts:44, 126`)を、ビューによらず進行の規則として行う。いまは戦闘ビューを表示しているときだけ走る。→ `DEVELOP/SPEC/PLAN.md` を手順 11 で直す。
2. **マップを閉じたときの空ノード削除**(`plan-editor.ts:566-579`)は、「計画の編集を閉じる」という命令にする。挙動は変えない。
3. **音**(`DEVELOP/SPEC/AUDIO.md` への追記。手順 5)。
   - 一時停止中と勝敗確定後は、エンジン音と RCS の連続音を鳴らさない。
   - タブが非表示のあいだは、効果音も BGM も止め、表示に戻ったら再開する。
   - BGM はランの中(開始から勝敗確定まで)でだけ鳴り、タイトル画面と結果画面では鳴らない。
   - 勝敗確定後は、音量を変えても BGM は鳴り始めない。
   - 最初のユーザー操作による解禁は、タイトル画面や HUD のボタンの操作でも起きる。

   このうち「勝敗確定後に音量で BGM が蘇る」は、既存の文面(勝敗確定で BGM はフェードアウトする、確定後は設定画面を閉じても無音のまま)に反する不具合なので、仕様は変えない。
4. **需要と積分の結果**(R4)。実シミュレーションが予測弧をなぞった結果と、直接積分した結果が一致するかは確定していない。手順 11 で検査を書く。一致しない場合は物理的な正確さの問題なので、なぞるのをやめるか近似として受け入れるかをユーザーに問う。

### K4. 置き場の名前

新設するのは `src/presentation/`・`src/celestial/`・`src/game/viewer/`・`src/marker/` の4つ。名前だけの変更なら手順 4・13・14・20・21 のパスが変わるだけ。

**`src/marker/` は `hud/` にも `render/` にも入れない**(当初は `hud/marker/` としていたのを、次の事実で覆した)。

- **入力の語彙が別物である。** HUD の語彙はパネル・行・窓、マーカーの語彙は「投影された点・優先度・間引き」である。R7 が装置を分ける基準は入力の語彙であって、出力が DOM かどうかではない。
- **`render/` へ入れる根拠が無い。** マーカーが使う投影は render ではなく `game/camera/camera-system.ts:141` が `math/projection`(純粋なピンホール)から作っている。render に置くと、いま存在しない「render のカメラ・canvas を読む」依存を新たに作ることになる。マーカーは DOM で、`#hud` の重なり順とモーダルの遮蔽幕に従い、クリックでピックされる — GPU の装置とは資源も寿命も別である。
- **`hud/` の中でも独立できる。** マーカーが要る DOM は `HudShell`(`src/hud/hud-shell.ts`)が作る `layers.marker` だけで、`HudShell` は `main.ts:122` が組み立てて `Hud`・`Launcher`・`ResultScreen` へ配っている**組み立て所有の画面の器**である。`Launcher` と同じ形で装置へ渡せるので、`hud/` を import する必要はない。
- **引き出し線の SVG も共有ではない。** `svgOverlay` を読むのは `LabelLayout` だけで(`game/hud/hud-root.ts:393` が `layers.marker` の中に作っている)、装置が自分の層の中に自分で作れば共有は消える。
- **これが決め手**: この計画ではフォルダ = 装置 = `check:boundaries` が1つの塊として扱う単位である(手順 2)。`hud/marker/` に置くと、いま実在する `marker → hud/windows/property-window-content`・`hud/utils` の辺(`apsis-marker.ts:9`、`lagrange-point-marker.ts:4` ほか計8本)が装置の内部 import になり、検査が二度と捕まえられない。兄弟フォルダにすれば違反として出る。

### K5. 並行している作業との調整

- **未配線の足場。** `src/game/input/{game-actions,game-commands,game-input-router}.ts`、`src/game/pickable/entity-inspection.ts`、`src/game/dynamic/{dynamic-presenter,entity-lifecycle}.ts` は、mikanixonable が 2026-09-11 に追加したもので、どこからも import されていない。
  - これらは、その手順(入力 = 手順 12、表示担当 = 手順 14・15)で採否を決める。
  - 採るのは、R2 と R6 に合う形に直せる場合だけ。消すときは作者の合意を得てから消す。
- **このリポジトリに無いコミット。** mikanixonable は「HUD の Game 依存の除去、保存境界、フレーム Coordinator の分割を実施済み」と記録している。しかし該当するコミット(`0a41653e`・`a4de2a7a`・`e8fad089` など)は、このリポジトリのどのブランチにも存在しない。
  - 手順 8 と 23 に着手する前に作者へ確認する。その作業が存在するなら、先に取り込んで重複を避ける。
- **雲。** 雲の描画(`src/render/cloud/`)は別の作業が進んでいる。この計画で雲に触れるのは、手順 3 の `R_EARTH` の注入(`atmospheric-wind.ts:5`)だけ。

## 達成目標

1. `DEVELOP/CODING-RULE.md` に R1〜R11 が正本として書かれ、置き換え前の 1.3 のフォルダ境界・1.10 の文面が残っていない。
2. `npm run check:boundaries` が、**空の許可リスト**で終了コード 0 を返す。この検査が機械的に判定する規則は次のとおり。
   - R2 の import 表
   - `game/viewer/` 以外の `game/` が `game/viewer/` を import しないこと(R4)
   - 装置が装置・モデル・表示の導出を import しないこと(R7)
3. モデル層の実体が表示物・装置を持たない。`rg -n "DynamicView|WorldSfx|UiSfx|Notifier|MarkerSlots|FlashEffects|from 'three" src/game` が 0 件。
4. `src/celestial/` が存在し、そこから `physics/` と `math/` 以外への import が 0 件になる。`rg -n "game/celestial" src tests tools DEVELOP CLAUDE.md .claude/skills` が 0 件。
5. 装置が命令 API を公開していない。
   - `rg -n "ensureStarted|\.unlock\(|setThrust|setRcs|applyGraphics|setFixedBrightnessScale" src` が 0 件。
   - marker の公開面が「宣言を受ける sync」と「表示したかの問い合わせ」だけになる。
   - `src/marker/` が独立した装置として存在し、ほかの装置との import が双方向とも 0 件になる。
6. 予測を読む者のフラグ(`trajectoryReader` / `analysisPanelReader` / `navTargetReader`)が `src` から 0 件になる。予測弧をなぞる積分について、R4 の検査(手順 11)が通るか、ユーザーの判断が記録されている。
7. 保存形式が変わっていない。手順 1 の前に書き出したセーブファイルが、最終手順の後に読み込めて、同じ位置・同じ操作対象・同じカメラで再開する。
8. `npm run typecheck`、`npm run test`、`npm run build`、`npm run smoke:browser` が通る。

## 手順

### 段 0 — 規則を先に置く

#### 手順 1. 規則を `CODING-RULE.md` に書く

**目的**: R1〜R11 を正本にする。コードは後から追いつかせる(SPEC がコードに先行するのと同じ扱い)。この時点では挙動もコードも変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `DEVELOP/CODING-RULE.md` | 1.3 のフォルダ境界・「設定の正本を consumer へ渡さない」・「launcher/ が game/ を見てよいのは…」を R1・R2・R9・R10 と層の表で置き換える。1.6「配列に対して外部から対応付けを行う設計を避ける」の具体例を R6 に置き換え、原則は残す。1.10 を R8 で置き換える。2.2 `entity` / `motion` / `view` を R4・R6・R7 に合わせて書き換える(`entity` はモデル層の「動きとゲーム上の意味」の統合、表示物は表示担当が持つ)。R3・R5・R11 を新しい節として足す |
| `.claude/skills/**/SKILL.md` | `rg -n "update → sync|update/sync|1\.10|1\.3|2\.2" .claude/skills`(`.claude/worktrees` は除く)で出る箇所を、新しい節番号と R8 の位相名へ揃える |
| `CLAUDE.md` | 触らない(コマンド表は手順 2・20・21 で足す) |

**達成条件と検証**

- `rg -n "physics/ と render/ の両方に依存する部分のみ|update → sync → render" DEVELOP/CODING-RULE.md` が 0 件。
- R1〜R11 の見出しがあること: `rg -n "^\*\*R(1|2|3|4|5|6|7|8|9|10|11)\." DEVELOP/CODING-RULE.md`。
- `npm run typecheck`(文書の変更なので形式確認)。

#### 手順 2. 境界の機械検査を入れる

**目的**: 規則との距離を数え、増えないようにする。許可リストには、手順 2 時点の違反を「目標までの残り」として載せる。許可リストは減ることしか許さない。検査するのは**新しい規則だけ**である。この時点で挙動は変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `tools/check-boundaries.mjs`(新規) | `src/` の相対 import・`export … from`・動的 import・パッケージ import(`three` 系)を解決する。各ファイルを層の対応表で層に割り当て、R2 の表・R4(`game/viewer/` への片方向)・R7(装置どうし、装置 → モデル・導出)で判定する。import を持たないモジュールは定義層として扱う。層の対応表は現在のパスを目標の層へ割り当てる。例: `game/hud/**`・`game/marker/**`・`game/view/**`・`game/pickable/**`・`game/lines/**`・`game/map/**` → 表示の導出、`game/celestial/solar-system/**` → 時刻、その他の `game/**` → モデル。ファイルが移るたびに表を縮める。許可リストに無い違反と、許可リストにあるのに消えた違反の両方で終了コード 1 を返す |
| `tools/boundary-allowlist.json`(新規) | 手順 2 時点の違反の辺を列挙する |
| `package.json` | `check:boundaries` を追加し、`ci` へ入れる |
| `CLAUDE.md` | コマンド表に `npm run check:boundaries` を足す |

**達成条件と検証**

- `npm run check:boundaries` が 0 を返す。
- 検査の自己検証として、次の3種類の違反を仮に1本ずつ足すと、それぞれ 1 を返すことを確かめてから戻す。
  - `src/render/` から `src/game/` へ
  - `src/game/dynamic/` から `src/game/viewer/`(空ファイルを置く)へ
  - `import type` の違反
- 許可リストの件数を commit メッセージに書き、以降の手順ごとに減ることを確かめる。

### 段 1 — 装置を宣言的にし、導出層から正本を追い出す

#### 手順 3. render から意味と命令の残りを消す

**目的**: render を R7 の装置にする。対象は、モデルの意味(マーカーの型、地球の定数、地表配信物の型、タンパク質の当たり判定の幾何)、層を越えて公開されている命令 API、壁時計の読み取りの3つ。見た目は変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/render/cloud/atmospheric-wind.ts:5`、`src/render/cloud/weather-model.ts:163` | `R_EARTH` の import をやめる。半径を `AtmosphericWindField` の構築引数にし、`WeatherModel` の構築時に渡す |
| `src/render/earth-surface.ts:4`、`src/game/celestial/solar-system/earth-surface-source.ts` | `EarthSurfaceSource` の型を消費者の render 側へ移す |
| `src/render/scene.ts:19,21`、`src/render/pipeline/render-pipeline.ts:318`、`src/main.ts:63,138,87` | `applyGraphics` の購読経路をやめる。render は描画設定を読み取り専用の面で受け、描くときに `current` を読む。再構築は値の同一性をキーにした render 内のキャッシュで行う。`game.sync` へ graphics を渡す経路と二重になっているのを1本にする |
| `src/render/pipeline/render-pipeline.ts:91`、`src/game/hud/windows/debug-info-window.ts:139` | `debugTarget` の public な可変フィールドをやめ、描画時の入力にする |
| `src/render/stars.ts:21`、`src/render/celestial/celestial-illumination.ts:64`、`src/game/celestial/celestial-system.ts:405,438` | `setFixedBrightnessScale` の中継をやめる。照明から星への受け渡しを render の中で閉じる |
| `src/render/celestial/celestial-entity/point-celestial-view.ts:135`、`src/render/celestial/orbit-guide/direction-markers.ts:30` | `performance.now()` をやめ、sync の入力(フレームの実時刻)で受ける |
| `src/render/protein/protein-anchors.ts`、`src/game/dynamic/dynamic-entity/protein-enemy.ts:10` | 当たり判定が使う純粋な幾何(`proteinSiteWorldPosition` / `proteinLocalImpactPoint`)を `physics/` へ移す。render と規則の両方がそこを読む |

render → `game/marker` の 9 本は手順 4 で扱う。

**達成条件と検証**

- `rg -n "from '.*game/" src/render` の結果が `game/marker` の行だけになる。
- `rg -n "performance\.now" src/render` の結果が計測用(`gpu-timings.ts`・`protein-runtime.ts`・`protein-enemy-view.ts`)だけになる。
- `rg -n "applyGraphics|setFixedBrightnessScale|debugTarget\s*=" src` が 0 件。
- `npm run typecheck`、`npm run test:render`、`npm run test:game`。
- 絵が変わりうるので確かめる。
  - `npm run render-lab:shot` を手順の前後で撮り、地球・雲・星野の明るさを比べる。撮影は memos 内の `baseline.json` を書き換えるので、撮ったら戻す。
  - `npm run dev` で一時停止メニューの描画品質を切り替え、即座に反映されることを見る。

#### 手順 4. マーカーを宣言的な装置にする

**目的**: マーカーを R7 の装置にする。いまは文字列キーの外部辞書へ `set` / `hide` / `setPosition` などの命令で書く形になっている。これを、持ち主ごとのマーカー群が毎フレーム宣言を受ける形へ変える。装置は `hud/` でも `render/` でもなく、独立した `src/marker/` に置く(根拠は K4)。挙動は変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/marker/{marker-manager,marker-slots,marker-visibility,label-layout,label-declutter,marker-shapes,celestial-label-hiding}.ts` | `src/marker/` へ移す。持ち主はマーカー群(構築時に得て自分で破棄する)の `sync(宣言の列)` を毎フレーム呼ぶ形にする。装置は群ごとに DOM プールと差分を持つ。群を跨ぐ重なりの解消(`resolveCollisions`)は同期の最後に1回だけ行う |
| `src/game/marker/crowding.ts` | 間引きのアルゴリズムは `src/marker/` へ移す。`MARKER_PRIORITY` の表は意味なので、表示の導出(当面は `game/marker/`)に残す |
| `src/main.ts:122`、`src/game/game.ts:209` | 装置の構築を `main.ts` へ上げ、`shell.layers.marker` を渡す(`Launcher` が `HudShell` を受けているのと同じ形)。`Game` は装置を持たない。手順 23 で位相の組み立てへ合流する |
| `src/game/hud/hud-root.ts:126-136,393` | 引き出し線の SVG を HUD で作るのをやめる。装置が自分の層の中に作り、`Hud.svgOverlay` の公開をやめる |
| `src/game/hud/style/marker-style.ts`、`src/game/hud/hud-root.ts:10,24-26`、`src/game/hud/style/skeleton-style.ts:30` | CSS を2つに割る。構造(`.mk` / `.sym` / `.lbl` / `priority-hidden` / 引き出し線 / `--z-mk-*` / `--mk-scale-*` / `#hud .mk` の `user-select`)は装置が自分で注入する。種別ごとの色と字送り(`.mk-enemy`・`.mk-target`・`.mk-base` など、`marker-identity.ts` の色を読む枝)は意味なので表示の導出が注入する。HUD の STYLE 連結から `MARKER_STYLE` を外す |
| `src/game/marker/grouped-markers.ts` | 宣言の列を受ける形はすでにあるので、装置の群の上に載せ替える |
| `src/game/marker/marker-manager.ts:296-304` | `setTimeout` によるフェードの確定をやめ、sync の実時刻から計算する |
| `src/input/input.ts:333`、`src/game/game.ts:272-276` | 長押しのフィードバックを、タイマーからの即時描画をやめて「長押し中か」という入力の写しから毎フレーム宣言する |
| 命令を呼んでいる側 | 各持ち主の群への宣言に置き換える: `targeter.ts:190-269`、`plan/plan-display.ts:164-392`、`plan/plan-guide.ts:62-97`、`nav-target.ts`、`marker/{equator-node-manager,equator-node-marker-pair,equator-node-marker,apsis-marker,relative-node-marker,orbit-point-marker,lagrange-point-marker,lead-markers,player-markers,celestial-markers,celestial-sub-labels}.ts`、`creative/object-placement.ts`、`view/{combat-view.ts:111,map-view.ts:137}`(`hideLabels`) |
| `MarkerSlots` を受け渡しているだけの側 | 引数から消す: `celestial/celestial-system.ts`、`dynamic/dynamic-system.ts`、`dynamic/dynamic-entity/{base,entity-dictionary}.ts`、`player/player.ts`、`stages/stage.ts`、`pickable/map-picking.ts` |
| render の View | マーカーに触れなくする: `render/dynamic/player/player-view.ts:5,11,75,135,151`(`PlayerMarkers` の所有をやめ、持ち主を `Player` へ移す。手順 15 で表示担当へ移る)、`render/dynamic/dynamic-entity/base-view.ts:10,89-90`、`render/celestial/celestial-entity/{celestial-view.ts:18,point-celestial-view.ts:23,geostationary-overlay.ts:10-11,107-121}`(静止軌道のマーカーは天体側の持ち主が宣言する)、`render/creative/object-placement-preview-view.ts:3,8,43-52` |
| ピック判定 | `map-picking.ts:85` の `shows` は、装置の出力の問い合わせとして残す(R7) |

配置プレビューの ▷ マーカーは、`fadeOut` と `hide` がコメントと逆向きになっている。この手順では挙動を保ち、そのまま移す。

装置の CSS は `#hud-layer-marker` の中に置かれたままなので、`#hud` を冠した枝を持つ HUD 側の指定(`#hud .mk .lbl { margin-top }` など)に負ける。装置へ移した構造の CSS は、無印クラスだけで書かず `#hud` を冠した枝を併記するか、自分の層の id へ冠を付け替えて、詰め幅が黙って 0 にならないことを目で確かめる。

**達成条件と検証**

- `rg -n "game/marker" src/render` が 0 件。
- `rg -n "MarkerSlots" src` が 0 件。
- `rg -n "setTimeout" src/marker` が 0 件。
- 装置が孤立していること: `rg -n "from '.*(hud|render|audio|input)/" src/marker` が 0 件、`rg -n "marker/" src/hud src/render src/audio src/input` が 0 件。
- `npm run typecheck`、`npm run test:render`、`npm run test:game`、`npm run check:boundaries`(許可リストから該当行を消す)。
- `npm run dev` で次を見る。
  - 戦闘ビュー: 敵・基地・補給のマーカー、ターゲット強調、リード
  - マップビュー: 天体ラベルの間引き、アプシス・交点・ラグランジュ点のマーカー、静止軌道のマーカー
  - 長押しのフィードバック
  - creative の配置プレビュー
  - マーカーのクリックで選択できること

#### 手順 5. 音の仕様を補う

**目的**: K3-3 の挙動を `DEVELOP/SPEC/AUDIO.md` に書き、手順 6 の目標を確定させる。コードは変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `DEVELOP/SPEC/AUDIO.md` | `/modify-feature` を通す。「エンジン・RCS」に「一時停止中・勝敗確定後は鳴らない」を、「開始・終了」に「タイトル画面・結果画面では鳴らない」「勝敗確定後は音量を変えても鳴り始めない」「最初の操作はタイトル画面や画面上のボタンの操作でもよい」を足す。「タブが非表示のあいだは効果音・BGM とも止まり、戻ると再開する」の節を足す |

**達成条件と検証**: 上の5つの文が AUDIO.md にある(`rg -n "一時停止中|タイトル画面|非表示" DEVELOP/SPEC/AUDIO.md`)。

#### 手順 6. audio を宣言的な装置にする

**目的**: audio を R7 の装置にする。ループ音は状態から導き、呼び出し側に散っている停止を消す。BGM は「ランの状態」の宣言から導く。ロック解除とタブの可視状態は audio が自分で扱う。挙動は手順 5 の SPEC に合わせて変わる。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/audio/audio-engine.ts:18` | `unlock` を公開しない。最初のユーザー操作を document の pointerdown/keydown(capture)で自分で待つ。`visibilitychange` で suspend / resume する |
| `src/audio/bgm/bgm.ts:41,48,88,91-97,102,109,125` | `ensureStarted` / `resume` / `stop` を消し、ランの状態(鳴らす / 鳴らさない)を冪等に受ける口にする。`setVolume` から「正なら start」の副作用を外す |
| `src/audio/sfx/world-sfx.ts:283-291,39-40` | `setThrust` / `setRcs` を、2つの連続音の宣言を1回で受ける形にする。`dispose` 後に `??=` で組み直さない |
| `src/game/controlled-loop-sfx.ts:12-18` | 導出の条件に一時停止と決着を入れる |
| `src/game/stages/stage.ts:163-164`、`src/game/game.ts:328-329`、`src/game/control-selection.ts:45` | 散っている停止の呼び出しを消す |
| `src/launcher/launcher.ts:155-158,167,174` | `onUserGesture` への解禁の配線と、`resume` / `stop` をやめる。ランの状態が変わる箇所(開始・決着・タイトルへ戻る)で BGM へ状態を渡す |
| `src/input/input.ts:86` | 使い手が無くなる `onUserGesture` を消す |
| `src/hud/panels/bgm-settings-panel.ts`、`src/hud/windows/settings-view.ts:118-119` | 試聴は設定画面という1つの UI が操る装置の機能として残す。ゲームとの境界ではない |

**達成条件と検証**

- `rg -n "ensureStarted|\.unlock\(|bgm\.stop\(|bgm\.resume\(|setThrust|setRcs" src` が、audio 内部の定義以外で 0 件。
- `npm run typecheck`。
- `npm run dev` で次を確かめる。
  1. タイトル画面の最初のクリックで音が解禁される(ランを始めると BGM が鳴る)。
  2. 制限時間で決着するステージで推進キーを押し続けても、結果画面で推進音が止まる。
  3. 決着後に一時停止メニューで音量を動かしても、BGM が鳴らない。
  4. タブを切り替えて戻ると、音が止まってから再開する。
  5. 進行中のランからタイトルへ戻ると、BGM が止まる。
  6. 一時停止メニューを開くと、推進音が止まる。

#### 手順 7. 導出層から正本を追い出す(HUD と配色)

**目的**: HUD とテーマが持っている正本を、R4 と R10 の置き場へ移す。対象は、ユーザーの選択の正本、他へ影響する UI 状態、ビューの写し、モジュール変数の3つ。挙動は変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/frame/trajectory-frame-panel.ts:20,38,45,49`、`src/game/hud/frame/frame-controls.ts:78-91` | `followCamera` の正本を表示座標系の所有者(`display-window-manager.ts`、手順 13 で視点へ移る)へ移す。パネルは値を受けて表示し、切替は命令にする。`FrameControls.update` の位相違反(update 中に `displayFrame` を書く)をやめ、所有者の規則にする |
| `src/game/hud/panel-shell.ts:25-27,87`、`src/game/view/view-manager.ts:65` | モジュール変数 `currentView` をやめ、ビューを sync の入力で受ける。折り畳み状態の localStorage を `settings/` の設定値に移す |
| `src/game/hud/panels/orbit-guide-tab.ts:96,107`、`src/game/hud/panels/view-options-panel.ts:40,50,182,188,193`、`src/game/hud/panels/zero-velocity-section.ts:39`、`src/game/hud/view-badge.ts:95` | タブ選択の localStorage を `settings/` へ移す。鏡映し(設定値の写し)を持つのをやめ、sync で受けた値から描く |
| `src/game/hud/panels/view-options-control.ts:26-47`、`src/game/game-host.ts:15-17`、`src/game/run-setting.ts`、`src/main.ts:172-174`、`src/game/view/map-view.ts:60` | 書き込める `RunSetting` を渡すのをやめる。読み取り専用の面と変更の callback で受け、callback が `settings/` へ書く。`run-setting.ts` は消す |
| `src/game/hud/hud.ts:116-137`、`src/game/view/view-manager.ts:64-69` | ビュー切替のたびに DOM をレール間で動かす処理(`Hud.setView`)と、`applyChrome` での写しの押し込みをやめ、ビューを sync の入力にする。`forceCurrent` は `view !== 'map'` から導く |
| `src/theme.ts:117,486,504`、`src/settings/theme-setting.ts:6`、`src/main.ts:155` | `activePalette` のモジュール状態をやめる。選択中の配色 id を `settings/` の値として導出へ供給し、DOM へ CSS を反映するのは hud の装置が行う。3D 描画へ渡す色は、sync で配色から引く |
| 二段初期化 | 構築時の引数にする: `hud.ts:98`(`vesselPanel.setInput`)、`game.ts:262-266`(`burnManagementPanel.setHandlers`)、`hud.ts:72`(`setOpenAnalysisHandler`)、`object-windows.ts:73,77`(`onSelectRight` への代入) |
| `src/game/hud/panels/physical-object-list-head.ts` | どこからも import されていないので消す |

**達成条件と検証**

- `rg -n "localStorage" src/game src/theme.ts` が 0 件。
- `rg -n "RunSetting|setInput\(|setHandlers\(|setOpenAnalysisHandler\(" src` が 0 件。
- `rg -n "^let |^export let " src/theme.ts src/game/hud/panel-shell.ts` が 0 件。
- `npm run typecheck`、`npm run test:settings`、`npm run test:game`。
- `npm run dev` で次を見る。
  - パネルの折り畳みとタブの選択が、再読み込み後も残る(保存鍵の形式が変わっていない)。
  - 配色の切り替えが、再読み込みなしで HUD と 3D の両方に反映される。
  - 表示座標系の「カメラに追随」の切り替えが効く。

#### 手順 8. HUD を読み取り面と命令の口だけで繋ぐ

**目的**: HUD のパネルとモデルの繋ぎ方を揃える。モデルから受けるのは、パネルごとの値(パネルの隣に定義する型)だけにする。モデルへ返すのは、所有者が公開する命令だけにする。挙動は変えない。

**着手前に確認すること**: K5 の、このリポジトリに無い作業が存在するかを作者に確かめる。存在するなら先に取り込む。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/hud/hud.ts:87-106`、`src/game/hud/orbit/orbit-panel.ts:6,56-57,34`、`src/game/hud/orbit/orbit-analysis-window.ts:12,38,100,110,125` | `Game` を丸ごと受けるのをやめ、パネルごとの値で受ける。`orbitReference.setMode` の直接呼びを命令にする。軌道要素の基準の解決(`game.ts:531-536`、`orbit-panel.ts:70`、`orbit-analysis-window.ts:125` に重複)を1回にまとめ、その結果を渡す |
| `src/game/hud/panels/{vessel-panel.ts:151-161,183-189,top-bar.ts:17-19,31-39,target-panel.ts:41,62,enemies-panel.ts:41-43}`、`src/game/hud/view-badge.ts:71-73,104,133` | 具象型(`Controllable`・`Stage`・`CameraSystem`・`Targeter`・`SimSpeedManager`・`ViewManager`)を受けるのをやめ、値で受ける。`instanceof ProteinEnemy` を消す。`power/radiator.toggle`・`setSpeed`・`setView` を命令にする。`top-bar` の初回 sync でのリスナー登録を構築時へ移す |
| `src/game/hud/frame/{camera-frame-panel.ts:54-96,camera-rotation-mode-control.ts:12,combat-camera-panel.ts}` | `FocusCamera` の setter の直接呼びを命令にする |
| `src/game/marker/lead-markers.ts:20-26` | `Player` を受けるのをやめ、値で受ける |
| `src/game/run-summary.ts:7` | `Game` を受けるのをやめ、要約に要る値で受ける |
| `src/game/game.ts` | パネルごとの値を組み立てて渡す(手順 23 までの暫定の置き場) |

**達成条件と検証**

- `rg -n "import type \{ Game \}|import \{ Game \}" src/game/hud src/game/run-summary.ts` が 0 件。
- `rg -n "instanceof" src/game/hud` が 0 件。
- `rg -n "\.setSpeed\(|orbitReference\.setMode|viewManager\.setView|\.toggle\(\)" src/game/hud` が 0 件。
- `npm run typecheck`、`npm run test:game`、`npm run check:boundaries`。
- `npm run dev` で次を見る。
  - 戦闘とマップの常設パネル
  - 軌道分析の3タブ
  - ワープの選択
  - 軌道要素の基準の切り替え
  - ビューバッジからのビュー切り替え
  - カメラ枠パネルの各ボタン
  - 放熱板と太陽電池のトグル

### 段 2 — モデル層を切り出す

#### 手順 9. 命令の列を入れる

**目的**: R3 のとおり、モデル層が変わる時点を進行の位相の先頭の1か所にする。対象は、DOM イベントの中で正本を直接書き換えている箇所。挙動は、UI 操作の結果が次のフレームの進行で反映される点だけが変わる(遅れは最大1フレーム)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/game.ts`(`update` の先頭) | 受け付けた命令を順に適用する列を置く。命令の口は所有者ごとの狭い interface(所有者の隣に置く)とし、実装は列に積むだけにする |
| 手順 8 で命令にした箇所 | 列を経由させる |
| `src/game/stages/creative-stage.ts:67-78,87,93,98,103,108,113,119,124,129,133-141`、`src/game/creative/stage-controls-panel.ts` | 補給・波状攻撃のトグル、spawn、マガジン追加、燃料補充、表示設定、配置を命令にする |
| `src/game/stages/stage-debug.ts:44-68` | 敵の射撃の切り替えと spawn を命令にする |
| `src/game/pickable/part-windows.ts:33-38` | `ship.motion.radiator` / `power` の `setDeployed` を命令にする |
| `src/game/pickable/object-windows.ts:225-233` と `runMenu` を持つ実体(`player.ts:701-713`、`base.ts:306-312`、`enemy.ts:518`) | メニュー項目の実行を命令にする |
| `src/game/plan/plan-editor.ts`(DOM から `Plan` を書く `:126,:312,:351,:397,:411`) | 計画の編集を命令にする |
| `src/game/player/attached-boosters.ts:108,123-126`、`src/game/game.ts:262-266` | ブースターの操作を命令にする |

**達成条件と検証**

- 命令の口の実装の外で、DOM イベントのハンドラからモデル層のメソッドを直接呼ぶ箇所が 0 件になる。確かめ方: `/inv-callstack` で、上の各メソッドの呼び出し元が命令の適用だけであることを見る。
- `npm run typecheck`、`npm run test:game`。
- `npm run dev` で上の各操作が効くことを見る。一時停止中の操作が、再開せずに反映されること(一時停止中も命令は適用する)も見る。

#### 手順 10. 出来事の記録を入れ、モデルから音・通知・閃光を外す

**目的**: R7 のとおり、一回きりの出来事をモデル層の記録にし、表示の導出が読む形にする。対象は効果音・ヒント・トースト・閃光・的面の通過。モデル層から `WorldSfx` / `UiSfx` / `Notifier` / `FlashEffects` を消す。音の鳴り方、文面、閃光の見た目は変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| (新規) `src/game/` の出来事の記録 | 直近の進行で起きた出来事の列を持つ。各出来事は通し番号・種別・値を持つ。進行の位相の先頭で空にする(一時停止中も空にする) |
| 音を鳴らしているモデル層 | 出来事を記録する形にする: `dynamic/dynamic-entity/{bullet-reaction,bullet,debris-piece,debris-reaction,enemy,entity-dictionary,metal-enemy,protein-enemy}.ts`、`dynamic/{dynamic-system,sim-speed-manager}.ts`、`player/{altitude-alarm,attached-boosters,fire-control,player}.ts`、`stages/spawner/{enemy-generator,enemy-spawner}.ts`、`stages/stage-utils/{logistics,wave-attack}.ts`、`stages/stage.ts`、`creative/{manual-spawn,object-placement}.ts`、`control-selection.ts` |
| 通知しているモデル層 | 同上: `dynamic/dynamic-entity/base.ts`、`dynamic/nan-watchdog.ts`、`player/throttle.ts`、`stages/stage.ts:196,280,283`、`plan/plan-guide.ts`(消化の部分)。文面は表示の導出へ移し、出来事は種別と値だけを持つ |
| `src/game/vfx/flash-effects.ts` | 閃光の列をモデル層から表示の導出へ移す。発生は出来事から作り、寿命は発生時刻と表示時刻から計算する(R5) |
| `src/game/targeter.ts:79-107` | `boardMarks` を、的面の通過という出来事から表示の導出が作る形にする |
| 表示の導出(当面は `game.ts` の sync) | 出来事の列を読み、効果音・ヒント・トースト・閃光へ写す |
| `tests/game/flash-effects.test.ts`、`tests/render/flash-effects-view.test.ts` | 閃光の置き場の移動に合わせて直す |

音と通知を出しているもののうち表示の導出側にあるもの(`plan-editor.ts`、`map-picking.ts`、`view/{combat-view,map-view}.ts`)は、そのまま直接呼んでよい。

**達成条件と検証**

- 次が 0 件。
  ```
  rg -n "WorldSfx|UiSfx|Notifier|FlashEffects" src/game/dynamic src/game/player src/game/stages src/game/save src/game/protein src/game/control-selection.ts src/game/creative/manual-spawn.ts src/game/creative/object-placement.ts
  ```
- `npm run typecheck`、`npm run test:game`、`npm run test:render`、`npm run check:boundaries`。
- `npm run dev` で次を確かめる。
  - 射撃・装填・被弾・撃破・薬莢の接触・高度警報・補給・ワープの音
  - 各種ヒント
  - 閃光
  - 的面の通過マーク
  - 一時停止中に同じ音が繰り返し鳴らないこと
  - 高いワープ段でも音が現状と同程度に鳴ること

#### 手順 11. 需要を入力にし、計画ノードの消化を規則へ移す

**目的**: R4 を満たす。表示側から進行へ届く経路を、需要(フレームごとの入力)の1本にする。いまは予測を読む者のフラグ・表示期間・ビューがそれぞれ届いている。あわせて、計画ノードの消化をビューに依存しない規則にする。予測弧をなぞる積分が需要によって結果を変えないことも確かめる。挙動は K3-1 の SPEC 変更のとおり変わる。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `DEVELOP/SPEC/PLAN.md` | `/modify-feature` を通し、計画ノードの期限切れ破棄と達成が、表示中のビューによらず起きることを書く |
| `src/game/dynamic/dynamic-motion.ts:168-170,242-256` | 3つのフラグを消し、需要から伸長の対象と長さを受ける |
| `src/game/dynamic/predictor.ts:48-117` | 需要(対象の集合と horizon、計画の弧)を引数で受ける |
| `src/game/lines/entity-line-manager.ts:62-69`、`src/game/hud/hud.ts:90`、`src/game/hud/orbit/orbit-analysis-window.ts:29-33,91-107`、`src/game/nav-target.ts:95-104,167-169` | フラグを書くのをやめ、需要を作る側にする |
| `src/game/plan/plan-display.ts:140-159`、`src/game/game.ts:385-402` | 計画の弧と履歴の保持長を需要として渡す。需要を作るのは、予測器が動く前の入力の解釈の位相 |
| `src/game/plan/plan-guide.ts:44,113-133`、`src/game/view/combat-view.ts:104` | 消化の判定を進行の規則(操作対象の計画)へ移す。通知は出来事にする |
| `src/game/plan/plan-editor.ts:566-579`、`src/game/view/map-view.ts:104` | マップを閉じるときの空ノード削除を、「計画の編集を閉じる」命令にする |
| (新規) `tests/game/` の予測弧の検査 | 同じ初期状態から、予測弧をなぞって進めた状態と、弧を持たずに積分した状態を比べる。弧の長さを変えても、同じ時刻の状態がビット単位で一致することを確かめる(不変条件、CODING-RULE 4.1) |

**達成条件と検証**

- `rg -n "trajectoryReader|analysisPanelReader|navTargetReader" src` が 0 件。
- 新しい検査が通る。通らなければ、なぞりをやめるか近似を受け入れるかをユーザーに問い(K3-4)、判断を記録してから次へ進む。
- `npm run typecheck`、`npm run test:game`(`predicted-arc`・`plan`・`plan-arc-range`)、`npm run test:physics`。
- `npm run dev` で次を確かめる。
  - 軌道線を表示した敵の予測線が伸びる。
  - 軌道分析の対象と航法ターゲットの予測が伸びる。
  - マップビューにいても計画ノードが期限で消化される。

#### 手順 12. 入力の解釈をモデルの外へ出す

**目的**: 生の入力をモデルに読ませない。表示の導出が入力を解釈し、そのフレームの操作量と命令を作る。操作量は推力軸・回転・射撃・ブースターなど、命令はワープ・ターゲット切替・姿勢の微調整などである。モデル層は `input/` を import しなくなる。操作感は変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/dynamic/dynamic-entity/controllable.ts:7,37`、`src/game/dynamic/dynamic-system.ts:25,292-295` | `updateControls(input)` を、操作量を受ける形にする |
| `src/game/player/{player.ts:263,304-328,throttle.ts:145,163,198-221,fire-control.ts:159}`、`src/game/dynamic/dynamic-entity/base.ts` | キーの読み取りと連打の判定を、入力の解釈へ移す |
| `src/game/dynamic/sim-speed-manager.ts:69-100`、`src/game/targeter.ts:12,22,69-75` | キーの受け付けを入力の解釈へ移し、ワープ段とターゲットの変更は命令で受ける |
| `src/game/stages/{stage0,stage00,stage1,stage2}.ts:3` | `KEY_MAPPING` を使うブリーフィングの文面は、手順 16 でステージの表示へ移る(`input/key-mapping.ts` は import を持たないので定義層として読める) |
| `src/game/game.ts:482-498` | 入力の優先順位(オーバーレイ → ワープ → ビュー → ビュー固有)を入力の解釈へ移す |
| `src/game/input/*`(未配線の足場) | K5 のとおり、ここで採否を決める |
| `src/game/hud/touch-controls.ts`、`src/game/hud/panels/vessel-panel.ts:108,141` | 仮想キーは入力の写しとして残す |

カメラの入力(`camera-system.ts:168-206`、`focus-camera.ts:608-617`)は手順 13 で扱う。

**達成条件と検証**

- `rg -n "input/input'|from '.*input/input'" src/game/dynamic src/game/player src/game/stages` が 0 件。
- `npm run typecheck`、`npm run test:game`、`npm run check:boundaries`。
- `npm run dev` で次の操作が変わらないことを確かめる。
  - 並進・回転・射撃・スロットルの連打ラッチ・ブースター・姿勢の微調整・ワープ段・自動ワープ・T キーのターゲット・ビュー切替・一時停止
  - タッチパッド
  - 計画ノードを選択しているあいだ、推進の入力が奪われること

#### 手順 13. 視点を `game/viewer/` に集める

**目的**: R4 の視点を1か所に集め、進行から切り離す。対象はカメラ・ビュー・表示期間と表示座標系・軌道要素の基準・航法ターゲット・実体ごとの表示設定・軌道分析ウィンドウの開閉。カメラは「視点の状態」と「入力を視点の命令へ変える操作係(表示の導出)」に分ける。保存形式は変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/camera/{camera-system,focus-camera,camera-orientation,focus-target,gunsight-camera}.ts` | 注視・offset/pan/up・FOV・投影・基準面・回転モード・追従の状態とセーブを `game/viewer/` へ移す。入力の解釈(ホイール・ドラッグの感度、キー → 回転量、`camera-system.ts:168-206`)、ズームの遷移(`combatViewpoint`)、ヒントと DOM ボタン(`camera-system.ts:69,116-117`、`focus-camera.ts:387,408`)は表示の導出へ移す。フォーカスを失ったときの戻し(`focus-camera.ts:437`)は視点の規則として残す。射影の入口の二重(`activeProjection` と `CameraFrame.project`)を1つにする |
| `src/game/view/view-manager.ts` | 現在のビューを視点へ移す。`combat-view.ts` / `map-view.ts` / `view-frame.ts` は表示の導出にする |
| `src/game/display-window-manager.ts:74-81,95,141-148,175-179` | 期間・スライダー・目盛り・表示座標系・`followCamera` を視点へ移す。`PredictPanel` の所有(`:103-136`、`:231`)は表示の導出へ移す |
| `src/game/orbit-reference.ts`、`src/game/nav-target.ts:67-68,91-136` | 基準モードと、ターゲットの id と名前を視点へ移す。ターゲットの serialize を所有者に置く(いまは `game.ts:181` で Game が組み立てている)。相対交点の計算(`:158-208`)とマーカーは表示の導出にする |
| `src/game/dynamic/dynamic-entity/{dynamic-entity.ts:31,player.ts:194,613,base.ts:137,240,enemy.ts:182,451,protein-enemy.ts:87,130,145-147,219}` | 軌道線の表示トグルとタンパク質の表示設定を、視点が roster との突き合わせで持つ記録へ移す(R6)。保存形式は、セーブを組み立てる境界で実体の記録へ合成して保つ |
| `src/game/hud/hud.ts:44,77-87` | 軌道分析ウィンドウの開閉を視点へ移す |
| `src/game/game.ts:227,289` | カメラ → ビュー、窓 → ビューの遅延クロージャによる循環を、視点の読み取り面で解く |
| `src/game/save/save-data.ts:269-280` | 形式は変えない。組み立てと分解を所有者ごとに分ける |

**達成条件と検証**

- `game/viewer/` 以外の `game/` から `game/viewer/` への import が、`npm run check:boundaries` で 0 件になる。
- `rg -n "trajectoryLineVisible|displaySettings" src/game/dynamic` が 0 件。
- `npm run typecheck`、`npm run test:game`(`camera-orientation`・`focus-target`・`frame-anchors`・`map-visibility`)。
- 手順 1 の前に書き出したセーブファイルを読み込み、次が保存どおりに戻ることを `npm run dev` で見る。
  - 操作対象・航法ターゲット・カメラの視点・ビュー
  - 敵の軌道線の表示
  - タンパク質の表示

#### 手順 14. 1体ぶんの 3D 表示を表示担当へ移す

**目的**: R6 のとおり、`DynamicEntity` から View を外す。表示の導出の突き合わせ役が、実体ごとの表示担当を作る・捨てるようにする。View の構築は sync で行う(update 中に THREE を作らない)。実体の構築経路から `scene` を消す。見た目は変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| (新規) `src/presentation/dynamic/` の突き合わせ役と表示担当のクラス辞書 | roster と改版番号から、実体1つにつき1つの表示担当を作る・捨てる。`InstancedPools` の所有と、`beginFrame` / `endFrame` の駆動もここへ移す(`dynamic-system.ts:331,337`) |
| (新規) 種別ごとの表示担当 | 基地・金属敵・タンパク質敵・補給・自機・弾・破片・分離ブースター |
| `src/game/dynamic/dynamic-entity/dynamic-entity.ts:22,69-97` | `view` フィールドと `renderSource` を消す。表示入力の組み立ては表示担当へ移す |
| View を構築していた箇所 | 構築をやめる: `base.ts:129`、`bullet.ts:22`、`pickup.ts:221,248`、`metal-enemy.ts:52-54`、`protein-enemy.ts:80,110`、`detached-booster.ts:47`、`debris-piece.ts:32-41`、`player/player.ts:178`、`ship.ts:3` |
| `src/game/dynamic/dynamic-system.ts:16-19,56-72,221,323-338`、`src/game/dynamic/dynamic-entity/entity-dictionary.ts:4,26-34` | プールと描画の sync を外す。prune での `view.dispose()` を外す。`scene` の受け渡しを外す |
| `scene` を実体へ渡している spawn 経路 | `scene` を消す: `stages/stage.ts:230`、`stage0.ts:56`、`stage1.ts:43-47`、`stage2.ts:48-53`、`stage-debug.ts:37-40`、`stage-debug-load.ts:51`、`stage-utils/logistics.ts:67-81,100-114`、`stage-utils/wave-attack.ts:80-83,307`、`spawner/{enemy-generator,enemy-spawner}.ts`、`creative/{object-placement.ts:182-200,manual-spawn.ts}`、`player/fire-control.ts:354,406,436`、`player/attached-boosters.ts:121,165,187`、`dynamic-entity/enemy.ts:422` |
| `src/game/stages/stage-utils/wave-attack.ts:4,244-260` | `THREE.Color` による HSL の計算を `math/` の純関数に置き換える |
| View を読み返していた箇所 | 表示担当から読むようにする: `targeter.ts:224`(`enemy.view.siteMarkers`)、`protein/protein-motion-metrics.ts:29`(`view.motionMetrics`)、`pickable/line-pickables.ts:66`(`entity.view.lineSamples`) |
| `src/game/protein/protein-asset-loader.ts:143-156` | render の表示定義の構築とキャッシュを表示の導出へ分ける |
| `src/game/dynamic/dynamic-presenter.ts`(未配線の足場) | K5 のとおり、ここで採否を決める |
| `tests/render/{game-entity-dispose,dynamic-view-source}.test.ts` | 実体と View の関係の変更に合わせて直す |

**達成条件と検証**

- `rg -n "DynamicView|\bscene\b" src/game/dynamic src/game/player src/game/stages src/game/creative` が 0 件。
- `rg -n "from 'three" src/game/dynamic src/game/player src/game/stages` が 0 件。
- `npm run typecheck`、`npm run test:game`、`npm run test:render`、`npm run check:boundaries`。
- `npm run dev` で次を見る。
  - 弾・薬莢・破片・分離ブースターが、出たフレームから描かれる。
  - 撃破で消える。
  - セーブ読み込み後に全機体が描かれる。
  - インスタンス描画の弾がちらつかない。

#### 手順 15. 1体ぶんのマーカー・軌道線・UI を表示担当へ移す

**目的**: R6 の残りとして、実体に付随するマーカー、軌道線、一覧の行、メニュー、プロパティ行、ピック候補を表示担当のフィールドにする。管理者ごとの id 対応表を消す。実体から UI の語彙を消す。挙動は変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/lines/entity-line-manager.ts` | 表示担当が自分の軌道線を宣言する形へ解体する。ターゲット強調など族を跨ぐ判断は、フレームの入力として渡す |
| `src/game/targeter.ts:139-193`、`src/game/marker/grouped-markers.ts`、`src/game/marker/lead-markers.ts`、`src/game/marker/player-markers.ts` | 実体ごとのマーカーを表示担当が宣言する。`markerKey` の文字列対応をやめる |
| `src/game/marker/{equator-node-manager.ts:14,equator-node-marker-pair.ts,equator-node-marker.ts}` | id → マーカー対の Map をやめ、表示担当のフィールドにする |
| `src/game/dynamic/dynamic-entity/{combat-target.ts:18,ship.ts:276-300,base.ts,enemy.ts,pickup.ts}`、`src/game/player/player.ts` | `markerItem`・HP マーカーの SVG・`menuItems`・`propertyRows`・`glyph`・一覧の文言・`fmt*`・`MenuCommon`・`orbitRows`・`shows` を表示担当へ移す |
| `src/game/pickable/{inspected-object,object-pickable,listed-object,pickable-listing}.ts` | これらの契約は表示担当が実装する |
| `src/game/pickable/entity-inspection.ts`(未配線の足場) | K5 のとおり、ここで採否を決める |
| `src/game/pickable/object-windows.ts:253,261` | `instanceof Player` / `instanceof CelestialEntity` の分岐をやめ、表示担当へ委ねる |

**達成条件と検証**

- `rg -n "MenuItem|PropertyRow|ContextMenu|ObjectPickable|markerItem|GroupedMarkerItem|hud/" src/game/dynamic src/game/player` が 0 件。
- `equator-node-manager.ts` が無い。
- `npm run typecheck`、`npm run test:game`、`npm run test:render`、`npm run check:boundaries`。
- `npm run dev` で次を見る。
  - マーカー、ターゲット強調、軌道線の色と表示トグル、赤道交点
  - 右クリックメニュー、プロパティウィンドウ、一覧パネル
  - 軌道線の右クリック選択

#### 手順 16. ステージと creative から表示を外す

**目的**: ステージを進行だけにする。ステータスパネル、ブリーフィング・結果・副題の文面、デバッグ用ウィジェット、creative のパネルと配置プレビューは、ステージクラスごとの表示(表示の導出。一般化しない)へ移す。`StageDeps` から表示の型を消す。`stage.id === 'creative'` の分岐を、宣言された能力に置き換える。挙動は変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/stages/stage.ts:50-60,188,209,318-327` | `StageDeps` から `HudLayers & Notifier`・`THREE.Scene`・`MarkerSlots` を消す。StatusPanel の構築と `sync(camera, displayTime)` を外す。結果の文面(`detailHtml`)を構造化した値にする |
| `src/game/stages/{stage0,stage00,stage1,stage2}.ts` | `briefingHtml` / `hudSubStatus` / 結果の文面を、ステージクラスごとの表示へ移す |
| `src/game/stages/stage-utils/status-panel.ts` | 表示の導出へ移す |
| `src/game/stages/stage-debug.ts:44-68` | ウィジェットをステージの表示へ移す |
| `src/game/stages/creative-stage.ts:10,79,144-162,216-228`、`src/game/creative/{object-placer-panel,stage-controls-panel,slider-field,orbit-form-fields}.ts` | パネルと DOM の装着を creative の表示へ移す。検証・状態の生成・採番(`object-placement.ts` の命令部分、`duplicate-form.ts`、`placement-validation.ts`)は進行に残す。`placement-validation.ts:3` が使うラベル名は、表示の導出へ移す |
| `src/game/creative/object-placement.ts:83,105-118` | プレビューの View とマーカーを表示の導出へ移す |
| `src/game/game.ts:285`、`src/game/hud/panels/vessel-panel.ts:197` | id の分岐を、ステージクラスの静的な宣言に置き換える |
| `ObjectAuthoring`(`openObjectPlacer`) | 「UI を開け」という面をモデルから外し、表示の導出が持つ |

**達成条件と検証**

- `rg -n "hud/|render/|audio/|from 'three" src/game/stages` が 0 件。
- `rg -n "=== 'creative'" src` が 0 件。
- `npm run typecheck`、`npm run test:game`(`creative-placement-validation`)、`npm run check:boundaries`。
- `npm run dev` で全ステージについて次を見る。
  - ブリーフィング、ステータス、結果画面
  - creative の配置パネル・プレビュー・スポーン・各トグル
  - デバッグステージのウィジェット

#### 手順 17. 天体の見た目と UI を分ける

**目的**: 天体のモジュールを時刻層だけにする。対象は天体の定義、系の構築、索引、所属の問い合わせ、重力源の一覧、セーブ。見た目・View・照明と星野・グリッド・軌道ガイドの表示・ラベルの距離帯・近傍系のヒステリシス・点群の分布・地表の配信は表示の導出へ移す。見た目は変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/celestial/celestial-system.ts` | 索引・所属・重力源・セーブと、表示資源の所有(`:86-117,153-167` の build、`:377-449` の sync)を分ける。後者は表示の導出の「天体の場」へ移す。`CameraSystem` を受けるのをやめる(`:16,377,396`)。主星は、天体の分類が恒星であることから決める(`:142`)。参照軌道線の点列は表示の導出から引く(`:348-351,359`) |
| `src/game/celestial/celestial-entity/celestial-entity.ts` | 定義・運動・名前・分類だけを持つ immutable なものにする。View・マーカー・ピック・メニュー・プロパティ行は、天体の表示担当(構築時に1度だけ作る)へ移す |
| `src/game/celestial/solar-system/{earth-system,mars-system,jupiter-system,saturn-system,uranus-system,neptune-system,inner-planets,dwarf-planets,small-bodies,sun,solar-system}.ts` | 物理の宣言と運動の構築を残す。見た目(`CelestialSurface.*`、テクスチャ、光学、View の構築)は、表示の導出の天体 id をキーにした見た目の表へ移す。表に無い id は構築時に例外にする。`solarSystem` の `renderer` 引数(`solar-system.ts:72`)を消す |
| `src/game/celestial/solar-system/{earth-surface-runtime,earth-surface-source,point-field}.ts`、`src/game/celestial/{scale-grid-view,planet-distance,nearby-system-tracker}.ts`、`src/game/celestial/orbit-guide/{orbit-guide-model,zero-velocity-model,orbit-guide-settings}.ts` | 表示の導出へ移す。`orbit-guide-catalog.ts`(周期軌道のデータを非同期に読む)は時刻層に残す |
| `src/game/stages/stage.ts:102-111`、`src/game/stages/stage-debug-alt-system.ts:76-102` | 天体系の工場から `renderer` を外す。架空の天体の見た目は、見た目の表に登録する |
| `src/hud/utils.ts`(`epochUnixSeconds`) | 時刻の換算なので `physics/time/` へ移す |
| `tools/render-lab/{cases,lab,main}.ts`、`tools/cloud-lab/{lab,main}.ts` | 本番と同じ工場で組むことを保ったまま、import を直す |

**達成条件と検証**

- 時刻層に残るファイルから、`render/`・`three`・`hud/`・`game/(camera|marker|map|pickable|hud|dynamic)` への import が 0 件になる(`npm run check:boundaries` の時刻層の規則)。
- `npm run typecheck`、`npm run test:physics`、`npm run test:render`(`celestial-illumination`・`orbit-guide-view`)、`npm run test:game`(`earth-system`・`map-visibility`・`point-field`)。
- `npm run render-lab:shot` を手順の前後で撮り、惑星・地球と雲・環を比べる。
- `npm run dev` のマップビューで次を見る。
  - 惑星、環、ラグランジュ点、軌道ガイド、ゼロ速度曲線、スケールグリッド、星野の明るさ
  - デバッグステージの架空の星系

#### 手順 18. 天体系を構築値から組む

**目的**: R11 のとおり、天体系を1つの immutable な構築値から組む形にする。構築値は、元期・暦プロファイル・暦パック・形式版・自転初期位相・位相オフセット・系の選択。構築時の乱数(`game.ts:141`)は、この値を作るときに1度だけ引く。保存形式は変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/game.ts:138-143` | 元期の解決と、自転初期位相の乱数を、構築値を作る1か所へまとめる |
| `src/physics/ephemeris/ephemeris-context.ts:7-14`、`src/game/save/save-data.ts:290-293`、`src/launcher/save/snapshot-service.ts:65` | セーブの境界で、構築値と保存形式を相互に変換する。互換の照合は変えない |
| `src/game/stages/stage.ts:102-111`、`src/game/celestial/solar-system/solar-system.ts:54-61`、`src/game/celestial/celestial-system.ts:45-55,125-126,138` | 構築値だけを受け取って天体系を組む |
| (新規) `tests/physics/` の決定論性の検査 | 同じ構築値から組んだ2つの天体系が、任意の時刻で同じ状態を返す(不変条件) |

**達成条件と検証**

- 天体系の構築関数の引数が、構築値ひとつになる。
- `npm run typecheck`、`npm run test:physics`(`ephemeris-context` と新しい検査)、`npm run test:game`。
- 手順 1 の前に書き出したセーブが読み込めること。

#### 手順 19. 採番器とモジュール寿命の状態をランへ移す

**目的**: モデル層の値をモジュール寿命に置かないようにする。対象は、ランを跨いで残る採番器と、保存されない連番による id 衝突。挙動は、復元後の陣形 id が衝突しなくなる点だけが変わる。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/dynamic/dynamic-entity/dynamic-entity.ts:18`(`EntityIdAllocator` の static)、`base.ts:49`、`pickup.ts:41-42`、`src/game/player/booster-stack.ts:6` | 採番器をランのモデルのインスタンスが持つ。復元時は、復元した id から先へ進める |
| `src/game/creative/manual-spawn.ts:31-32,76` | 陣形の連番を、実体の集合にある最大値から導く |

**達成条件と検証**

- `rg -n "static .*counter|private static .*next" src/game` が 0 件。
- `npm run typecheck`、`npm run test:game`。
- `npm run dev` で次を見る。
  - creative で陣形を出して保存し、読み込んでからもう1つ出すと、両方の陣形のエネルギー役が別々に働く。
  - タイトルへ戻って別のランを始めても、id が1から振られる。

### 段 3 — 置き場と向きを整える

#### 手順 20. 表示の導出を `src/presentation/` へ出す

**目的**: 段 1〜2 で表示の導出になったものを、R2 の対応表どおり `src/presentation/` へ移す。汎用の部品は `src/hud/` へ移す。移動だけで、挙動は変えない。

**変更が必要な箇所**

| 移すもの | 移し先 |
| --- | --- |
| `src/game/hud/**` のうち game 用のパネル・窓・スタイル | `src/presentation/hud/` |
| `src/game/hud/**` のうち汎用の部品 | `src/hud/`。対象は `windows/{context-menu,object-picker}`、`sync-throttle`、`panel-shell`、`hud-root` の `hudRail`、`orbit/{chart-canvas,orbit-chart,orbit-chart-axes,tick-scale,calendar-ticks}`、`map-scale`、`frame/frame-panel` |
| `src/game/marker/**`(残り)、`view/**`、`pickable/**`、`map/**` | `src/presentation/` |
| `lines/**` の残り | `src/presentation/`。表示担当へ解体済みなら消す |
| 手順 13 で表示の導出にしたカメラの操作係、`display-window-manager` の UI 部分、`controlled-loop-sfx.ts`、`orbit-info.ts`、`protein/protein-motion-metrics.ts` | `src/presentation/` |
| `src/game/plan/{plan-editor,node-gizmo,plan-panel,plan-axis-drag,plan-display}.ts`、`plan-path.ts` の射影・ピック部分 | `src/presentation/plan/`。弧の計算とキャッシュは `game/plan/` に残す |
| 手順 16・17 で表示の導出にしたもの | `src/presentation/` |
| `src/hud/panels/{graphics-panel,bgm-settings-panel}.ts`、`src/hud/windows/{pause-menu,settings-view}.ts`(`render/graphics-settings` と `audio/bgm` を読む) | 読んでいる先が import を持たない語彙モジュールなら `src/hud/` に残す。`Bgm` の試聴のように装置の実体を操るものは `src/presentation/` へ移す。装置どうしの import(R2)を 0 にする |

import を直す外側:

| ファイル | 何をするか |
| --- | --- |
| `src/main.ts` | import を直す |
| `src/settings/user-settings.ts` | 表示トグルと軌道ガイドの設定の型は、解釈する表示の導出から import する |
| `tests/game/{map-scale,map-visibility,shortcut-hint,...}.test.ts` | 移った先を対象にするテストを `tests/presentation/` へ移す |
| `tests/run.ts`、`tsconfig.test.json`、`package.json` | `presentation` 層(`npm run test:presentation`)を足す |
| `CLAUDE.md` | コマンド表に `test:presentation` を足す |
| `tools/verify-ui-style.mjs`(`src/game/hud` を文字列パスで読む)、`tools/verify-theme-contrast.mjs`(存在しない `src/game/theme.ts` を読んでいる) | パスを直す |

**達成条件と検証**

- `src/game/{hud,marker,view,pickable,map,lines}` が存在しない。
- `rg -n "src/game/(hud|marker|view|pickable|map|lines)" tools tests src .claude/skills DEVELOP CLAUDE.md` が 0 件。
- `npm run typecheck`、`npm run test`、`npm run build`、`npm run verify:ui-style`、`npm run verify:theme`、`npm run check:boundaries`(対応表から該当行を消す)。
- `npm run smoke:browser`。手順の前から落ちるなら、落ち方が変わらないことを比べる。

#### 手順 21. 天体を `src/celestial/` へ出す

**目的**: 時刻層に残った `game/celestial/` を `src/celestial/` へ移す。移動だけで、挙動は変えない。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/celestial/**`(時刻層に残ったもの) | `src/celestial/` へ `git mv` |
| import している側 | 123 ファイルを直す。うち tests が 64 か所、`launcher/save-browser/save-browser.ts:4` |
| 文字列パスで読む tools | `rg -n "game/celestial" tools tsconfig*.json` で出る箇所を直す: `tools/export-lagrange-orbits.mjs:50-52`、`tools/export-moon-features.mjs:18`、`tools/compile-source.mjs:45`、`tsconfig.test.json:32`、`tools/render-lab/*`、`tools/cloud-lab/*` |
| `tests/game/earth-system.test.ts` など、対象が `src/celestial/` にあるテスト | `tests/celestial/` へ移し、`test:celestial` を足す(`tests/run.ts`、`package.json`、`CLAUDE.md`)。天体のデータを材料に使う `tests/physics/` のテストは、パスだけ直す |

一括の書き換えは、UTF-8 で書き出す node スクリプトか Edit で行う。PowerShell の `Set-Content` とシェルの sed は、日本語を壊し、置換を黙って空振りする。

**達成条件と検証**

- `rg -n "game/celestial" src tests tools DEVELOP CLAUDE.md .claude/skills` が 0 件(`tests/dist` と `memos/` は除く)。
- `npm run typecheck`、`npm run test`、`npm run build`、`npm run check:boundaries`。
- `npm run render-lab:shot` と `npm run cloud-lab:shot` が起動して撮れる。

#### 手順 22. 型の置き場を所有者へ揃える

**目的**: R9 のとおり、モデル層が `render/` で定義された型を使っている残りを、値の正本の所有者へ移す。挙動は変えない。

**変更が必要な箇所**

| 型 | いまの場所 | 移し先 |
| --- | --- | --- |
| `ViewMode` | `render/view-mode.ts` | 視点が正本なので、`game/viewer/` の語彙モジュール(import なし)。render は `CameraFrame` に要る投影の語彙まで狭めるか、語彙モジュールを読む |
| `ProteinDisplaySettings` / `ProteinPhase` | `render/protein/protein-display.ts` | 表示設定は視点、フェーズは進行が正本。どちらも import を持たない語彙として所有者の側に置く。使っている側: `save/save-data.ts:9`、`protein/{protein-combat-state,protein-schema}.ts`、`vfx/flash-effects.ts` |
| `ProteinBackboneAsset` | render | 当たり判定が使う側(`protein/protein-sphere-collision.ts`)へ |
| `FlashEffect` / `FlashKind` | render | 閃光は表示の導出になったので、表示の導出と render の間で解決する |
| `display-window-duration.ts` | `game/` | 視点の語彙。進行は需要として受けるので、`dynamic-motion.ts:19` の import は消える |
| `perf-counts.ts` が引いている render の型 | — | 計測は組み立て(`main.ts`)の関心として整理する |

**達成条件と検証**

- `rg -n "from '.*render/" src/game` が 0 件。
- `npm run typecheck`、`npm run test`、`npm run check:boundaries`。

#### 手順 23. `Game` を分解し、位相を `main.ts` で組む

**目的**: `game.ts` をなくす。代わりに、モデル層の根(ランの正本を所有し、命令・操作量・需要・dt を受けて進める)と、表示の導出の根(入力の解釈と導出と同期)を置く。R8 の4位相を `main.ts` が順に呼ぶ。launcher は、決着をフレームの後で読むようにする(update の中から結果画面の DOM を触らない)。許可リストを空にする。挙動は、結果画面が出るのが最大1フレーム遅れる点だけが変わる。

**着手前に確認すること**: K5 の、このリポジトリに無い Coordinator の作業の有無を確かめる。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| `src/game/game.ts` | モデル層の根と表示の導出の根へ分けて消す。生成・破棄・直列化は、それぞれの根が持つ |
| `src/game/game-host.ts` | 寄せ集めをやめる。それぞれの根が要るものを、個別の引数で受ける |
| `src/main.ts:57-217` | 位相の順序(入力の解釈 → 進行 → セーブ → 導出と同期 → 描画)を組む。`Hud` の外枠はページの寿命で持ち、ランごとの表示の導出はランの寿命で持つ |
| `src/launcher/launcher.ts:67,133-169,206`、`src/launcher/save/*`、`src/game/run-summary.ts` | 2つの根を起こし畳む。`game.input`・`activeStage.onDecided`・`phase`・`celestialSystem.nameOf` を、狭い面で受ける |
| `src/game/frame-sections.ts`、`src/game/loading-progress.ts`、`src/game/perf-counts.ts`、`src/game/hud/windows/debug-info-window.ts` | 計測は組み立てへ、読み込みの進捗は launcher へ移す |
| `tools/boundary-allowlist.json` | 空にする |

**達成条件と検証**

- `src/game/game.ts` が存在しない。
- `npm run check:boundaries` が空の許可リストで 0 を返す。
- 次が 0 件(`input/key-mapping.ts` など import を持たない語彙は除く)。
  ```
  rg -n "from '.*(render|hud|audio|input|presentation|settings|launcher)/|from 'three" src/game src/celestial
  ```
- `npm run typecheck`、`npm run test`、`npm run build`、`npm run smoke:browser`。
- `node tools/dep-metrics.mjs --file` でモデル層の根を測り、ctx2 の行数が 38453 行(`src/game/game.ts` の調査時点の値)より小さい。
- `npm run dev` で次を見る。
  - ラン → タイトル → 別ステージの順に進んでも、HUD が重複しない。
  - 決着から結果画面が出る。
  - 手順 1 の前のセーブが読める。

## 見積り

作業量は次の式で出す。**係数は手順 3 と 4 の実測で置き換える。**

```
意味の変更ファイル数 × 20 分 + 機械的な import 置換ファイル数 × 1 分 + 検証 20 分
```

ファイル数は、上の各手順の表と、調査時点の import グラフ(629 ファイル・3447 辺)から数えた。

| 手順 | 意味の変更 | 機械的な置換 | 導出 | 分 |
| --- | --- | --- | --- | --- |
| 1 | 規則 11 節 | — | 11 × 15 + 20 | 185 |
| 2 | 検査 1(約 200 行) | — | 120 + 20 | 140 |
| 3 | 14 | — | 14 × 20 + 20 | 300 |
| 4 | 45 | — | 45 × 20 + 20 | 920 |
| 5 | SPEC 1 | — | 30 | 30 |
| 6 | 12 | — | 12 × 20 + 20 | 260 |
| 7 | 18 | — | 18 × 20 + 20 | 380 |
| 8 | 25 | — | 25 × 20 + 20 | 520 |
| 9 | 20 | — | 20 × 20 + 20 | 420 |
| 10 | 40 | — | 40 × 20 + 20 | 820 |
| 11 | 12 + 検査 1 | — | 12 × 20 + 60 + 20 | 320 |
| 12 | 20 | — | 20 × 20 + 20 | 420 |
| 13 | 25 | — | 25 × 20 + 20 | 520 |
| 14 | 35 | — | 35 × 20 + 20 | 720 |
| 15 | 30 | — | 30 × 20 + 20 | 620 |
| 16 | 22 | — | 22 × 20 + 20 | 460 |
| 17 | 35 | — | 35 × 20 + 20 | 720 |
| 18 | 8 | — | 8 × 20 + 20 | 180 |
| 19 | 6 | — | 6 × 20 + 20 | 140 |
| 20 | 12(tests・tools・設定) | 230(移動 150 + 外側 80) | 12 × 20 + 230 + 20 | 490 |
| 21 | 10(tools の文字列パス・テスト層) | 143(移動 20 + 外側 123) | 10 × 20 + 143 + 20 | 363 |
| 22 | 15 | — | 15 × 20 + 20 | 320 |
| 23 | 12 | — | 12 × 20 + 60 + 20 | 320 |
| 合計 | | | | 9,970 分 ≒ 166 時間 |

- commit は 23 本。一度に進めてよいのは、手順 3・4・6 と、手順 7・8 だけ(同じファイルを触る組は並行しない)。
- 手順 14〜17 は `src/game/dynamic/` と `stages/` を重ねて触るので、直列にする。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 規則をコードより先に書く | 規則と食い違うコードを、読み手が規則どおりだと思い込む | 手順 1。許可リストが差を明示する(手順 2) |
| 境界検査が `export … from`・動的 import・`import type` を取りこぼす | 規則を守ったことにして違反が増える | 手順 2 の自己検証(3種類の違反を仮に足して落ちること) |
| 「import を持たない語彙は定義層」を抜け道に使い、意味のある型を空の import のファイルへ逃がす | 装置がモデルの意味を知る | 手順 22 のレビュー(語彙モジュールを1本ずつ見る) |
| 命令を列に積むことで、UI の操作と表示が1フレームずれる | 押したボタンの点灯が遅れる。同じフレームに届いた命令の順序が変わる | 手順 9(受け付けた順に適用すること、一時停止中にも適用すること) |
| 出来事の記録を、進行を進めないフレームに空にしない | 一時停止中に同じ効果音が毎フレーム鳴る | 手順 10 |
| 出来事の通し番号をランを跨いで持つ・戻す | ラン開始直後に音が鳴らない、または前のランの音が鳴る | 手順 10、23 |
| 需要を作る位相が予測器より後になる | 予測が1フレーム遅れて伸びる。いまも `updatePredictionReaders` は予測器より後にある | 手順 11(需要は入力の解釈の位相で作る) |
| 予測弧をなぞった結果が積分と一致しない | 表示の選択で物理が変わる(R4 違反)。これは物理的な正確さの問題 | 手順 11 の検査。一致しなければユーザーに問う |
| 計画ノードの消化をビューから外したとき、同じノードを進行と表示の両方で消化する | ノードが二重に消える、または通知が二重に出る | 手順 11 |
| 表示担当の突き合わせを、同一性ではなく id でする | 読み込み直後に古い表示担当が残る、または作り直しが漏れる | 手順 14 |
| 自機の遅延除去(`reclaimedByOwner`)と表示担当の寿命がずれる | 撃墜直後の自機が消えない、または早く消える | 手順 14 |
| View を sync で作ったとき、`InstancedPools` の begin/end と順序がずれる | 出たフレームの弾が描かれない、ちらつく | 手順 14 |
| 見た目の表の登録漏れを既定の見た目で黙って埋める | 天体の見た目が静かに変わる | 手順 17(表に無い id は構築時に例外にする) |
| lab を本番と別の組み立てで直す | lab の撮影が本番を検証しなくなる | 手順 17、21(lab は本番の工場を呼ぶこと) |
| 文字列パスで src を読む tools を直し忘れる | tools が黙って壊れる、または何も検査しなくなる。`verify-theme-contrast.mjs` はすでに存在しないパスを読んでいる | 手順 20、21 |
| 一括置換を PowerShell か sed で行う | 日本語が化け、置換が黙って空振りする | 手順 20、21 |
| 並行するエージェントのテストが `tests/dist` を消し合う | ENOTEMPTY や Cannot find module で落ち合う | 並行させる手順(3・4・6、7・8)。outDir を分ける |
| 保存形式を組み立ての変更で変えてしまう | 既存のセーブが読めない、または戻る位置がずれる | 手順 13、18、23(手順 1 の前に書き出したセーブで確かめる) |
| 別の作業者の未取り込みの作業と重複・競合する | 同じ境界を二度直す。取り込み時に大きく衝突する | 手順 8、12、14、15、23(着手前に作者へ確認する) |
| 雲の作業と `render/cloud/` で衝突する | 取り込み時の衝突、見た目の回帰 | 手順 3(`atmospheric-wind.ts` の1か所に限る) |
| `Hud`(ページの寿命)とランごとの表示の導出の破棄順がずれる | ランを跨いで DOM やリスナーが残る | 手順 23 |
| launcher が決着をフレームの後で読むように変えたとき、決着したフレームの sync が走る | 結果画面の直前に1フレーム余分に描かれる | 手順 23 |
| 規則の上ではモデル層なのにセーブされない値が残る(ワープ段・表示期間・軌道要素の基準・基地の計画・デバッグステージ) | 読み込みで元に戻らず、「セーブ = モデル層」が崩れて見える | 各所有者のコメントに理由を書く(R11)。セーブへ加えるかは SAVE.md の判断として残す |
