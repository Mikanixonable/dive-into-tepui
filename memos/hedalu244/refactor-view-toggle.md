# ビュー二重化の解消 — 戦闘/マップの経路分けとカメラ統合の計画

作業ブランチ `refactor-view-toggle`。コード計測はすべて **b4e600e8** 時点。

## 目的

「戦闘ビューかマップビューか」という1つの状態が、いま4つの形で現れている。

1. **正本の分散。** ViewManager.worldView が正本と宣言されているのに、CameraSystem
   `_overviewMode`・PlanEditor `_editMode`・TouchControls のマップフラグが同じ値の鏡像を持ち、
   ViewManager.applyChrome() が毎遷移で配って回っている(`setMapMode(open: boolean)` 3箇所)。
2. **引数の漏出。** `overviewMode: boolean` が src/ の **39ファイル・176出現**に散り、
   多くの受け手が `if (!overviewMode) return;` で自分をゲートしている(targeter の3メソッド、
   celestialMarkers.syncSubLabels、linePickables.refresh、mapPickables.refresh、
   mapActions の5メソッド)。ビューを固定すると通らない行がモジュール半分に及ぶものがある。
3. **game.ts の2責務同居。** update/sync/handleInput の約230行が、共通処理・マップ専用・
   戦闘専用を行単位で混在させている。ゲートが呼び手と呼び先に割れているため、
   **どの行がどのビューのものか読めない。**
4. **カメラの二重実装。** ChaseCamera(144行)と MapCamera(623行)は「注視対象を中心に置く
   軌道カメラ」という同じ責務の別実装で、ドラッグ回転は**画面上の挙動が同一**なのに符号系だけ
   逆に書かれている(後述の差分表)。操作項目(回転モード・座標系・投影)がパネル化された今、
   違いの本体は「何を追えるか」と数値設定に縮んでいる。

この構造は既に実害を出している: **戦闘ビューの [N] 自動ワープと [Del] 計画破棄は現在死んでいる。**
commit ff17e7ee がビュー分離の際に `editor.handleInput` をマップ専用にゲートしたが
(game.ts:477)、editor 側の該当分岐は `!editMode`(=戦闘ビュー)でしか通らないため、
両ビューのどちらでも実行されなくなった。SPEC/GAME.md はマップ退出時に
「[N] で直近ノードへ自動ワープ」とヒントを出すと定めており、仕様違反の回帰である。

修正後に期待される状態: ビューの正本は ViewManager の1箇所、カメラの実装クラスは1つ
(+ガンサイト)、game.ts のフレーム処理は「共通」を地の文に、ビュー固有を CombatView /
MapView の2具象への固定位置の呼び出しにし、`overviewMode` という語彙が src/ から消える。

## 決めたこと

覆すときは、右端の手順が変わる。

| # | 決定 | 根拠 | 覆すと変わる手順 |
| --- | --- | --- | --- |
| D1 | 統合カメラは**1クラス・2インスタンス**(戦闘用/マップ用)。視点状態・セーブは別のまま | [M] 切替で各ビューの視点が独立に保存復元される現挙動と、CameraSaveData の `chase`/`overview` 2キーを保つ | 手順4・5・6 |
| D2 | 姿勢追従は回転追従の一選択肢として**見せる**が、実装は ReferenceFrame の回転源に畳まず**カメラ内の合成層** | FrameAnchorSource.stateOf は KinematicState(r,v)のみで姿勢を返さない。フレーム機構で表すには physics/frame の拡張が要り、過大 | 手順4 |
| D3 | 旧セーブの `chase`(rot/dist/pan/followAttitude)は**読み捨てて既定視点で復元**。`overview` はそのまま読む(回転追従の選択は初回 update で妥当性検査し、選択肢に無ければ慣性系へ落とす) | rot は姿勢相対でありロード時点の姿勢なしに新形式へ変換できない。視点は軽微な損失。キー名 `chase`/`overview` は互換のため変えない | 手順4・5 |
| D4 | ロールの回転方向は現在**ビュー間で画面上逆**(仕様に記載なし)。マップ側の向きへ統一 | 単一実装の自然な帰結。ドラッグ・キー回転・パンは画面上同一なので変わらない(差分表参照) | 手順3・5 |
| D5 | Targeter は多態に割らず単一のまま、残る分岐は `view: WorldView` 引数にする | CombatTargeter/MapTargeter に割ると aliveTarget・boardMarks・マーカーレジストリの正本が割れる(共有状態問題)。この案は再提案しない | 手順7 |
| D6 | ビュー固有処理は CombatView / MapView の2具象 + Game 内の単一 getter でディスパッチ | WaveState と同じ「1箇所ディスパッチ」の形。route を分ければ受け手のゲートが消え、これが論点13 の決着になる | 手順6 |
| D7 | 操作感の数値は両ビュー統一: ホイールズーム感度 **0.0015**(現行 0.0012/0.0018 の双方を変更)、最小距離は**フォーカス依存**(天体= max(1e3, 半径)、機体= 12 m)。インスタンス設定に残るのはフォーカス喪失方針のみ | ユーザー決定(2026-09-02)。両ビューで同じ対象を見たときの操作感を揃える | 手順3・4 |
| D8 | 経路分けで消えるゲートは引数ごと削除、残る外観選択の分岐は `boolean` をやめ `WorldView` を渡す | on/off でない2分を boolean で運ばない。`overviewMode` 0件が判定基準 | 手順6・7 |
| D9 | 回転追従の選択肢は**フォーカス対象から導く**: 慣性系=常時、天体フォーカス=**その天体の公転・自転+その天体の衛星(恒星なら惑星)の公転**、機体フォーカス=姿勢+(周回中のみ)公転、固定点=慣性系のみ。無効化した選択は慣性系へ落とす | ユーザー決定(2026-09-02)の構造の具体化。衛星の公転を含めるのもユーザー決定 — 地球フォーカスのまま地球-月回転系(月の公転)を選ぶ現行の組を守る。導出元が「カメラ位置(連続量)」から「フォーカス(離散量)」へ変わり、「役割の公転」は機体フォーカスの公転へ翻訳される(D11)。計画区画の回転ゾーンは現行のまま | 手順3・4 |
| D10 | [G] は**両ビュー**で「姿勢追従⇄慣性系」のトグル(フォーカスが機体のときだけ効く)。戦闘の既定フォーカス=役割「操作対象の船」+姿勢追従 | 姿勢追従が回転追従の一選択肢になった帰結。現行の chase 既定(followAttitude ON)と一致する | 手順3・5 |
| D11 | 機体フォーカスの「公転」は残す(現行「役割の公転」の新構造への翻訳) | D9 で役割の公転をカメラ区画から消すため、翻訳先を作らないと既存能力が黙って狭まる | 手順3・4 |

## 達成目標

1. `grep -rn "overviewMode" src/` が **0件**(現在 39ファイル・176出現)。
2. `grep -rn "setMapMode" src/` が **0件**(現在 CameraSystem・PlanEditor・TouchControls の3定義)。
3. `src/game/camera/` のカメラ実装クラスが統合カメラ1つ + GunsightCamera のみ。
   `chase-camera.ts` / `combat-camera-system.ts` が存在しない。
4. game.ts の update/sync/handleInput/handlePointerInput の中に、ビュー分岐が
   activeView を選ぶ 1 getter 以外に無い(`isMapView` の grep で確認)。
5. 戦闘ビューで [N] 自動ワープと [Del] 計画破棄が効く(実機で hint 表示を確認)。
6. 戦闘ビューで操作対象以外(天体・他艦)へフォーカスでき、太陽系スケールまでズームアウト
   できる(実機確認)。
7. マップビューの操作が手順3の仕様どおり: ドラッグ・パン・平行投影・画角・基準面ジャンプは
   不変で、意図した変更はホイール感度(0.0018→0.0015)と回転ゾーンの選択肢
   (フォーカス由来へ)だけ(実機確認)。
8. ホイールズーム感度の定数が src/ に **0.0015 の1箇所**(`grep -rn "0.0012\|0.0018" src/game/camera/`
   が 0件)。
9. マップビューで機体をフォーカスすると 12 m まで寄れ、[G] で姿勢追従が効く(実機確認)。
10. 旧セーブが例外なく読み込める。マップ視点は復元され(回転追従が新選択肢に無い場合は
    慣性系へ)、戦闘視点は既定へ落ちる(D3)。
11. 各手順で `npm run typecheck`、src/game/ に触れた手順で `npm run test:game` が通る。
    main へ送る際は全テスト(/send-pr)。

## 現状の差分表(手順3・4・5 の判断材料)

ChaseCamera と MapCamera の全挙動差。実装から導出した。「画面上」とはユーザーから見た挙動。

| 項目 | ChaseCamera(戦闘) | MapCamera(マップ) | 統合方針 |
| --- | --- | --- | --- |
| 注視対象 | DynamicEntity を毎フレーム引数で受ける(実質 操作対象固定) | FocusTarget('object' id / 'point')を保持し毎フレーム解決 | FocusTarget に統一。戦闘の既定は役割「操作対象の船」 |
| 対象喪失時 | update が early return し**視点ごと凍結** | 2フレーム連続失敗で**原点天体へ戻る** | インスタンス設定: 戦闘=最終解決位置に留まる、マップ=現状のまま |
| 基準フレーム | camFollowAttitude(対象姿勢 or ECI)、[G]で切替時に rot を読み替え | ReferenceFrame(慣性系・公転・自転)を**カメラがいる系**から列挙、切替時に座標変換 | 選択肢を**フォーカス対象から導出**(D9): 慣性=常時、天体=自分の公転/自転+衛星の公転、機体=姿勢/公転。姿勢は合成層(D2)、[G] は両ビュー(D10) |
| 回転の持ち方 | クオータニオンのみ | quaternion / euler の2モード(パネルで切替) | 統合カメラがそのまま持つ。戦闘インスタンスは quaternion 固定で開始 |
| 投影 | 透視のみ、FOV 55 固定(ガンサイト時 6 へ lerp) | 透視/平行、FOV 15–120 可変 | 統合カメラが持つ。FOV lerp とガンサイトは戦闘専用の外側の層 |
| near / far | 2 m / 2e12 m 固定 | dist/1000(天球シェルでクランプ)/ clamp(dist×100, 1.5e10, 1e16) | dist 比例に統一。**far 下限を 1.5e10 → 2e12 に引き上げ**(戦闘で恒星 1.4e12 が消えないため) |
| dist 範囲 | 12–8000 m、ホイール感度 0.0012 | max(1e3, 天体半径)–1e14、感度 0.0018(1.5倍はトラックパッド対応の意図) | 下限はフォーカス依存(天体= max(1e3, 半径)、機体= 12 m)。上限 1e14 に統一(戦闘のズームアウトが新機能)。感度は **0.0015 に両ビュー統一**(D7 — 両ビューとも感度が変わる) |
| ドラッグ回転 | dragVec=right·dx+up·dy、axis=cross(dragVec, view) | dx符号を反転した同形(+Z の意味が逆なことを補償) | **画面上は両者同一**(検算済み・SPECも一致を明記)。単一実装で自然に保存される |
| キー回転(矢印) | up軸 -yaw / right軸 +pitch | 同じ式(quaternion モード) | 画面上同一。そのまま |
| ロール | axis = view(カメラ→対象) | axis = offset(対象→カメラ) | **画面上は逆**(未仕様)。マップ側へ統一(D4) |
| パン | right·panDx + up·panDy | 符号込みで**画面上同一**(検算済み) | そのまま |
| リセット | rot/dist/pan を既定へ、hint なし | ロールを基準軸へ・パンのみ原点へ、hint あり | 戦闘のリセットは「フォーカスを操作対象へ・回転追従を姿勢へ・視点を既定へ」に再定義(手順3)。マップは現行のまま |
| セーブ | {rot, dist, pan, followAttitude} | {offset, pan, up, rotatingWith, focus, rotationMode, fovDeg, projectionMode, orthographicHalfHeight, referencePlane} | マップ形式に一本化。旧 chase は読み捨て(D3) |

## 手順

### 手順1. 戦闘ビューの [N]/[Del] を復旧する(バグ修正)

**目的** — ff17e7ee で死んだ計画キーを仕様どおりに戻す。後続の経路再編で同じ穴を
再現しないための基準挙動を先に固定する。1行の独立コミット。

PlanEditor.updateEditing は `dvEditActive`(編集モード かつ ノード選択中)で自身をゲート
しているので、戦闘ビューで呼んでも WASDQE を食わない(確認済み)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| src/game/game.ts:477 | `if (this.viewManager.isMapView)` ゲートを外し、`editor.handleInput` を無条件に呼ぶ |

**達成条件と検証** — `npm run typecheck`。`npm run dev` で戦闘ビューにて:
[N] →「ノードへ自動ワープ開始」または「マニューバノードがありません」の hint、
ノードのある計画で [Del] →「マニューバ計画を破棄」の hint。マップビューで WASDQE の
Δv 編集が変わらず効く。`npm run test:game`。

### 手順2. ビュー正本を ViewManager の1箇所にする

**目的** — CameraSystem の `_overviewMode` 複製ステートを消し、ViewManager から provider で
読ませる。**この時点で挙動は変えない**(`get overviewMode()` の導出は残し、呼び手は触らない)。

構築順の罠: CameraSystem は ViewManager より先に生成される。Game のコンストラクタで
`() => this.viewManager.current` のクロージャを渡せば、ViewManager 代入前にカメラの
update/sync は呼ばれないので成立する(コンストラクタ中にビューを読む箇所が無いことは確認済み)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| src/game/camera/camera-system.ts | `_overviewMode`・`setMapMode` を削除。ctor に `view: () => WorldView` を追加し、`get overviewMode(): boolean { return this.view() === 'map'; }` に置換 |
| src/game/game.ts | CameraSystem 生成時に `() => this.viewManager.current` を渡す |
| src/game/view-manager.ts | applyChrome() から `cameraSystem.setMapMode(map)` を削除 |

**達成条件と検証** — `npm run typecheck`。`grep -n "setMapMode" src/game/camera/` が 0件。
`npm run dev` で起動時例外なし・[M] 切替でカメラが切り替わる。`npm run test:game`。

### 手順3. 仕様を確定する(SPEC 更新)

**目的** — カメラ統合(手順4・5)と戦闘ビューの新挙動を、コードより先に SPEC へ確定する。
以下の文面を土台に、既存文とのつながりを整えて書き込む。

**DEVELOP/SPEC/CONTROLS.md「カメラ操作」節の差し替え文面(案):**

> ### 視点カメラ(両ビュー共通)
>
> 両ビューの視点は同じ仕組みの注視カメラで、**フォーカス対象**を注視点に置く。
>
> - フォーカスは「特定の対象(天体・自艦・敵・基地・弾薬・役割)を追う」か「空間上の固定点」
>   のいずれか(解決の規則は MAP.md「マップカメラ」)。戦闘ビューの既定フォーカスは役割
>   「操作対象の船」で、操作対象を乗り換えると視点も自動で移る。
> - ヨー・ピッチ・ロール・ズーム・パンの操作は「カメラ」の表のとおり両ビュー同一で、
>   同じ操作に対する画面上の見た目の動きも感度も両ビューで一致する。
> - ズームの下限はフォーカス対象に応じる: 天体はその半径、機体などは艦を間近に見る距離。
>   上限はどちらのビューでも太陽系全体が収まる引き。近すぎる/遠すぎるという理由で物体が
>   切り取られることはない(近平面・遠平面の扱いは RENDERING.md)。
> - **基準フレーム(回転追従)**: 視点の向きを何に固定するかは、フォーカス対象から導かれる
>   選択肢の中から選ぶ。
>   - **慣性系**(ECI 上で向きが変わらない)は、どのフォーカスでも常に選べる。既定。
>   - **天体**をフォーカスしているときは、その天体の**公転**(主星との回転座標系。恒星には
>     無い)と**自転**(自転モデルを持つ天体のみ)、および**その天体の衛星(恒星なら惑星)の
>     公転**が加わる(地球をフォーカスしたまま地球-月回転系で月を静止させる、などの組の
>     ため)。
>   - **機体**(自艦・敵・基地・弾薬と、それらへ解決される役割)をフォーカスしているときは、
>     その機体の**姿勢**への追従が加わり、対象が離心率1未満の周回軌道にあるあいだは
>     **公転**も加わる。
>   - **固定点**をフォーカスしているときは慣性系のみ(固定点自身は焼き込まれた座標系の
>     回転に追従する — MAP.md)。
>   - どの切り替えでも、切り替えた瞬間に視点は跳ばない(保持していた向きを新しい基準へ
>     読み替える)。
>   - フォーカスの変更や条件の喪失(機体の消滅・周回条件の崩れ)で選択中の追従が選択肢から
>     外れたときは慣性系へ落ち、選択表示も「解除」へ戻る。
>   - 姿勢追従中に対象が撃破されて姿勢が乱れている間は追従せず、直前の向きを保つ。
> - **[G]**: フォーカスが機体のとき、姿勢追従⇄慣性系をトグルする(両ビューで効く)。
>   戦闘ビューの既定は姿勢追従。
> - フォーカス対象を喪失したとき: 戦闘ビューでは注視点が最後に解決できた位置へ留まり、
>   視点操作は引き続き効く。マップビューでは原点天体へ戻る(MAP.md)。
> - 戦闘ビューの視点リセット(中クリック/リセットボタン)は、フォーカスを操作対象へ、
>   回転追従を姿勢へ、視点を既定の後方見下ろしへ戻す。
>
> ### 戦闘ビューでのフォーカス切替
>
> 右クリックで開くプロパティウィンドウ/空域メニューの「フォーカス」で、戦闘ビューのまま
> その対象を注視できる。座標系パネル(カメラ区画・計画区画とも)・平行投影・画角・基準面の
> 各操作はマップビューのみ。

現行文の「ドラッグによるヨーの回転方向は、戦闘ビューとは意図的に逆符号にしてある」は実装の
説明なので落とす(画面上の一致だけを仕様として残す)。「カメラ」表の [G] の行は
「フォーカスが機体のとき(両ビュー)」へ改める。

**DEVELOP/SPEC/MAP.md の修正(案):**

- 「2. マップカメラ」: 見出しと本文を両ビュー共通の注視カメラの規則として読めるよう調整し、
  ズーム下限「100 km(下限)」を「フォーカス対象に応じた下限(天体はその半径、機体は間近)」へ
  差し替える。喪失時の「地球へフォーカスが戻る」はマップビュー限定と明記する。
- 「3. 座標系パネル」: **カメラ区画の回転ゾーン**を「フォーカス対象から導かれる選択肢
  (CONTROLS.md の基準フレーム規則: 自分の公転・自転+衛星の公転、機体なら姿勢・公転)を
  出す」に差し替える。導出元が「いまカメラがいる系」からフォーカスへ変わり、「役割の公転」は
  役割をフォーカスしたときの機体の公転として現れる(計画区画の回転ゾーンは現行のまま)。
  カメラ区画については「選択肢はカメラ位置という連続量から導かれるが明滅しない」の一文が
  不要になる(フォーカスという離散量から導かれるため)。基準ゾーン・計画区画・追随トグル・
  サマリは現行のまま。

**「未確定の案」へ追記:** 戦闘ビューに座標系パネルを出すか /
マップのダブルクリックフォーカスを戦闘にも入れるか。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| DEVELOP/SPEC/CONTROLS.md | 「カメラ操作」節を上記案で差し替え。「カメラ」表の [G] 行の注記を両ビューへ |
| DEVELOP/SPEC/MAP.md | §2 の適用範囲・ズーム下限・喪失時挙動、§3 のカメラ区画回転ゾーンを上記案で修正。「未確定の案」追記 |
| DEVELOP/SPEC/GAME.md | §9.3「喪失した瞬間の視点で静止」を「注視点は最後の位置に留まる(視点操作は効く)」へ揃える |

**達成条件と検証** — SPEC の3ファイルが上記を含み、互いに矛盾しない(CONTROLS が操作、
MAP がフォーカス解決、GAME が遷移規則、と持ち場が割れている)。コード変更なし。

### 手順4. 統合カメラを組み、マップ側を新仕様へ合わせる

**目的** — MapCamera に、戦闘インスタンスとして動くのに足りない能力を足し、同時にマップ側を
手順3の仕様(感度 0.0015・フォーカス依存の下限・フォーカス由来の回転追従)へ合わせる。
マップの挙動変化は**仕様で意図したものだけ**(検証の項に列挙)。

足す/変えるもの:

- **回転追従のフォーカス由来化(D9)。** 現行 `setCameraRotation(FrameRotationSource | null)` を
  `CameraRotationFollow` へ広げ、選択肢の列挙をカメラ自身が持つ。天体フォーカスの列挙は
  「自分の公転(親があるもの)・自分の自転(自転モデルを持つもの)・子の公転」で、親子関係は
  celestialSystem から引く(bodyParentId の逆引き)。公転/自転は現行どおり ReferenceFrame へ
  変換し、姿勢は合成層(D2)で実現する。フォーカス変更・条件喪失で選択が無効になったら
  慣性系へ落とす(現行 frame-controls の isStaleRole 相当の検査をカメラへ移す)。
- **姿勢追従の合成層(D2)。** 有効時は実効回転を `attQ ∘ rotationQ` で組み、トグル時は
  ChaseCamera と同じく rot を読み替えて視点を跳ばせない。姿勢が取れないフレーム
  (撃破・喪失)は最後の合成結果を保持する(null に落ちた瞬間に rotationQ 単独へ戻すと
  ジャンプする)。姿勢の解決は構築時注入のリゾルバで行う(機体 id・役割 → Quat)。
- **数値の統一(D7)。** ホイール感度 0.0015 の単一定数。minDist = 天体フォーカスなら
  max(1e3, 半径)、それ以外なら 12 m(両ビュー共通 — マップで機体に寄れるようになる)。
- **フォーカス喪失方針(インスタンス設定)。** `'fallToOrigin'`(現行マップ)/
  `'hold'`(戦闘用 — missingFocusFrames が続いても lastResolvedFocus に留まり続ける)。
- **far 下限の引き上げ。** OVERVIEW_CAMERA_FAR_MIN 1.5e10 → 2e12(差分表)。
- **カメラ区画パネルの回転ゾーン改修。** 選択肢をカメラの列挙 API から出す
  (「〈天体〉の公転/自転」「姿勢」)。計画区画の回転ゾーンは触らない。UI に触れるので
  実装時に /ui-design を通す。
- **セーブの妥当性検査(D3)。** `rotatingWith` に `'attitude'` 種別を足し、ロード後の初回
  update で選択肢に無い値を慣性系へ落とす。

新 API の署名(検査対象):

```ts
interface FocusCameraConfig {
  readonly focusLossPolicy: 'hold' | 'fallToOrigin';  // 'hold' = 戦闘 / 'fallToOrigin' = マップ
  // フォーカス id(機体・役割)を表示時刻の姿勢へ解決する。天体・固定点・解決不能は null。
  readonly attitudeOf: (id: string, t: number) => Quat | null;
}
// 回転追従の選択。フォーカス対象から導かれる選択肢のうちの1つ。
export type CameraRotationFollow =
  | { readonly kind: 'revolution' | 'rotation'; readonly id: string }  // フォーカス天体/機体の公転・自転
  | { readonly kind: 'attitude' }                                      // フォーカス機体の姿勢
  | null;                                                              // 慣性系(常に可)
// いま選べる選択肢(慣性系は含めない)。パネル・[G]・妥当性検査が読む。
availableRotationFollows(displayTime: number): readonly NonNullable<CameraRotationFollow>[];
setRotationFollow(follow: CameraRotationFollow): void;  // 選択肢に無い値は慣性系として扱う
get rotationFollow(): CameraRotationFollow;
// [G] の実体: フォーカスが機体なら姿勢⇄慣性をトグルして true。それ以外は何もせず false。
toggleAttitudeFollow(): boolean;
```

機体フォーカスの「公転」(D11)は、役割 id では現行の「役割の公転」実装
(frameAnchors.attractorOf)がそのまま使える。**素の機体 id を ReferenceFrames が回転源として
受けられるかは実装時に最初に確かめる** — 受けられなければ、機体の公転は役割フォーカス
(操作対象の船・ターゲット)に限って提供し、その旨を SPEC に一行足す(手順3の文面を修正)。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| src/game/camera/map-camera.ts | 上記の実装。既存メンバーの改名はしない(改名は手順8) |
| src/game/camera/camera-system.ts | mapCamera 生成に設定(fallToOrigin・姿勢リゾルバ)を渡す |
| src/game/game.ts | 姿勢リゾルバのクロージャ(dynamicSystem・役割解決)を配線 |
| src/game/hud/frame/camera-frame-panel.ts | 回転ゾーンの選択肢を availableRotationFollows から出す。setCameraRotation → setRotationFollow |
| src/game/hud/frame/rotation-zone.ts | カメラ区画用の項目モデル対応(計画区画との共用をどう割るかは /ui-design で決める) |
| src/game/hud/frame/frame-controls.ts | カメラ側の isStaleRole 検査を削除(カメラへ移った)。計画側は残す |
| src/game/save/save-data.ts | FrameRotationSourceSaveData に 'attitude' を追加 |

**達成条件と検証** — `npm run typecheck`・`npm run test:game`。`npm run dev` のマップビューで:

- **変わらないこと**: ドラッグ・キー回転・ロール・パン・平行投影・画角・真上/真横・
  座標系切替時に視点が跳ばない・基準ゾーン(フォーカス選択)の内容。
- **変わること(仕様どおり)**: ホイールの寄り速度がわずかに落ちる(0.0018→0.0015)。
  回転ゾーンの選択肢がフォーカス由来になる(地球フォーカスなら 太陽-地球回転系・地球自転・
  地球-月回転系(月の公転)+解除 — 現行の LEO と同じ組が、カメラ位置でなくフォーカスから
  出る)。機体フォーカスで 12 m まで寄れ、[G] で姿勢追従がトグルする。
- far 引き上げの副作用として、マップ最小ズームでも恒星が描画されていることを目視。
- 旧セーブ(回転系選択あり)を読み、例外なく開き、選択が新選択肢に無ければ「解除」表示に
  落ちていること。

### 手順5. 戦闘ビューを統合カメラへ切り替え、ChaseCamera を消す

**目的** — CombatCameraSystem/ChaseCamera を、統合カメラの戦闘インスタンス+ガンサイト・
FOV lerp の薄い層で置き換える。戦闘ビューに「操作対象以外へのフォーカス」「ズームアウト」が
入る(手順3の仕様)。

配線の設計:

- CameraSystem が戦闘用インスタンスを
  `new FocusCamera(hud, celestialSystem, { focusLossPolicy: 'hold', attitudeOf }, saved?.combat相当)`
  で持ち、既定フォーカスは役割トークン(操作対象の船)・既定の回転追従は
  `{ kind: 'attitude' }`(D10)。FrameAnchors が毎フレーム解決するので乗り換えに自動追随する。
- ガンサイト([Z])と FOV lerp は CombatCameraSystem から CameraSystem の戦闘分岐へ移す
  (GunsightCamera クラスは残す)。[G] は CameraSystem.update の**共通部**で
  `activeInstance.toggleAttitudeFollow()` を呼ぶ(両ビューで効く — D10)。
- 戦闘の右クリック(プロパティウィンドウ/空域メニュー)に「フォーカス」項目を通す。
  マップの同項目と同じ MapCommands 経路が使えるはず — 実装時に map-context-actions.ts の
  フォーカス系 MenuAction の受け口を戦闘でも生かす。
- リセット(中クリック・#hud-chase-reset・ロール同時押し)は「フォーカスを操作対象へ・
  回転追従を姿勢へ・視点を既定へ」(手順3の仕様)。マップのリセットは現行のまま。
- 旧セーブ: CameraSaveData.chase を読める型のまま残し、ロード時に読み捨てて既定視点(D3)。
  serialize は新形式(overview と同形)を chase キーへ書く。読み込みは
  「新形式なら復元、旧形式(rot を持つ)なら既定」で分ける。

**変更が必要な箇所**

| ファイル | 何をするか |
| --- | --- |
| src/game/camera/combat-camera-system.ts | 削除(ガンサイト・lerp・near/far 定数は移設) |
| src/game/camera/chase-camera.ts | 削除(BASE_FOV 定数は移設) |
| src/game/camera/camera-system.ts | 戦闘インスタンス生成・[G]/[Z]・FOV lerp・リセット再定義。activeCamera 系 getter は「ビューでインスタンスを選ぶ」だけになる |
| src/game/camera/map-camera.ts | 既定フォーカス=役割トークンの確認(役割フォーカスは座標系パネルの基準ゾーンで既に選べる実装済みの経路。resolveFocusTarget → frameAnchors.stateOf) |
| src/game/save/save-data.ts | ChaseCameraSaveData を新旧の判別付きにする |
| src/game/save/snapshot-service.ts | serialize の呼び先確認(キー名は不変) |
| src/game/hud/panels/vessel-panel.ts:228 | camFollowAttitude の読み先を戦闘インスタンスの `rotationFollow.kind === 'attitude'` へ |
| src/game/game.ts:494 | viewBadgeContext の focus をアクティブインスタンスの focus に(戦闘でマップの focus を表示している現状の歪みが直る) |
| src/game/pickable/map-context-actions.ts | 戦闘右クリックのウィンドウ/メニューへフォーカス項目を通す |
| src/game/active-controllable-controller.ts:82 / docking/docking.ts:267 | clearFocusIf を両インスタンスへ |

**達成条件と検証** — `npm run typecheck`・`npm run test:game`。
`grep -rn "ChaseCamera\|CombatCameraSystem" src/` 0件。`npm run dev` で:

- 戦闘ドラッグ・矢印キー・パン・ホイールが従来と同じ画面上挙動(差分表の「同一」項目)。
- [G] トグルで視点が跳ばない。撃破後に視点が暴れない(静止)。
- [Z] ガンサイトの寄り/戻りの lerp。
- 戦闘で右クリック→フォーカス→敵艦/天体へ視点が移り、ホイールで太陽系スケールまで引ける。
  恒星が far で消えない。リセットで操作対象へ戻る。
- [M] 往復で両ビューの視点が独立に保たれる。
- 旧セーブ(手順前に作ったもの)を読み、例外なし・マップ視点復元・戦闘視点は既定。

### 手順6. game.ts を共通 + CombatView + MapView に割る

**目的** — フレーム処理のビュー固有行を2具象へ移し、ゲートを呼び手(route)に一本化する。
受け手の early return と `overviewMode` 引数のうち、route 化で**定数になるもの**をこの手順で
消す(外観選択に使うものは手順7)。

現状の全行分類(game.ts b4e600e8 の行番号):

| 行 | 処理 | 分類 |
| --- | --- | --- |
| 298-303 | input.update / handleInput | 共通(中の editor ゲートは手順1で消えている) |
| 305 | advanceSimulation | 共通 |
| 309-315 | displayWindow resolve / frameAnchors.update | 共通 |
| 317 | celestialSystem.update(点群はマップのみ) | 共通(view 引数、手順7) |
| 319 | editor.update | 共通(計画表示は戦闘でも出る) |
| 323-328 | predictor.update | 共通 |
| 330 | targeter.updateEquatorNodes | **マップ**(受け手ゲート → route) |
| 331 | dynamicSystem.updateBaseEquatorNodes | **マップ**(同上) |
| 334-337 | cameraSystem.update | 共通 |
| 344-346 | mapPickables.refresh | **マップ**(戦闘は clear() を新設して呼ぶ) |
| 347-349 | handlePointerInput | ディスパッチ(ゲート判定は共通に残す) |
| 354-359 | orbitRef 解決 | 共通 |
| 361-364 | entityLines.update | 共通(view 引数、手順7) |
| 439-446 | handleCombatPointerInput | **戦闘**(mapActions.handleCombatRightClick の引数ゲート削除) |
| 448-455 | handleMapPointerInput | **マップ** |
| 462-478 | handleInput 本体 | 共通 |
| 508 | viewBadge.sync | 共通 |
| 511-518 | 表示窓・frameAnchors・cameraSystem.sync | 共通 |
| 520-524 | celestialMarkers.syncLabels / hideLabels | **マップ / 戦闘**(ラベル同期フック) |
| 535-539 | celestialSystem.sync | 共通(view 引数、手順7) |
| 541-549 | dynamicSystem.sync 系 | 共通 |
| 551-555 | targeter.sync / syncTargetMarkers | 共通(view 引数、手順7) |
| 556-559 | celestialMarkers.syncSubLabels | **マップ**(受け手ゲート → route、引数削除) |
| 560 | navTarget.sync | 共通 |
| 561 | dynamicSystem.syncEquatorNodes | **マップ** |
| 563-568 | displayWindowManager.sync / frameControls.sync | **マップ**(既に呼び手ゲート) |
| 571 | mapActions.sync | 共通(戦闘のプロパティウィンドウ更新を含むため。内部の一覧パネル分岐は mapActions が view で持つ — 手順7) |
| 572 | editor.sync | 共通 |
| 575-579 | entityLines.sync / linePickables.refresh | 共通 / **マップ**(refresh の受け手ゲート → route) |
| 581-586 | touchControls.syncModeButtons | **戦闘** |
| 587 | activeStage.sync | 共通(view 引数、手順7) |
| 589-590 | hud.syncPanels / tick | 共通(パネル振り分けは Hud が持つ現行のまま) |
| 592 | guide.sync | 共通(editMode 引数は「ビュー」を Game から渡す形へ) |
| 594 | dockingGuide.sync | 共通(自分で viewManager を読む現行のまま) |
| 597 | markerManager.resolveCollisions | 共通(view 引数、手順7) |

新 API の署名(検査対象):

```ts
// game/world-view.ts(新規)— ビュー固有のフレーム処理の口。Game が各フェーズの固定位置で呼ぶ。
export interface WorldViewFrame {
  // ポーズ・入力ゲート判定の後に呼ばれる。ポインタ入力の配分。
  handlePointer(simTime: number): void;
  // update フェーズ: カメラ更新より前の選択候補づくり(赤道交点など)。
  update(displayWindow: DisplayWindow): void;
  // sync フェーズ前半: 天体ラベル(マーカー同期がラベルを読むため、その前)。
  syncLabels(): void;
  // sync フェーズ後半: ビュー専用のパネル・表示物。
  syncPanels(displayWindow: DisplayWindow): void;
}
// game/combat-view.ts / game/map-view.ts(新規)が実装。依存は ctor 注入。
// Game 側: private get activeView(): WorldViewFrame — ビュー分岐はここ1箇所。
```

受け手から消す引数ゲート(route 化で定数になるもの):

| ファイル | 変更 |
| --- | --- |
| src/game/targeter.ts | updateEquatorNodes / handleTargetSelectKey の overviewMode 引数と先頭 return を削除 |
| src/game/dynamic/dynamic-system.ts | updateBaseEquatorNodes の同引数削除 |
| src/game/marker/celestial-markers.ts | syncSubLabels の同引数削除 |
| src/game/pickable/map-context-actions.ts | handleCombatRightClick の同引数削除。handleMapRightClick 等5メソッドの `cameraSystem.overviewMode` ゲート削除(map route からしか呼ばれない) |
| src/game/pickable/line-pickables.ts | refresh のゲート削除 |
| src/game/pickable/map-pickables.ts | refresh のゲートを clear() として分離し、combat-view が呼ぶ |
| src/game/game.ts | 分類表どおりに移設・再配線 |
| src/game/combat-view.ts / map-view.ts / world-view.ts | (新規) |

**達成条件と検証** — `npm run typecheck`・`npm run test:game`。game.ts の per-frame 処理に
`isMapView` 分岐が activeView getter 以外 0件(達成目標4)。`npm run dev` で両ビューを往復し、
マーカー・ラベル・パネル・右クリック・計画編集が従来どおり(とくにラベル→マーカーの順序が
崩れると天体ラベルの間引きが1フレーム遅れて明滅する — それが出ないこと)。

### 手順7. 残る `overviewMode` を掃く

**目的** — route 化後も残る外観・方針選択の分岐を `view: WorldView` 引数へ置き換え、
`cameraSystem.overviewMode` getter を削除する(D8)。**挙動は変えない。**

対象の分類(現176出現のうち手順4-6で消える分を除いた約100出現・約30ファイル):

- **`view: WorldView` へ置換(外観・方針の選択)** — targeter.sync/syncTargetMarkers、
  entity-line-manager、plan-display、player/enemy/base/ammo-pickup/rcs-fuel-pickup の
  markerItem、player-markers、grouped-markers、lead-markers、marker-manager
  (set の遮蔽判定・resolveCollisions)、orbit-point-marker、nav-target、
  celestial-system(update/sync)、point-field-view、scale-grid-view、orbit-guide-lines、
  zero-velocity-lines、stars.celestialShellScale、ambient-source、stage/creative-stage、
  celestial-entity(point/star)、empty-space-pickable、map-commands。
- **読み先を viewManager へ変更(game 経由の HUD)** — orbit-panel、enemies-panel、
  map-scale-badge、vessel-panel(`game.cameraSystem.overviewMode` → `game.viewManager.isMapView`)。
- **削除** — camera-system の `get overviewMode`(内部は provider の view を直接使う)、
  map-pickables.perfCounts の mapMode(viewManager から取る)。
- **PlanEditor の `_editMode`/`setMapMode`** — ViewManager から provider(手順2と同じ
  クロージャ方式)で受け、setMapMode を消す。applyChrome の呼び出しも消える。
- **TouchControls.setMapMode** — `setWorldView(view: WorldView)` に改名(applyChrome 側も)。

機械的な一括置換なので、置換表を固めたうえでサブエージェントへ層別に配ってよい(/delegate)。

**達成条件と検証** — `grep -rn "overviewMode" src/` 0件・`grep -rn "setMapMode" src/` 0件
(達成目標1・2)。`npm run typecheck`・`npm run test:game`(celestial/render 系の署名にも
触るので `npm run test:render` も)。実機で両ビューのマーカー外観(敵の向きマーカー/HP
マーカー、距離ラベルの有無)が従来どおり。

### 手順8. 残骸整理と改名

**目的** — 統合後の名前と構成を実態に合わせる。**挙動は変えない。**

- `map-camera.ts` / `MapCamera` を統合カメラの名前(候補: `FocusCamera` / `focus-camera.ts`)へ
  改名(importer 約15ファイル)。`OVERVIEW_CAMERA_*` 定数の接頭辞も追随。
- game.ts / camera-system.ts の不要 import・不要メンバーを削る。
- コメントの一括点検(/comment-cleanup)と、作業範囲全体の規約点検(/refactor)。
  とくに「マップモードの」「広範囲視点」等、ビュー専用を前提にした既存コメントが
  統合後に嘘になっていないか。

**達成条件と検証** — `npm run typecheck`・`npm run test:game`。
`grep -rn "MapCamera\|ChaseCamera" src/` 0件(新名のみ)。/refactor・/comment-cleanup を通す。

## 見積り

規模は編集箇所数で出す(導出: grep 実測)。

| 手順 | 規模 | 導出 |
| --- | --- | --- |
| 1 | 1ファイル・1行 | ゲート1つ |
| 2 | 3ファイル・±30行 | ステート1・setter1・ctor 引数1・呼び出し2 |
| 3 | SPEC 3ファイル・正味 ~170行 | CONTROLS 現節 ~45行の差し替え(基準フレーム節含む) + MAP §2 ~15行 + §3 カメラ区画 ~25行 + GAME 1段落 + 未確定の案 |
| 4 | 7ファイル・+~220行 | 回転追従 API+列挙 ~70 + 合成層 ~50 + 数値統一/far ~15 + パネル改修 ~60 + save/検査 ~25 |
| 5 | 10ファイル・-240/+~150行 | chase 144 + combat-camera-system 95 の削除、CameraSystem +~70、save ±30、周辺 6ファイル×~5行 |
| 6 | 9ファイル(新規3)・移動 ~80行 + ゲート削除 8箇所 | 分類表の「マップ/戦闘」行の合計 |
| 7 | 約30ファイル・約100出現の置換 | 176出現 −(手順4-6で消える ~75) |
| 8 | 約15ファイル | MapCamera importer 数(grep 実測 12 + テスト0) |

検証コスト: typecheck はヒープ拡大が要る(OOM 対策の既知の癖)。実機確認は手順1・4・5・6 の
4回で、各回は上記チェックリストの操作のみ。

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 統合カメラでドラッグ・キー回転の符号を取り違える(2実装は +Z の意味が逆で、符号反転で画面上を揃えている) | 片ビューで操作が反転する | 手順4(マップ不変確認)・手順5(戦闘の同一挙動確認) |
| 姿勢追従の合成順・喪失時 null 落ち | [G] 切替や撃破の瞬間に視点がジャンプ | 手順4(マップの機体フォーカスで [G])・手順5([G]連打・撃破) |
| 素の機体 id を ReferenceFrames が回転源として受けられない | 機体フォーカスの「公転」が組めない(役割限定へ縮む) | 手順4 の冒頭で確認。縮んだら SPEC も直す(手順4に明記) |
| 回転ゾーンの共用 widget(カメラ区画/計画区画)の改修が計画区画へ漏れる | 計画区画の選択肢・表示が変わる | 手順4(計画区画の回転ゾーンが現行どおりであることを目視) |
| フォーカス由来の選択肢化で、旧セーブ・進行中の選択が黙って慣性系へ落ちるべき場面を取りこぼす | 無効な回転系で transformAt が例外/視点が飛ぶ | 手順4(旧セーブ読み込み・フォーカス切替の連打) |
| far/near の再定義 | 戦闘で恒星・遠方天体が消える / 近接で艦がクリップされる | 手順4(マップ最小ズームで恒星)・手順5(戦闘で恒星・艦近接) |
| 旧セーブ chase 形状の読み分け漏れ | ロード時例外・視点破壊 | 手順5(手順前セーブのロード) |
| フォーカス喪失方針の入れ違い(戦闘に fallToOrigin が残る) | 撃破時に視点が地球へ飛ぶ | 手順5(撃破確認) |
| sync 順序の制約崩し(ラベル→マーカー、cameraSystem.sync→以降の投影読み) | 天体ラベルの明滅・マーカー1フレーム遅れ | 手順6(ビュー往復の目視) |
| ViewManager 構築順と provider クロージャ | 起動時 TypeError | 手順2(起動) |
| mapPickables 非リフレッシュ時、戦闘のフォーカス候補にアプシスマーカー等が無い | 戦闘でそれらにフォーカスできない(仕様上の限定として SPEC に書く) | 手順3(SPEC)・手順5 |
| touch の setMapMode 改名漏れ・HUD の game.cameraSystem.overviewMode 読み残し | タッチ UI・パネル表示が切り替わらない | 手順7(grep 0件の確認) |
| viewBadge のフォーカス表示が戦闘で変わる(現在はマップカメラの focus を表示) | 表示差(改善だが変化) | 手順5(バッジ目視) |
| render-lab の撮影は非決定(±4 LSB) | 画像差分を根拠に誤判定 | 全手順(差分を根拠にする前に撮り直す) |
| typecheck の OOM | 検証が回らない | 全手順(ヒープ拡大して実行) |
