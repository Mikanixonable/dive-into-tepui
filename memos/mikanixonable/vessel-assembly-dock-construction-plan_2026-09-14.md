# 船体統合・軸方向モジュール建造 MVP 要件定義／実装計画

作成日: 2026-09-14
計画の基準コミット: 4922f7403
状態: レビュー待ち。この文書の承認前には実装しない。

## 目的

自機、基地、接続中／分離後のブースターを、役割ごとの別クラスではなく、同じモジュール船体から
生まれる実体へ統合する。最初の垂直スライスでは CREATIVE 上で次の一連の操作を成立させる。

1. 操縦可能なドックヤード船を配置する。
2. 戦闘ビューのドックを選び、円筒モジュールのゴーストを軸方向へスナップして船を組み立てる。
3. 完成した船をドックから切り離し、通常の自機として操縦する。
4. デカプラーを作動させ、外側のブースター部分を独立した船体として分離する。
5. 完成船を空いているドックへ再ドッキングし、修理または末尾モジュールの更新を行う。
6. 建造途中、ドッキング中、分離後、燃料切れで漂流中の各状態をスナップショットへ保存・復元する。

これは「出撃して資源を回収し、帰還して修理・再建造する」ゲームループの基盤であり、資源経済や
救難補給までを今回完成させる計画ではない。

## 調査結果と実現可能性

実現可能であり、現在のエンジンを捨てる必要はない。ただし、固定モデルの差し替えだけでは成立せず、
ゲーム状態、物理、描画、入力、保存を同じ船体定義へ揃える横断変更になる。

再利用できるもの:

- src/game/dynamic/dynamic-entity/parts.ts と part-inventory.ts に、HP、燃料、性能値を持つ部品と
  健全部品からのランダム被害が既にある。
- src/physics/cylinder-contact.ts に円柱対球の平坦端面判定と、円柱同士をカプセルとして扱う
  接触・掃引の基礎がある。真の平坦端面円柱同士と ray 判定は追加が必要である。
- src/game/camera/camera-system.ts に現在の viewpoint と projection があり、戦闘ビュー用の
  スクリーンレイを同一フレームで組み立てる材料がある。
- DynamicEntity、DynamicMotion、EntityRegistry、保存時の entity dictionary に、独立物体の
  生成、削除、復元の経路がある。
- 現在の接続ブースターは、燃料消費、燃焼継続、質量比での分離速度配分、自己衝突猶予を既に持つ。
- 描画パイプラインには通常メッシュ、アウトライン、3D オーバーレイの経路があり、ゴーストと
  スナップガイドを追加できる。

置換が必要なもの:

- Player、Base、AttachedBoosters、DetachedBooster は、物理、表示、保存タグ、生成経路が別々である。
- 自機、基地、ブースターは固定の一体モデルで、武装、ノズル、パネルのアンカーもそのモデル名に
  結び付いている。
- Base は無限接触質量、専用 BVH、HP なしという特例であり、部品構成から生まれる船にはなっていない。
- CREATIVE の物体配置は完成済み物体の生成だけで、ドック、建造中船体、ゴースト配置を持たない。
- 保存形式は player、base、booster を別の kind としている。

したがって、技術的な阻害要因はないが、小規模修正ではない。MVP をさらに削るなら「再ドッキング」を
外す案もあるが、既存船の更新と修理を試せなくなるため、この計画では残す。

## 要件の決定

### 採用する MVP

#### 共通船体と役割

- Player、Base、DetachedBooster の具象実体を ModularShip へ統合する。Base クラスと
  DetachedBooster クラスは削除し、同じ役割の代替クラスは作らない。
- 現在の抽象 Ship は敵の部位ダメージとの共有境界として残し、ModularShip をその具象実装にする。
  MetalEnemy と ProteinEnemy のモデル・AI・調整値は今回モジュール化しない。
- 「自機」「基地」「ブースター」は保存タグやクラスではなく、所有陣営と健全なモジュール構成から
  毎回導出する表示上の役割とする。
  - 健全な command がある: 操作命令を受けられる船。
  - 健全な command と dock がある: 建造・修理可能なドックヤード船。表示上は「基地」。
  - command がなく、推進モジュールがある: 非操縦のブースター。
  - いずれにも当てはまらない生存部分: 漂流船体。
- 操作対象であることはクラスではなく、player 所有、健全な command、DynamicSystem の選択状態で決める。
- 敵 AI の追跡対象は Player 型ではなく、位置・速度と player 所有を示す最小契約で受ける。

#### モジュールと軸方向スナップ

- ShipAssembly は最大 32 個の ShipModuleInstance を、船尾側から機首側への順序付き配列として持つ。
  接続グラフは今回作らない。
- 全モジュールの基準軸はローカル +Z で、隣接端面どうしを隙間 0 で接続する。配置時の横ずれ、
  角度、軸回りロールは 0 に固定する。
- 構造胴体の基準半径は、現在の自機の接触半径を引き継いだ 2.6 m とする。長さ、乾燥質量、HP、
  性能、描画アセットはモジュール定義ごとに持つ。
- ラジエーター、太陽電池、武装、ノズル、ドッキングカラーは円筒胴体に属する設備として突出してよい。
  見える固体部分は対応する接触プリミティブを持たせる。
- MVP カタログは hull、command、thruster、rcs_tank、armor、radiator、solar_panel、weapon、
  docking_port、dock_ring、booster、decoupler とする。現在の部品性能値を移し、既定戦闘船の総 HP と
  既定出力段の加速度は現行値へ合わせる。
- 配置は選択ドック側から自由端へ 1 個ずつ追加する。既存船の編集も自由端からの撤去と再追加だけを
  許可する。中間挿入、並べ替え、分岐、径違いアダプターは実装しない。
- dock_ring はホスト軸から 8.0 m 離れたローカル +X／-X に、外向きの接続軸を持つ 2 個の dock を
  備える。子船は選んだ接続軸を自身の +Z として直列に組み上がる。
- 1 船体あたり dock_ring は最大 2 個、dock は最大 4 個とする。各 dock は建造中または完成済みの
  船を 1 隻だけ保持できる。既定ドックヤード船は dock_ring 1 個、すなわち 2 dock を持つ。

#### 完成条件

ドックから独立させられる完成船は、次をすべて満たす。

- モジュール数が 32 以下で、定義と状態がすべて妥当である。
- 健全な hull が 1 個以上ある。
- 健全な command がちょうど 1 個ある。
- 健全な thruster と燃料容量を持つ rcs_tank が 1 個以上ある。
- 再接舷に使える docking_port が船体のどちらかの終端に 1 個以上ある。
- すべての dock が空である。MVP では、別の船を抱えた船の入れ子ドッキングを許可しない。

dock_ring を含めて完成させれば、発進後は自動的にドックヤード船の役割を得る。ブースター部分は
完成条件を単独では満たさなくてよく、デカプラー分離後に非操縦船体として生存できる。

#### デカプラーと分離

- decoupler は隣接モジュール間に置く消費型の接合部品とする。
- 作動時は decoupler 自身を両側の船体から取り除き、その位置で配列を 2 個の ShipAssembly へ
  所有権ごと分割する。Part オブジェクトを親子で共有しない。
- [5] は操作中 command から船尾方向へ最も遠い健全な decoupler を作動させる。
- [6] はその decoupler より外側にある最後尾ブースター群の点火状態を切り替える。分離後も点火状態と
  残燃料を引き継ぐ。
- 現在の分離速度、質量比による運動量保存、衝突再開時刻、燃料切れまでの燃焼を維持する。
- 分離時は両側の重心を再計算し、各モジュールのワールド位置、並進運動量、角速度由来の速度を
  連続に保つ。軸上の分離なので新たな分離トルクは与えない。
- boosterCover と boosterBolt の破片表現は、専用 Booster Entity と一緒に削除せず、
  デカプラー作動時の破片として残す。

#### 物理

- 自由飛行中の ShipAssembly は、モジュールごとの剛体やジョイントではなく、船全体で 1 個の
  DynamicMotion を持つ。
- 質量は健全性に関係なく全接続モジュールの乾燥質量と残資源質量の合計とする。推力、トルク、
  容量、発電、放熱、武装性能は現行どおり健全部品から集計する。
- 円筒胴体と突出設備の接触プリミティブを 1 個の compound shape にまとめる。広域判定は
  全プリミティブを包む球、狭域判定・弾・画面ピックはプリミティブ集合を使う。
- モジュールごとの質量と位置から重心と 3 軸の慣性を計算する。既存物理が持つ対角慣性の範囲に
  合わせ、積慣性は今回導入しない。
- 燃料消費、建造、分離、ドッキングで質量特性が変わったときだけ再計算し、基準点を補正して
  描画位置と運動量を不連続にしない。
- ドッキング中の子船は独立 DynamicEntity から外し、ホスト船の dock state が所有する。表示形状、
  接触形状、質量はホストの compound shape と質量特性へ含めるが、子船の command や dock 能力を
  ホストへ合算しない。

#### ドッキング

- 通常 docking_port と、建造・修理機能を追加した dock は同じ接続規格を使う。
- ドッキング可能かどうかの判定と、ドッキング確定後の船体状態は別に扱う。判定は接近時の
  許容誤差に基づき、確定後は接続点のずれを残さない一体剛体状態へ正規化する。
- ドッキングは、操作中の船にある終端 docking_port と、別の船の空 dock を次の条件で手動確定する。
  - 確定前の接続点間距離が 1.0 m 以下。
  - 確定前の接続軸が正対する角度誤差が 10° 以下。
  - 確定前の接続点の相対速度が 1.0 m/s 以下。
  - 接続される船が他船を格納していない。
- 条件を満たす dock の操作ボタンだけを有効にする。自動吸着は行わず、意図しない接舷を防ぐ。
- 確定時は、対象船の姿勢と位置をスナップして、docking_port と dock の接続点を同一座標に置く。
  接続軸は規定の正対方向へ完全一致させ、許容誤差による位置・角度のずれをドッキング後へ持ち越さない。
- 確定時に対象船を registry から dock state へ移し、対象船をホスト船の一体剛体へ統合する。
  ドッキング後は対象船との相対位置・相対姿勢・相対速度を持たず、ホスト船の接続点に拘束された状態になる。
  質量特性の再計算後も、接続点の一致と一体剛体としての運動を維持する。
  接舷した船が操作対象だった場合は、健全な command を持つホストへ操作対象を切り替える。
- 完成済み船を切り離すと registry へ同じ entity id で戻し、その船へ操作対象を切り替える。
- ドッキング中の船は個別ターゲットから外れ、ホスト船のプロパティウィンドウ内で扱う。
- ホスト船が失われた場合、建造中・格納中の船も一緒に失われる。

#### 建造 UI とゴースト

- 建造は CREATIVE の戦闘ビューで、操作中のドックヤード船にある健全な dock からだけ開始できる。
- dock ごとの状態と操作は、船の右クリックプロパティウィンドウに一覧表示する。空 dock には
  「建造開始」、格納中には「建造／更新」「修理」「切り離し」を出す。
- 建造モード中も戦闘ビューを維持し、選んだ dock へカメラを寄せる。シミュレーションは停止し、
  ワープ、飛行操作、射撃、ターゲット変更を受け付けないが、カメラの回転・ズームは使える。
- 建造開始時に表示時刻を simTime へ戻し、建造中は過去／未来表示へ移れないよう固定する。
  ghost の transform と確定先は常に現在の物理状態から求める。
- 右側の建造パネルにモジュールカタログ、現在の質量・HP・能力、完成条件、末尾撤去、建造終了、
  船体破棄を置く。ドラッグ＆ドロップや 2D 船体図は作らない。
- モジュール選択中は自由端へ半透明ゴーストと円形スナップガイドを出す。有効なら緑、不適合または
  上限超過なら赤、候補なしなら非表示にする。ゴーストのクリック／タップで確定する。
- 配置、撤去、修理は即時に dock state へ反映し、建造途中も保存対象にする。「建造終了」は編集を
  閉じるだけで未完成船を捨てない。「船体破棄」だけが確認後に dock を空にする。
- ESC は共通 overlay 管理を通して建造モードを閉じる。独自のグローバルイベントリスナーを追加しない。

#### 修理、損傷、喪失、漂流

- 弾と高速接触のダメージは、現在と同じく健全な HP 部品から 1 個を一様ランダムに選ぶ。
  ラジエーターへ直接当たった場合の例外も維持する。物理的な命中位置と損傷部品の対応は導入しない。
- hull または、存在する command が全損したときの喪失判定は維持する。command を元から持たない
  ブースター断片は、command 不在だけでは失われない。
- CREATIVE の毎秒 1 HP の自然回復は廃止する。健全な dock に格納した船だけを、今回に限り
  資源消費なし・待ち時間なしで最大 HP まで修理できる。
- 戦闘、熱、動圧、天体接触などで失われた船は registry から除去し、格納・資材への自動回収はしない。
- RCS／ブースター燃料が 0 になっても alive を変えず、距離や交戦圏離脱だけで player 所有船を
  prune しない。軌道上に漂流し、通常のスナップショットへ保存され続ける。
- CREATIVE の「船の喪失は結果画面を出さない」と通常ステージの既存勝敗条件は維持する。
  セーブデータや歴史線そのものを船の喪失で削除しない。
- 漂流船への補給、救難、曳航、遠征をまたぐ軌道世界の永続化は将来要件とする。

#### 保存

- player、base、booster を新しい ship kind と ShipAssemblySaveData へ統合する。敵と補給などの
  kind は変更しない。
- モジュール順、instance id、definition id、HP、燃料、点火、展開、温度など各モジュール所有状態、
  owner、dock ごとの建造状態と格納船、操作対象、ターゲット、分離直後の衝突猶予を保存する。
- role は保存せず、復元後も owner と健全な module capability から導出する。保存 role と実構成が
  食い違う二重の正本を作らない。
- SAVE_VERSION を 3 から 4 へ上げる。旧固定船体から新しいモジュール列への恣意的な変換を避けるため、
  v3 スナップショットの移行処理と旧 kind の互換 alias は作らない。対応外として既存の検証経路から
  除外する。
- 現在 Base だけが持つ未使用の money と、スナップショットカードの所持金表示は削除する。
  資源・通貨は後続の経済仕様で所有者と単位を決めて導入する。
- 格納船の再帰は 1 段までとし、格納船がさらに船を抱える状態を validator で拒否する。

### 今回変更しない挙動

- 自機の 6 方向並進、3 軸回転、RCS 制動、進行方向ホールド、4 段階出力。
- 武装、弾薬ベルト、射撃熱、船体熱、ラジエーター、太陽電池、電力の現在の数値と操作。
- 弾、高速接触、熱、動圧、天体接触によるダメージ量と喪失理由。
- 軌道積分、接触の時間順序、予測軌道を無効化する条件。
- MetalEnemy、ProteinEnemy の AI、モデル、HP／部位ダメージ、生成、保存。
- CREATIVE の操作対象切替、マップ配置、最大 50 隻の既存上限。上限判定は ModularShip の
  操縦可能船へ読み替える。
- 右クリックはプロパティウィンドウを開き、ESC と入力遮断は共通 overlay 管理が決めるという UI 規約。

### 採用しない案

| 案 | 採用しない理由 |
| --- | --- |
| BaseShip、BoosterShip など役割別サブクラスを作る | クラスで役割が固定され、部品構成で役割が変わる要件を満たさない。 |
| 最初から接続グラフ、径違い、横向き、分岐、回転を実装する | MVP の配置・物理・保存・UI を同時に複雑化する。直列配列を将来の保存バージョンで移行する。 |
| モジュールごとに独立剛体とジョイントを持つ | 接触・ワープ・予測・保存の負荷が大きく、今回必要な剛体船としての挙動に不要。 |
| 現行のカプセル近似をモジュール円柱にもそのまま使う | 平坦な dock 端面より手前で衝突し、ghost の接続面と物理面が一致しない。 |
| 物理的な命中位置へ損傷を割り当てる | ユーザー指定のランダム部位ダメージ維持に反し、被害設計を別案件へ広げる。 |
| 基地専用の第三ビューまたは 2D シルエット編集画面を作る | 戦闘ビューの 3D ゴーストで組む要件と重複する。 |
| フレーム／固定ハードポイントへ部品を差す | 軸上で順次スナップする今回の自由配置より制約が強く、別の船体仕様になる。 |
| ショップ、部品在庫、資材消費、建造時間を同時実装する | 資源の入手・所有・加工・喪失が未決定で、船体基盤の検証を妨げる。 |
| v3 セーブを自動的に新船体へ変換する | 旧 Base、箱型 Player、多段ブースターのどの形を正解とするか決められず、見えない仕様を作る。 |
| 互換用 Player／Base／DetachedBooster facade を残す | 二重の生成・保存経路が残り、以後の変更で再び分岐する。 |

## 達成目標

- コード上の Base、DetachedBooster、AttachedBoosters のクラスと player／base／booster の保存 kind が
  なく、同一の ModularShip と ShipAssembly で生成・復元される。
- モジュール配列だけから、モデル配置、質量、慣性、広域半径、狭域接触、HP、推力、燃料、役割が
  決まる。固定 Player/Base モデルや Base BVH が正本として残らない。
- CREATIVE で 2 dock を持つ既定ドックヤード船を置き、戦闘ビューから 1 隻を組み立てて発進できる。
- 発進船のデカプラーを作動すると 2 個の独立 ModularShip になり、燃焼中の外側部分が燃料切れまで
  飛行する。
- 発進船を条件内で再ドッキングし、無料即時修理と自由端モジュールの交換後に再発進できる。
- 建造途中、ドッキング中、分離後、燃料切れ漂流中を保存・復元しても、ID、HP、燃料、役割、
  操作対象、見た目、接触形状が一致する。
- 現行のランダム部位ダメージと敵挙動に回帰がない。

## 実装手順

### 1. 仕様を先に確定する

#### 目的

固定箱型 Player、専用 Base、固定多段ブースターを正本から外し、この計画の MVP 境界を仕様へ
反映してからコードへ進む。

#### 変更箇所

| ファイル | 変更内容 |
| --- | --- |
| DEVELOP/SPEC/FLIGHT.md | 共通船体、直列モジュール、完成条件、デカプラー、集計、ランダム損傷、円筒形状、自然回復廃止を記述する。 |
| DEVELOP/SPEC/GAME.md | 基地節をドックヤード船とドックへ置換し、CREATIVE の建造、再接舷、修理、喪失、漂流を記述する。 |
| DEVELOP/SPEC/SAVE.md | ship 保存、建造途中／格納状態、v4 非互換、money 廃止を記述する。 |
| DEVELOP/SPEC/CONTROLS.md | [5]／[6] のデカプラー基準と建造モードのポインタ・ESC・カメラ操作を記述する。 |
| DEVELOP/SPEC/UI-DESIGN.md | dock 行、建造パネル、状態色、確認、タッチ、overlay 規則を記述する。 |
| DEVELOP/SPEC/RENDERING.md | モジュール組立描画、ghost、snap guide、solid geometry と collider の一致を記述する。 |
| DEVELOP/SPEC/COMBAT.md | Base の別種別を消し、ModularShip の接触重みとランダム部位ダメージ維持を記述する。 |
| DEVELOP/SPEC/ORBIT.md | compound cylinder、ドッキング中の一体剛体、分離時の連続性を記述する。 |

#### 達成条件と検証

- 「最大 4 段の専用ブースター」「固定箱型自艦」「専用 Base 実体」「CREATIVE 自然回復」が決定仕様に
  残っていない。
- 上記の数値条件、MVP 制限、対象外がこの計画と同じ意味で書かれている。
- SPEC 差分の意味がこの計画から変わる場合はコードへ進まず、差分を合意し直す。

### 2. 現行挙動を characterization test で固定する

#### 目的

共通化で失いやすいダメージ、推進、分離、入力を、構造変更前のテストとして固定する。

#### 変更箇所

| ファイル | 変更内容 |
| --- | --- |
| tests/game/player-systems.test.ts | 既定船の総 HP、推力、燃料、発電、放熱、武装集計と critical part 喪失を追加する。 |
| tests/game/booster-stack.test.ts | 点火中分離、残燃料、質量比、衝突猶予、イベント境界を追加する。 |
| tests/game/ship-random-damage.test.ts（新規） | seed 固定で健全部品一様抽選とラジエーター例外を固定する。 |

#### 達成条件と検証

- 現行実装に対して追加テストが成功し、意図する変更以外の数値回帰を検出できる。
- npm run typecheck と npm run test:game を通す。

### 3. ShipAssembly とモジュールカタログを作る

#### 目的

描画、物理、保存、役割判定が読む唯一の船体状態を作り、PartInventory の浅いコピーを分離経路から
排除する。

#### 変更箇所

| ファイル | 変更内容 |
| --- | --- |
| src/game/ship/ship-module-definition.ts（新規） | 寸法、質量、HP、性能、model id、solid primitives、能力を immutable に定義する。 |
| src/game/ship/ship-module-instance.ts（新規） | instance id、HP、燃料、点火、展開など可変状態の判別 union を定義する。 |
| src/game/ship/ship-module-catalog.ts（新規） | MVP 12 種と既定値を登録し、未登録 id を拒否する。 |
| src/game/ship/ship-assembly.ts（新規） | 順序、軸上 transform、集計、役割、完成検証、追加、末尾撤去、所有権移動による split を持つ。 |
| src/game/ship/ship-presets.ts（新規） | 既定戦闘船と 2 dock ドックヤード船の assembly を作る。 |
| src/game/dynamic/dynamic-entity/ship.ts | PartInventory 固定所有を、敵用 PartInventory と ModularShip 用 ShipAssembly が満たす狭い部品集合契約へ変える。 |
| src/game/dynamic/dynamic-entity/parts.ts | 既存性能値を module definition から参照できる部品契約へ整理する。 |
| src/game/dynamic/dynamic-entity/part-inventory.ts | 敵用実装として残し、分離用の浅い replace を使わないことを明示する。 |
| tests/game/ship-assembly.test.ts（新規） | スナップ座標、集計、役割、完成条件、上限、split、instance 非共有を検証する。 |

#### 達成条件と検証

- 配列の並びだけから全 module transform が決まり、隣接円筒の端面に隙間・重なりがない。
- 同じ module instance が split 後の両 assembly に存在しない。
- 既定戦闘船の総 HP と各出力段の加速度が現行値に一致する。
- command、dock、booster の有無と健全性だけで役割が変化する。
- npm run typecheck と npm run test:game を通す。

### 4. compound cylinder と質量特性を追加する

#### 目的

一体剛体を保ったまま、見えているモジュール列を接触、弾、地表、ピックの共通形状にする。

#### 変更箇所

| ファイル | 変更内容 |
| --- | --- |
| src/physics/capped-cylinder-contact.ts（新規） | 平坦な両端面を持つ有限円柱同士、円柱対球、ray の正確な接触を返す。 |
| src/physics/compound-cylinder-contact.ts（新規） | 複数の local capped cylinder に対する接触、掃引、ray の最近傍結果と module id を返す。 |
| src/physics/ship-mass-properties.ts（新規） | 円筒列と残資源から質量、重心、対角慣性、bounding radius を求める。 |
| src/physics/cylinder-contact.ts | 薬莢など既存利用者のカプセル近似を維持し、共有できる結果型だけを capped-cylinder-contact.ts と揃える。 |
| src/game/dynamic/dynamic-motion.ts | assembly 変更時に質量、慣性、半径、接触形状を原子的に更新できる契約を追加する。 |
| src/game/dynamic/entity-contact-physics.ts | ModularShip 同士と他物体の compound narrow phase を使う。 |
| src/game/dynamic/surface-contact-physics.ts | 地表との最初の接触を compound shape から求める。 |
| src/game/dynamic/predictor.ts | bounding radius／shape 更新時に予測を無効化する。 |
| tests/physics/capped-cylinder-contact.test.ts（新規） | 側面、平坦端面、縁、ray と、カプセルなら当たるが円柱なら当たらない位置を検証する。 |
| tests/physics/compound-cylinder-contact.test.ts（新規） | 円筒列の接触、掃引、ray、module id、最近傍、隙間なし、偽陽性なしを検証する。 |
| tests/physics/ship-mass-properties.test.ts（新規） | 追加、燃料消費、分割、格納で質量・重心・慣性が有限かつ保存的になることを検証する。 |

#### 達成条件と検証

- 高速弾と高速物体がモジュール間をすり抜けない。
- 長い船体が高速回転する区間でも、始点・終点だけでなく補間姿勢を含む決定的な adaptive sweep で
  最初の接触を得る。現行の最大 16 標本・終端軸固定を新船体へ流用しない。
- 広域球が全 solid primitive を含み、狭域判定が空間だけを理由に接触を返さない。
- mass、center、inertia、radius が NaN／Infinity にならない。
- npm run typecheck、npm run test:physics、npm run test:game を通す。

### 5. モジュールモデルと ModularShipView を作る

#### 目的

固定 Player/Base/booster モデルではなく、assembly と同じ transform で部品モデルを組み立て、
武装・パネル・ノズルの semantic anchor も module 側へ移す。

このステップの開始前に /rendering-workflow を起動し、モデル、G-buffer、outline、ghost の確認方法を
固定する。

#### 変更箇所

| ファイル | 変更内容 |
| --- | --- |
| tools/model-builder/ship-modules.mjs（新規） | 12 種の円筒 module と semantic anchor を生成する。 |
| tools/model-builder/export-models.mjs | ship module asset を出力対象に加える。 |
| src/assets/models/shipModules.json（生成） | module ごとの 3D model を保持する。 |
| src/render/dynamic/ship/modular-ship-view.ts（新規） | assembly の module view を生成・同期・破棄する。 |
| src/render/dynamic/ship/ship-module-view.ts（新規） | model id、local transform、損傷／展開状態、anchor を扱う。 |
| src/render/dynamic/ship/ship-ghost-view.ts（新規） | 半透明 ghost と valid／invalid 色を描く。 |
| src/render/dynamic/ship/dock-snap-guide-view.ts（新規） | world-space の円形 snap guide を描く。 |
| src/render/dynamic/dynamic-view.ts、baked-model.ts | 可変 module 集合の render source と、module 単位の model group を扱えるようにする。 |
| src/render/dynamic/player/player-view.ts | ModularShipView へ接続を移した後に削除する。 |
| src/render/dynamic/player/folding-panels-view.ts | 固定モデル内の名前探索をやめ、radiator／solar module anchor を受ける。 |
| src/render/dynamic/player/rcs-effects.ts | module nozzle anchor から噴射位置を得る。 |
| src/render/dynamic/player/thrust-effects.ts | thruster／booster module anchor から噴射位置を得る。 |
| src/render/dynamic/player/belt-view.ts | weapon module の belt anchor を受ける。 |
| src/render/pipeline/overlay-pass.ts | ghost／guide の depth と outline を既存 3D overlay 規則へ接続する。 |
| tests/render/ship-module-view.test.ts（新規） | module transform、anchor、再構築、dispose を検証する。 |
| tests/render/dynamic-view-source.test.ts、game-entity-dispose.test.ts | 可変 module source と再建造／分離後の GPU・scene 資源解放を追加検証する。 |
| tools/render-lab/ship-cases.ts（新規）、cases.ts | 既定船、基地、ghost、分離前後を単独確認できる case を追加する。 |

#### 達成条件と検証

- 同じ assembly から計算した model と collider の軸・長さ・位置が一致する。
- 生成 asset は root scale を持たないメートル単位、module 長手軸 +Z に統一し、旧 Base の scale 3 と
  local +Y の dock 面を引き継がない。
- exporter の material merge 後も module 境界と semantic anchor が消えない。module は独立 Group
  または独立 asset とし、統合 mesh の userData に識別を依存させない。
- ghost は共有 material を変更せず専用 clone／material を所有し、別の船の色へ波及しない。
- 追加・撤去・split 後に古い mesh、outline、shadow、marker が残らない。
- ghost が不透明物と区別でき、奥行き関係を失わず、schematic 表示でも読める。
- npm run export-assets 後、識別子だけ変わった無関係 asset 差分を戻す。
- npm run typecheck と npm run test:render を通し、render-lab の画像で確認する。

### 6. Player を ModularShip へ移す

#### 目的

既定自機の制御・戦闘機能を、player 専用の船体クラスではなく、能力を持つ ModularShip で動かす。

#### 変更箇所

| ファイル | 変更内容 |
| --- | --- |
| src/game/ship/modular-ship.ts（新規） | ShipAssembly、motion、view、plan、inspection、所有陣営、module capability を所有する。 |
| src/game/ship/modular-ship-motion.ts（新規） | assembly 集計を DynamicMotion の質量・推力・接触へ渡す。 |
| src/game/ship/ship-capabilities.ts（新規） | command、fire、panel、dock、decouple の小さい能力契約を提供する。 |
| src/game/player/player.ts | 状態と処理を ModularShip と既存の狭い subsystem へ移し、移行完了時に削除する。 |
| src/game/player/player-motion.ts | ModularShipMotion へ統合し、移行完了時に削除する。 |
| src/game/player/player-loadout.ts | 既定戦闘船 preset へ置換後に削除し、ship-default-parts.ts は敵専用として残す。 |
| src/game/player/fire-control.ts、belt.ts、power.ts、radiator.ts、throttle 関連 | 対応 module instance を所有者として読み、未搭載時は能力を公開しない。 |
| src/game/dynamic/dynamic-entity/controllable.ts | AttachedBoosters 具体型を除き、module capability を読む。 |
| src/game/dynamic/dynamic-system.ts | isPlayer と instanceof Player を player-owned commandable ship 判定へ置換する。 |
| src/game/stages/stage.ts、stage0.ts、stage00.ts、stage1.ts、stage2.ts | Player 生成を既定戦闘船 preset の ModularShip 生成へ置換する。 |
| src/game/stages/stage-utils/logistics.ts | 補給対象を ModularShip の ammo／fuel capability で選ぶ。 |
| src/game/stages/stage-utils/wave-attack.ts、status-panel.ts | Player 具象型を player-owned commandable ship の最小契約へ変える。 |
| src/game/stages/stage-debug.ts、stage-debug-load.ts、stage-debug-alt-system.ts | debug stage の Player 生成・参照を ModularShip preset へ揃える。 |
| src/game/dynamic/dynamic-entity/enemy.ts | 追跡対象の Player 型を最小運動契約へ変える。 |
| src/game/pickable/player-inspection.ts | ship-inspection.ts へ置換し、部品列と導出役割を表示する。 |
| src/game/marker/player-markers.ts、ship-marker-renderer.ts | player-owned ModularShip と導出役割から marker を決める。 |
| src/game/lines/entity-line-manager.ts | isPlayer／isBase の別ループを player-owned ModularShip へ統合する。 |
| tests/game/modular-ship-control.test.ts（新規） | command の有無、既定操作、補給、plan、武装、熱、パネルを検証する。 |

#### 達成条件と検証

- Player クラスへの import が 0 件で、既定ステージと CREATIVE の自機が ModularShip になる。
- command を失った船は操作対象にできず、thruster／tank の不足は命令を受けても加速を生まない。
- 既定自機の HUD、射撃、弾薬ベルト、熱、電力、ラジエーター、軌道計画が従来どおり動く。
- MetalEnemy と ProteinEnemy のファイル・モデル・調整値を変更しない。
- npm run typecheck、npm run test:game、npm run test:render を通す。

### 7. Base をドックヤード船 preset へ置換する

#### 目的

Base 特例を削除し、操縦可能な船へ dock_ring module を積んだ結果として基地機能を生じさせる。

#### 変更箇所

| ファイル | 変更内容 |
| --- | --- |
| src/game/dynamic/dynamic-entity/base.ts | 生成、保存、inspection を置換後に削除する。 |
| src/game/dynamic/dynamic-entity/base-motion.ts | ModularShipMotion へ置換後に削除する。 |
| src/game/dynamic/dynamic-entity/base-collision.ts | compound shape へ置換後に削除する。 |
| src/render/dynamic/dynamic-entity/base-view.ts | ModularShipView へ置換後に削除する。 |
| tools/model-builder/base-station.mjs | ship module asset へ置換後に削除する。 |
| tools/model-builder/export-base-collision.mjs | Base BVH と base-collision check を削除する。 |
| src/game/creative/object-placement.ts | 「基地」を 2 dock ドックヤード船 preset の生成へ読み替える。 |
| src/game/creative/object-placer-panel.ts | kind と class ではなく ship preset を選ぶ入力へ変える。 |
| src/game/creative/placement-validation.ts | Base 固有の月基準制約を「ドックヤード preset」の配置制約として扱う。 |
| src/game/run-summary.ts | isBase と Base.money 集計を除く。 |
| src/launcher/save/slot-data.ts、snapshot-service.ts、save-browser/snapshot-pane.ts | money metadata と表示を除く。 |
| tests/game/base-collision.test.ts | 削除し、compound cylinder と dockyard preset の接触テストへ置換する。 |
| tests/game/creative-placement-validation.test.ts | 「基地」preset の月基準制約と ModularShip 上限判定を検証する。 |
| package.json | base-collision、base-collision:check と CI 呼び出しを削除する。 |

#### 達成条件と検証

- rg で Base、BaseMotion、BaseView、baseStation、base collision asset の実行時参照が 0 件になる。
- CREATIVE の「基地」preset は有限質量、HP、燃料を持ち、通常船と同じ操作・接触・喪失経路を使う。
- preset は健全な command と 2 個の dock を持つため、導出役割が「基地」になる。
- npm run typecheck、npm run test:game、npm run test:render を通す。

### 8. AttachedBoosters と DetachedBooster をデカプラー分割へ置換する

#### 目的

専用の段管理をなくし、同じ assembly の一部をデカプラーで 2 隻へ分ける。

#### 変更箇所

| ファイル | 変更内容 |
| --- | --- |
| src/game/ship/ship-decoupling.ts（新規） | 対象 decoupler 選択、assembly split、状態分配、分離 impulse、spawn を原子的に行う。 |
| src/game/player/attached-boosters.ts | ship-decoupling へ置換後に削除する。 |
| src/game/player/attached-booster-motion.ts | ModularShipMotion へ置換後に削除する。 |
| src/game/player/booster-stack.ts | booster module の燃焼計算へ移し、移行完了時に削除する。 |
| src/game/dynamic/dynamic-entity/detached-booster.ts | ModularShip spawn へ置換後に削除する。 |
| src/game/dynamic/dynamic-entity/detached-booster-motion.ts | ModularShipMotion へ置換後に削除する。 |
| src/render/dynamic/player/attached-boosters-view.ts | ModularShipView の module 表示へ置換後に削除する。 |
| src/render/dynamic/dynamic-entity/detached-booster-view.ts | ModularShipView へ置換後に削除する。 |
| src/render/dynamic/booster-model.ts | module asset へ置換後に削除する。 |
| tools/model-builder/booster.mjs | ship-modules.mjs へ統合する。 |
| src/game/game.ts | attach callback を除き、[5]／[6] を active ship の decouple／booster capability へ渡す。 |
| src/game/hud/panels/burn-management-panel.ts | 固定最大 4 段ではなく、現在の decoupler と booster module 列を表示する。 |
| tests/game/ship-decoupling.test.ts（新規） | 所有権、ID、HP、燃料、点火、重心、運動量、衝突猶予、保存を検証する。 |

#### 達成条件と検証

- AttachedBoosters と DetachedBooster の import が 0 件で、旧互換 facade が残らない。
- 接続中と分離後が同じ booster module state を 1 回だけ進め、燃料が二重消費されない。
- 分離直後の親子は猶予中に自己衝突せず、猶予後は通常接触へ戻る。
- npm run typecheck、npm run test:game、npm run test:physics、npm run test:render を通す。

### 9. dock state、ドッキング、修理を実装する

#### 目的

dock_ring の各 dock を、空、建造中、完成船格納中の状態機械にし、接近した既存船の接舷と
再発進を成立させる。

#### 変更箇所

| ファイル | 変更内容 |
| --- | --- |
| src/game/ship/ship-dock-state.ts（新規） | empty、building、complete と occupant assembly／entity identity を持つ。 |
| src/game/ship/ship-docking.ts（新規） | 位置・軸・相対速度の eligibility、attach、detach を実装する。 |
| src/game/ship/ship-repair.ts（新規） | 健全な dock で格納船の module HP を最大へ戻す。 |
| src/game/ship/modular-ship-motion.ts | 格納船の質量・形状を host に含め、attach／detach 時に予測を無効化する。 |
| src/game/dynamic/entity-lifecycle.ts、entity-registry.ts | registry と dock ownership の移管を同一フレームで原子的に行う。 |
| src/game/control-selection.ts | 接舷／発進時の操作対象切替と、対象不在時の既存規則を扱う。 |
| src/game/pickable/ship-inspection.ts | dock ごとの状態、条件、不成立理由、操作を property row として提供する。 |
| tests/game/ship-docking.test.ts（新規） | 境界値、ID 維持、control 切替、target 解除、複数 dock、host loss を検証する。 |
| tests/game/ship-repair.test.ts（新規） | dock 健全性、格納条件、全 module HP 回復、自然回復なしを検証する。 |

#### 達成条件と検証

- 距離 1.0 m、角度 10°、相対速度 1.0 m/s の内外で、ドッキング可能条件だけが正しく反転する。
- 許容誤差内の任意の位置・姿勢から確定しても、ドッキング後の接続点間距離と軸角度のずれが 0 になり、
  対象船がホスト船に対する相対運動を持たない。
- attach 後に同じ船が registry と dock の両方へ存在せず、detach で同じ ID が 1 個だけ戻る。
- 4 dock が互いの occupant を上書きせず、host の能力へ occupant の能力を混ぜない。
- npm run typecheck、npm run test:game、npm run test:physics を通す。

### 10. 戦闘ビューの建造モードとゴースト配置を実装する

#### 目的

選択 dock を起点に、3D 表示を見ながらモジュールを追加・撤去できる最小 UI を作る。

このステップの開始前に /ui-design を起動し、既存の panel shell、property window、overlay manager、
タッチ規約へ合わせる。

#### 変更箇所

| ファイル | 変更内容 |
| --- | --- |
| src/game/ship/ship-construction.ts（新規） | 選択 dock、catalog selection、candidate、配置、撤去、破棄、完成判定を所有する。 |
| src/game/hud/panels/ship-construction-panel.ts（新規） | catalog、能力集計、完成条件、操作ボタンを表示する。 |
| src/game/hud/style/ship-construction-style.ts（新規） | 既存 token と panel shell だけを使って建造 UI を整える。 |
| src/game/view/combat-view.ts | construction mode を通常の combat pick／target pointer handling より先に処理する。 |
| src/game/camera/camera-system.ts | 選択 dock への focus、建造中の orbit／zoom、同一フレームの screen ray 入力を提供する。 |
| src/game/camera/screen-ray.ts（新規） | camera update 後の Viewpoint と viewport 座標から CPU 側の world ray を組み立てる。shader 用 view-ray.ts は流用しない。 |
| src/game/display-window-manager.ts | 建造開始時に display time を現在へ戻し、終了まで過去／未来表示を固定する。 |
| src/game/input/game-actions.ts、game-commands.ts、game-input-router.ts | 建造中の world input 遮断と camera／confirm／close の配送を追加する。 |
| src/game/game.ts | ShipConstruction の生成、update、sync、dispose、pause 所有を配線し、建造 pointer だけを通常の pause return より先に配送する。 |
| src/game/hud/hud.ts、hud-root.ts、hud-layers.ts | combatRoot の hud rail へ建造 panel を置き、寿命と表示を配線する。 |
| src/game/hud/windows/menu-actions.ts | dock の建造、修理、接舷、切り離し操作を property window の action として追加する。 |
| src/render/dynamic/ship/ship-ghost-view.ts | pointer ray と候補状態から ghost を同期する。 |
| src/render/dynamic/ship/dock-snap-guide-view.ts | 選択 dock の自由端と hover 状態を同期する。 |
| tests/game/ship-construction.test.ts（新規） | 追加、末尾撤去、32 個上限、4 dock 上限、未完成保持、破棄、pause を検証する。 |
| tests/game/construction-input-routing.test.ts（新規） | 飛行・射撃・target を遮断し、camera と建造操作だけが通ることを検証する。 |
| tests/render/ship-construction-ghost.test.ts（新規） | valid／invalid／hidden、snap transform、dispose を検証する。 |
| tests/render/camera-view.test.ts | perspective／orthographic の screen ray と camera update 直後の一致を検証する。 |

#### 達成条件と検証

- combat view を離れずに空 dock から完成船を作り、発進できる。
- camera を動かしたフレームでも pointer ray と ghost が同じ camera state を使い、1 フレーム遅れない。
- 建造中の display time は simTime に一致し、過去／未来の表示位置へ module を確定できない。
- mouse と touch の両方で catalog 選択、ghost 確定、末尾撤去、終了、破棄ができる。
- 建造のために停止中でも ghost click は届き、flight command、fire、warp、target change は世界へ
  漏れず、ESC は共通管理から閉じる。
- npm run typecheck、npm run test:game、npm run test:render を通す。

### 11. ship 保存、漂流、CREATIVE 統合を完成させる

#### 目的

すべての役割と中間状態を 1 種類の ship 保存形式で復元し、喪失と燃料切れを分ける。

#### 変更箇所

| ファイル | 変更内容 |
| --- | --- |
| src/game/save/save-data.ts | ShipSaveData、ShipAssemblySaveData、module state、dock state を追加し、旧 3 kind と BaseSaveData を削除して version 4 にする。 |
| src/game/dynamic/dynamic-entity/entity-dictionary.ts | ship の一経路から ModularShip と格納 assembly を復元する。 |
| src/game/ship/ship-save.ts（新規） | module／dock の discriminated union validator と serialize／restore を持つ。 |
| src/game/creative/object-placement.ts、manual-spawn.ts | 既定戦闘船／ドックヤード船 preset と上限判定を ModularShip へ揃える。 |
| src/game/stages/creative-stage.ts | 操作対象、補給、波状攻撃、喪失を player-owned commandable ship で扱う。 |
| src/game/dynamic/entity-lifecycle.ts | destroyed と stranded を分け、player-owned alive ship を距離で除去しない。 |
| src/game/run-summary.ts | ModularShip 数を集計し、money を除く。 |
| src/launcher/save/save-transfer.ts、legacy-save.ts、snapshot-service.ts | version 4 と metadata 変更を反映し、v3 を移行しない。 |
| src/launcher/save-browser/snapshot-pane.ts | 所持金行を除き、船数を新しい集計へ合わせる。 |
| tests/game/ship-save-roundtrip.test.ts（新規） | free、building、docked、split、stranded の round trip を検証する。 |
| tests/game/ship-loss-persistence.test.ts（新規） | destroyed は除去、fuel 0 は生存・保存、host loss は occupant も喪失を検証する。 |

#### 達成条件と検証

- rg で保存 kind の player、base、booster と BaseSaveData、DetachedBoosterSaveData が 0 件になる。
- v4 の保存復元前後で module id、entity id、owner、HP、燃料、点火、dock state、導出 role、
  control が一致する。
- v3 は壊れたデータではなく「対応しない版」として拒否される。
- 燃料切れ船を時間経過・ビュー切替・保存復元しても消えない。
- npm run typecheck と npm run test:game を通す。

### 12. 旧経路を削除し、統合検証する

#### 目的

共通化後に旧クラス、旧モデル、旧 save kind、別集計が残っていないことを確認し、ユーザーが求める
一連の操作を実行時に検証する。

#### 変更・検査箇所

- src/game/player、src/game/dynamic/dynamic-entity、src/render/dynamic の旧 Player/Base/booster
  専用ファイルと import を削除する。
- src/assets/models の旧 player/base/booster asset を、参照 0 を確認してから削除する。
- help content、property window、marker label、object list、burn management の用語を
  「役割としての自機／基地／ブースター」へ揃える。
- git diff でユーザー作業中の memos/mikanixonable/dev.md と既存の移動中メモを変更していないことを
  確認する。

#### 達成条件と検証

- npm run typecheck を通す。
- npm run test:physics、npm run test:game、npm run test:render を通す。
- npm run export-assets の差分を確認し、無関係な識別子差分を含めない。
- /rendering-workflow に従い render-lab で、2 dock 基地、module 列、ghost、outline、分離前後、
  格納状態を画像比較する。
- ユーザーが「動くか確かめたい」と明示しているため /verify を起動し、npm run smoke:browser で
  次の実操作を確認する。
  1. CREATIVE でドックヤード船を配置して操作対象にする。
  2. combat view で dock 1 を開き、command、hull、tank、thruster、docking_port を含む船を作る。
  3. decoupler と booster を含む構成を発進させ、[6] 点火、[5] 分離を行う。
  4. 分離後の船を dock 2 へ条件内で接舷し、損傷を修理し、末尾を交換して再発進する。
  5. 建造途中、格納中、燃料 0 の各 snapshot を保存・読み込みし、状態が戻る。
  6. 船を破壊し、破壊船だけが消え、別の船と歴史線が残る。
- git diff --check を通す。

## 見積り

| 作業 | 導出 | 概算 |
| --- | --- | ---: |
| 仕様更新 | 8 文書 × 0.5 時間 + 相互参照監査 1 時間 | 5 時間 |
| characterization と assembly domain | 3 test 群 × 0.75 時間 + domain 4.75 時間 | 7 時間 |
| compound 物理・質量特性 | capped 接触／ray／sweep 8 時間 + 質量特性 3 時間 + 接続 2 時間 + test 2 時間 | 15 時間 |
| module model・view・anchor | 12 module × 0.5 時間 + view/ghost 5 時間 + 視覚検証 3 時間 | 14 時間 |
| Player → ModularShip | 制御・戦闘・熱・電力・表示の 5 系統 × 2 時間 + 配線・回帰 6 時間 | 16 時間 |
| Base → dockyard preset | class/motion/view/collision の 4 経路 × 1.5 時間 + UI/summary 3 時間 | 9 時間 |
| decoupler 分離 | 状態分割 3 時間 + motion 3 時間 + UI/描画 2 時間 + test 3 時間 | 11 時間 |
| docking・repair | state/eligibility/ownership/mass の 4 群 × 2 時間 + test 3 時間 | 11 時間 |
| construction UI・ghost | domain 3 時間 + panel/input 5 時間 + 3D sync 3 時間 + test 3 時間 | 14 時間 |
| save・CREATIVE・loss | save/restore 4 時間 + lifecycle 2 時間 + launcher 2 時間 + test 3 時間 | 11 時間 |
| cleanup・統合検証 | 旧経路監査 2 時間 + test/asset 3 時間 + 実操作 3 時間 | 8 時間 |
| 合計 | 5 + 7 + 15 + 14 + 16 + 9 + 11 + 11 + 14 + 11 + 8 | 121 時間 |

目安は 15 人日前後。最大の不確実性は、Player 固定モデルの semantic anchor 移行と、格納船を含む
compound contact である。MVP の機能を削らず短縮する場合は、既存モデルを一時 module として包むのでは
なく、module model の造形品質を単純な円筒へ抑える。

## リスクと落とし穴

| リスク | 関係ステップ | 影響 | 対策 |
| --- | ---: | --- | --- |
| PartInventory の浅いコピーで split 両側が同じ HP／fuel を共有する | 3, 8 | 一方の損傷や燃焼が他方へ伝播する | split は remove-and-transfer に限定し、instance id の一意性を全 registry＋dock で検査する。 |
| decoupler 等の追加でランダム被害の確率が変わる | 2, 3 | 同じ総 HP でも耐久感が変わる | アルゴリズムは「健全な HP module 一様」を仕様化し、構成による確率変化は意図した結果として test に固定する。 |
| command を持たない booster が critical-part 判定で即死する | 3, 8 | 分離直後に消える | 「存在する critical module の全損」と「元から不在」を分ける。 |
| 通常推進と BoosterStack の両方が燃料・推力を進める | 6, 8 | 二重燃焼、過大加速 | booster state の step 所有者を ModularShipMotion だけにし、旧 stack を同じ変更で削除する。 |
| collisionEnableAt、event boundary、contactsWith の一部だけ移す | 8 | 分離直後に爆発的再衝突する | 3 経路を characterization test で固定し、分離 transaction で同時設定する。 |
| contactKind の変更で自弾猶予や接触音が変わる | 6–8 | 自分の分離物へ即命中する、音が消える | entity class ではなく ownership と derived role から contact policy を決め、bullet/debris reaction を回帰テストする。 |
| module 質量を初めて実運動へ反映して既定加速度が変わる | 3, 4, 6 | 操作感と既存ステージ難度が変わる | 既定 preset の総質量と推力を現行加速度へ校正し、4 段階すべてを数値テストする。 |
| Base の無限質量／HP なしを落とすことで基地が動き、壊れる | 7 | 既存 Base と違うゲーム性になる | 共通船体要件に伴う意図した廃止として SPEC に明記し、dockyard preset の有限値を明示する。 |
| rendered accessory と collider がずれる | 4, 5 | 見えない壁、めり込み、弾のすり抜け | model definition と solid primitive を同じ module definition から生成し、ray/contact/render fixture を共有する。 |
| 現行のカプセル円柱で dock 端面より早く接触する | 4, 9 | 見た目上は離れているのに接舷条件へ入らない | 新船体だけは capped-cylinder 判定を正本にし、現行 helper の意味を暗黙変更しない。 |
| camera frame が pointer 処理より後に同期される | 10 | camera 移動直後の ghost が 1 フレームずれる | camera update 後の viewpoint／projection から input 用 ray を即時生成し、前回 CameraFrame を読まない。 |
| 過去／未来表示中に建造する | 10 | 見える位置と現在の物理位置が食い違う | 建造開始で display time を現在へ戻し、終了まで固定する。 |
| model exporter の merge で module id／anchor が消える | 5 | picking とノズル位置を復元できない | module 境界を Group／asset に置き、先頭 userData の継承へ依存しない。 |
| ghost の共有 material を変更する | 5, 10 | 全 ship の色や透明度が変わる | ghost 専用 material を clone し、dispose 所有を test する。 |
| 格納船を host capability に合算する | 4, 9 | docked command や武装で基地能力が増える | physical aggregate と functional aggregate を別関数にし、後者は host own assembly だけを読む。 |
| attach／detach 中に registry と dock の両方へ同じ ID が存在する | 9, 11 | 二重 update、二重描画、save 重複 | lifecycle transaction と全所有領域の ID 一意性 test を置く。 |
| 建造モードの入力が飛行や射撃へ漏れる | 10 | module 配置中に基地が動く／撃つ | GameInputRouter で construction を高優先度 mode とし、独自 DOM listener を禁止する。 |
| v3 非互換で既存 snapshot が使えなくなる | 1, 11 | 過去の履歴を再開できない | version 4 の破壊的変更として UI 上で対応外表示にし、実装前にこの計画の承認で判断を確定する。 |
| 32 module の pairwise narrow phase が増える | 4, 9 | 多数艦接触時のフレーム低下 | bounding sphere で候補を絞り、compound 同士だけ最大 32×32。perf count を追加し必要なら BVH は後続にする。 |
| host 喪失時の格納船処理が曖昧になる | 9, 11 | 消失、二重 spawn、save 不整合 | MVP は host と同時喪失に固定し、1 test で lifecycle を確定する。 |
| game-wide refactoring plan の「Player/Base を一般化しない」と競合する | 6, 7 | 二重の将来計画になる | 本計画が player/base/booster の実体方針を上書きする。敵を一般化しない境界は維持する。 |
| ユーザー作業中の memo 差分へ触れる | 全体 | 無関係な変更を混入する | 対象ファイルだけを stage し、開始・終了時に git status と git diff を確認する。 |

## 自己レビューで追加した事項

初稿を要件から逆算し、次を明示的な実装条件として追加した。

- 「完成船も再び dock を使える」を保証するため、完成条件に終端 docking_port を追加した。
- multiple dock と自由な role 変更を両立するため、dock は module 所有の state とし、Base 相当の
  別 registry や manager を作らない。
- 格納船を host と別剛体のまま拘束すると現在の物理へ joint が必要になるため、MVP は host の
  compound shape／mass へ含める方式に固定した。
- 分離後の HP／fuel 共有を防ぐため、ShipAssembly split は clone ではなく所有権移動に固定した。
- command 不在の booster を既存 critical-part 判定が殺さないよう、生存条件を分けた。
- 現在の Base.money は将来の資源ループの正本にできないため、船体変更へ持ち込まず削除することにした。
- 「帰れない船は消えない」の範囲を、現在のランと snapshot 内の生存に限定した。補給、救助、遠征間の
  永続宇宙は次の機能仕様で決める。
- 旧提案にあった第三の dock view、2D silhouette、shop、paint、blueprint、固定 hardpoint は今回の
  3D combat-view MVP と競合するため対象外にした。
- 現行の円柱同士判定がカプセル近似であることを踏まえ、dock 面と ghost を一致させる capped-cylinder
  判定を新船体専用に追加し、薬莢などの既存挙動は暗黙変更しないことにした。
- camera sync の順序と表示時刻のずれを踏まえ、同一フレームの screen ray と、建造中の present 固定を
  明示的な達成条件へ加えた。
