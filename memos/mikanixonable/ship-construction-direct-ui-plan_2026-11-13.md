# 船の建造 UI 直接操作化 計画書 — 作業灯・入口・素手に戻る配置・選択メニュー・回転ギズモ

作成日: 2026-11-13  
コードのスナップショット: `5ab9d889f`(本文の行番号はこの時点)  
作業ブランチ(予定): `feat/ship-construction-direct-ui`  
状態: 未着手(検査待ち)

---

## 目的

建造の機能は揃っているが、**手で触る道具としてはまだ直感的でない。** 次の5点を直す。

| # | 現状の問題 | 根拠 |
| --- | --- | --- |
| P1 | 建造中も照明は太陽と天体照・環境光だけで、太陽の当たらない側のモジュールが暗く沈み、部品どうしの関係が読めない | 光源列 `src/render/pipeline/render-pipeline.ts:127-134`、環境光の割合 0.03 `src/render/pipeline/lighting/ambient-source.ts:13` |
| P2 | 入口(ドックの左クリック・画面固定バッジ・`[B]`・プロパティウィンドウ)はどれも1操作だが、説明が無く、そういう経路があることが分からない | バッジ `src/game/hud/hud-root.ts:418-435`、ドック直クリック `src/game/view/combat-frame.ts:58-65` |
| P3 | 置いた後も同じ部品を手に持ち続けるので、置いたばかりの部品をクリックすると、選択されずにさらに置かれる | `src/game/ship/ship-construction.ts:406-411`(`releasesHand = held.kind === 'piece'`)、仕様 `DEVELOP/SPEC/GAME.md:312` |
| P4 | 選択中の操作(撤去・回転・付け替え・複製)は画面下の手元バーにだけあり、選んだ部品から視線を外さないと届かない。カタログは文字のカードで、部品の形が見えない | `src/game/hud/panels/ship-construction-hand.ts:95-144`、`src/game/hud/panels/ship-construction-catalog.ts:94-115` |
| P5 | 回転は `Q`/`E` かボタンだけで、どの軸まわりにどちらへ回るのかが 3D 上に出ない | `ship-construction.ts:472-491` |

修正後に期待する状態は KSP の組立棟に近い。

- 建造中は船体全体が作業灯で照らされ、影の側の部品も形と継ぎ目が読める。
- 建造ドックを持つ船を操作している間、艦のステータスパネルに目立つ「建造」ボタンと、何ができるかの1行説明が出る。
- サムネイル付きのタイルから部品をドラッグして候補へ落とすと置かれ、**手は空に戻る**。
- 素手で部品をクリックすると選ばれ、その部品の脇に操作メニュー、周囲に接続軸まわりの回転リング(矢印付き)が出る。
  リングをドラッグするか矢印を押すと 90° 刻みで回る。

### 仕様の更新(手順 1 で `docs(spec):` として単独 commit する文面)

**GAME.md 9.3**

- L303-305 の入口の項を次へ置き換える:
  > - 建造は、艦のステータスパネルの「建造」ボタンを押す、船体の建造ドックを直接クリック/タップする、ドックのプロパティ
  >   ウィンドウから選ぶ、`[B]` を押す、のいずれかで始められる。「建造」ボタンと `[B]` は、使用可能な建造ドックのうち
  >   画面上で最も手前にあるものから始める。
- L312 を次へ置き換える:
  > - カタログのモジュールを手に取り、空いている取り付け位置へ置く。置くと手は空になる。続けて置くときは、もう一度手に取る。
- L321(複製)の直後は変えない(複製・設計図も置くと手が空になる — 上の文が手に取ったもの全般に掛かる)。

**CONTROLS.md「建造中の操作」**

- L145-147 の左クリックの項を次へ置き換える:
  > - **左クリック / タップ**: 手に何か持っていれば、押した位置の取り付け候補へ置き、手を空にする。押した位置に候補が
  >   無ければ何もしない(手に持ったものは持ち続ける)。手に何も持っていなければ、押した位置の配置済みモジュールを選ぶ。
  >   何も無い場所を押すと選択を解く。
- 選択中のドラッグの項(L151-153)の前に次を足す:
  > - **回転リングのドラッグ / 矢印のクリック・タップ**: 選択中のモジュールの周囲に出る回転リングを掴んで回すと、
  >   離したときに、回した角度に最も近い 90° の倍数だけ接続軸まわりに回る。リングの矢印を押すと、矢印の向きへ 90° 回る。
  >   リングと矢印は、モジュールの上から始めるドラッグより優先する。
- キーの表の下の文(L176)は変えない。

**UI-DESIGN.md §8**

- 艦のステータス(L380-385)の「操作」区画の文の後ろに次を足す:
  > 操作対象の船体に使用可能な建造ドックがある間だけ、操作区画の先頭に「建造」ボタンを、他の単発操作より目立つ主操作
  > として置き、その下に「建造ドックから船体を組み替えられます」の1行説明を添える。
- 船体建造のカタログ(L389-390 相当)の「各カードは名称・寸法・質量・追加される主な能力を読める」を次へ置き換える:
  > 各カードはモジュールのサムネイル画像を持つタイルで、名称を常に、寸法・質量・追加される主な能力をタイルの中かホバーで
  > 読める。設計図のタイルは、根元のモジュールのサムネイルにモジュール数を添える。
- 手元バーの「モジュールを選んでいる間」(L395-396 相当)を次へ置き換える:
  > - モジュールを選んでいる間: 選んでいるものの名前と、操作は選んだモジュールの脇のメニューにあるという案内。
- 手元バーの項の後ろに次の項を足す:
  > - **選択メニュー**(3D の選んだモジュールの脇) — モジュールを選んでいる間だけ、そのモジュールの画面上の位置へ追従して
  >   出る。回転(−90°/+90°)・端の入れ替え・「付け替える」・「撤去」・「複製」・「設計図として保存」・「選択を解く」を持つ。
  >   画面の端からはみ出さないよう、画面内へ寄せて置く。モジュールが画面の外へ出たら、画面の縁へ寄せて残す。
- L453-454 の建造ボタン(画面固定バッジ)の項を削除する(入口は艦のステータスパネルへ一本化する)。

**RENDERING.md**

- 建造の項(L372-375 の後ろ)に次を足す:
  > - 建造中は、カメラに追従する作業灯が船体を照らし、太陽の当たらない側のモジュールも形と継ぎ目が読める。作業灯は影を
  >   落とさず、カメラから離れるほど弱まり、遠くの天体の見え方を変えない。建造を終えると消える。
  > - 建造中に選んだモジュールの周囲に、その接続軸を中心とする回転リングと、両回りの向きを示す矢印を描く。リングは
  >   船体に隠れても消さない。掴んで回している間は、回した角度と、離したときに適用される 90° の倍数を示す。
- 「描画品質設定」の照明の項(L170-177 付近)に次を足す:
  > - **建造の作業灯**: 建造中に船体を照らす作業灯を点けるかどうか。どの品質プリセットでも既定はオン。

**MARKERS.md** は変えない(選択中に接続ノードを出す規則は、選択メニュー・リングと共存させる)。

---

## 決めたこと

ユーザーが覆せる。覆したときに変わる手順を併記する。

| # | 決めたこと | 根拠 | 覆したら |
| --- | --- | --- | --- |
| K1 | 作業灯は**影を持たない**、カメラの右上後方に置いた球光源(既存の LTC 球光源の式を流用)とし、距離の逆二乗で減衰させる | 影マップ付きの光源は影パスの拡張が要り大掛かり。環境光・天体照が影無しで届く先例がある(`ambient-source.ts:41-46`、`planet-light-source.ts:102`)。逆二乗なら、カメラから遠い天体へはほぼ届かない | 影付きにするなら手順 4 が影パス(`src/render/pipeline/shadow/`)の拡張を含み、見積りが倍以上になる |
| K2 | 作業灯は描画品質設定でオフにできる(既定オン) | 見え方を大きく変える描画は設定で切れるようにする(rendering-workflow 2 節) | 設定を作らないなら手順 4 の `graphics-settings.ts` の変更が消える |
| K3 | 入口は艦のステータスパネルへ一本化し、**画面固定の建造バッジは削除する**。ドック直クリック・`[B]`・プロパティウィンドウは残す | 同じ操作の主ボタンを2か所に置かない。パネルなら説明文を添えられる | バッジを残すなら手順 3 の削除分と UI-DESIGN の削除文が消える |
| K4 | 置くと手は空になり、**何も選ばない**(置いたモジュールも選ばない)。付け替え(`piece`)・カタログ・複製・設計図の区別なく同じ | KSP と同じ。置いた直後のクリックで選択へ移れる | 「置いたモジュールを選ぶ」にするなら手順 2 で `placeAt` の後に `select` を足す |
| K5 | サムネイルは**ビルド時に事前生成した PNG**。render-lab に「モジュールのサムネイル」ケースを足し、実機の描画パイプラインで1モジュールずつ撮り、`src/assets/module-thumbnails/<modelId>.png` へ書き出す。設計図は根元モジュールの画像に数を添える | 実行時のオフスクリーン描画はゲームの単一レンダラ(`src/render/scene.ts:36`)と遅延照明パイプラインを別ターゲットへ回す仕組みが無い。Blender 描画は実機と材質が違う | 実行時生成にするなら手順 5 が `src/render/` の新装置になり、手順 6 の画像読み込みが非同期化する |
| K6 | 選択メニューは HUD の DOM(`hud.layers.marker` 配下、`src/game/plan/node-gizmo.ts` と同じ追従方式)。オーバーレイ管理には登録しない(使い捨てメニューではなく選択状態の表示) | `ContextMenu` は開いた位置に固定され追従しない(`src/game/hud/windows/context-menu.ts:130,230`) | コンテキストメニューにするなら選択時に1度開くだけになり、カメラを回すとずれる |
| K7 | 回転リングは **3D の折れ線(`markOverlay`)** で描き、ヒット判定はリングを画面へ投影した折れ線への画面距離で行う。矢印は `PlanGizmo3D` と同型の円錐メッシュ | 接続軸の向きは 3D でしか正しく表せない。閉じた線は端点を重ねた折れ線(`src/render/dynamic/ship/dock-snap-guide-view.ts:139-148` が先例)。見かけの大きさ一定化は `src/render/plan/plan-gizmo-3d.ts:115` が先例 | DOM/SVG にするなら手順 8 の render 側の新ファイルが消え、軸の傾きを楕円で近似することになる |
| K8 | リングのドラッグは**離したときに1回だけ** `reorient` を発行する(履歴1件)。回している間は角度とスナップ先の表示だけ | ドラッグ中に 90° ごとに発行すると履歴が回した段数ぶん積もる | 逐次適用にするなら手順 8 で `rotate` を跨ぐたびに呼び、履歴の結合が要る |
| K9 | 実装は SWE-2 のサブエージェント(`general-swe2`)へ手順単位で配り、本体は配分・レビュー・検証・commit だけを持つ | ユーザーの指示(トークン消費を抑える) | — |

---

## 達成目標

1. 建造中、`ship-backlit` 相当の逆光の配置で、太陽の当たらない側のモジュールの輪郭と継ぎ目が見える
   (render-lab の撮影 `construction-work-light` で、作業灯オフの撮影より影側の平均輝度が上がる)。建造を終えると作業灯の寄与が 0 になる。
2. 作業灯が描画品質設定でオフにでき、オフにすると建造中の絵が作業灯を足す前と一致する(render-lab:compare で封筒内)。
3. 建造ドックを持つ船を操作している戦闘ビューで、艦のステータスパネルに「建造」ボタンと説明文が出て、1回押すと建造に入る。
   ドックを持たない船では出ない。`#hud-construction-badge` が `src/` と `tools/` から 0 件。
4. カタログのモジュールを置いた直後、手持ちが `null` になり、同じ位置をクリックすると置いたモジュールが選ばれる(回帰テストで固定)。
5. カタログの全モジュール(`src/game/ship/ship-module-catalog.ts` の全 `modelId`)のタイルにサムネイル画像が出る。画像が欠けた `modelId` が 0 件(テストで固定)。
6. モジュールを選ぶと、その脇に選択メニューが出て、メニューの各ボタンが手元バーにあったものと同じ操作を行う。手元バーの選択中の状態にボタンが 0 個。
7. 選択中のモジュールの周囲に回転リングが出て、リングを 90° 以上回して離すと接続軸まわりに回り、矢印を押すと ±90° 回る。リングのドラッグがカメラ回転にもモジュールの掴みにも化けない。
8. `npm run typecheck`、`npm run test:game`、`npm run test:render`、`npm run check:boundaries`、建造スモーク
   (`npm run build` の後 `SMOKE_QUERY='?stage=creative' SMOKE_CREATIVE_PRESET=base SMOKE_CONSTRUCTION=1 npm run smoke:browser`)が通る。

---

## サブエージェントへの配り方

各手順の実装は `general-swe2` へ配る(`/delegate` `/delegate-devin`)。指示には毎回、担当ファイルの列挙と「その外を変えない」、
`DEVELOP/CODING-RULE.md`(置き場に触れるなら `DEVELOP/ARCHITECTURE.md` も)を読んでから書くこと、該当する `DEVELOP/SPEC/` の節、
UI なら `.claude/skills/ui-design/SKILL.md`、描画なら `.claude/skills/rendering-workflow/SKILL.md`、担当の検証コマンド、短い報告
(触ったファイル・判断箇所・残したもの)を含める。`DEVELOP/SPEC/` と `memos/` は書かせない。手順 1(仕様)は本体が書く。

**並行できる組**(担当ファイルが重ならない):

| 波 | 並行する手順 | 重ならない理由 |
| --- | --- | --- |
| A | 2・4・5 | 2 は `src/game/ship/ship-construction.ts`・建造テスト・`tools/browser-smoke.mjs`、4 は `src/render/`・`game-presentation.ts`・`tools/render-lab/{lab,ship-cases}.ts`、5 は `tools/render-lab/{thumbnail-cases,cases}.ts`・新規スクリプト・`src/assets/module-thumbnails/` |
| B | 3・6 | 3 は艦のステータスパネル・`hud-root.ts`・`hud.ts`・`game-presentation.ts`(4 の後)・`help-content.ts`・スモーク(2 の後)、6 はカタログ・パネル・スタイル・パネルモデル |
| C(Bの後) | 7 → 8(直列) | 7 が `ship-construction-panel.ts` を触るので 6 の後。7・8 ともに `ship-construction-view.ts`・`ship-construction.ts`・pointer 系を触るので互いに直列 |

受け取るたびに本体が `git diff --stat` で範囲外を見て、差分を読み、検証を通し直してから commit する。

---

## 手順

### 手順 1. 仕様を更新する

**目的**: 置いた後の手持ち・入口・選択メニュー・回転リング・作業灯は、いずれも書かれている挙動を変えるか新しく足す。コードより先に確定させる。

| ファイル | すること |
| --- | --- |
| `DEVELOP/SPEC/GAME.md` | 9.3 の入口(L303-305)と手持ち(L312)を「仕様の更新」の文面へ |
| `DEVELOP/SPEC/CONTROLS.md` | 建造中の左クリック(L145-147)、回転リングの項を追加 |
| `DEVELOP/SPEC/UI-DESIGN.md` | §8 艦のステータス・カタログ・手元バー・選択メニュー、建造ボタン(L453-454)の削除 |
| `DEVELOP/SPEC/RENDERING.md` | 作業灯・回転リング、描画品質設定の項目 |

**達成条件と検証**: `git diff --stat` が `DEVELOP/SPEC/` の4ファイルだけ。`grep -n "置いた後も同じモジュールを持ち続ける" DEVELOP/SPEC` が 0 件。
`grep -n "建造ボタン" DEVELOP/SPEC/UI-DESIGN.md` が 0 件。ユーザーに文面を示して合意を取ってから `docs(spec):` で単独 commit。

### 手順 2. 置いたら手を空にする(波 A)

**目的**: P3 を直す。置いた直後のクリックが選択へ流れるようにする。

| ファイル | すること |
| --- | --- |
| `src/game/ship/ship-construction.ts` | `placeAt`(L381)の L406-411: 置くことに成功したら手持ちの種類によらず `heldValue = null`・`heldBlueprintId = null`、選択も解く(K4)。L406 のコメントを新しい挙動に合わせる。置けなかった(拒否された)ときは持ち続ける |
| `tests/game/ship-construction.test.ts` | カタログ・複製・設計図の各手持ちで、置いた後 `held === null` かつ `selectedModuleId === null` になるテストを足す。拒否時は保持のテスト |
| `tests/game/ship-construction-pointer.test.ts` | 「手持ちでクリック → 置く → 同じ位置を次のフレームでクリック → そのモジュールが選ばれる」テストを足す(配置はコマンドキュー経由で同フレーム未適用 — `ship-construction.ts:906-921` — なので次のフレームで判定する) |
| `tools/browser-smoke.mjs` | `constructMaterialFromBaseDock`(L744-869): 2回目の設置の前にカードを手に取り直す。L791-802 の「手放す」ボタン押下は、手が既に空なので削除し、そのまま配置面をクリックして選択を確かめる |

**達成条件と検証**: `npm run typecheck`、`npm run test:game`。`grep -n "releasesHand" src/game/ship/ship-construction.ts` が 0 件。
建造スモークは手順 3 の後でまとめて通す(スモークは手順 3 も触るため)。

### 手順 3. 艦のステータスパネルへ建造の入口を移す(波 B、手順 2・4 の後)

**目的**: P2 を直す。ボタンと説明文で経路を見せ、同じ主操作の重複(バッジ)を消す(K3)。

| ファイル | すること |
| --- | --- |
| `src/game/hud/hud-root.ts` | `buildVesselStatusPanel`(L135-157)の操作区画(`[data-id=status-actions]` L156)の中に、建造の行(主操作の `Button` + 説明文 1 行)の器を足す。`buildChromeActions`(L418-435)から建造バッジを削除し、戻り値(L47, L507, L514)から `constructionBadge` を消す |
| `src/game/hud/panels/vessel-panel.ts` | 建造の行を `buildActionButtons`(L128-144)の流儀で組み、ViewModel の新フィールド(建造できるか + `startConstruction`)で表示を切り替える。ボタンに `data-id` を付ける(スモークのセレクタ用) |
| `src/game/hud/hud-panel-presenter.ts` | コンストラクタ(L51-65)へ `startConstruction` と `constructionActive: () => boolean` を受ける口を足し、`vesselViewModel`(L162-191)で「建造できるか」(`hasUsableConstructionDock(ship)` かつ `view === 'combat'`(`viewModels` の引数で判別)かつ `!constructionActive()`)を組む |
| `src/game/hud/hud.ts` | `constructionBadge`(L65, L87)・`syncConstructionBadge`(L138-140)・`onConstructionStart`(L68, L82, L148)を削除し、建造開始の口を ViewModel 経由へ |
| `src/game/game-presentation.ts` | L290 の `hud.onConstructionStart = …` と L416-419 のバッジ同期を削除し、`startConstructionNearest`(L284-289)と `() => this.shipConstruction.active` を `HudPanelPresenter`(L278-282)へ渡す。Bキーの `inputSource.startConstruction`(L292-297)は既に `startConstructionNearest` を指すので変えない |
| `src/game/hud/windows/help-content.ts` | L117 の建造開始の行の説明を「艦のステータスパネルの『建造』、ドックのクリック、`[B]`」へ |
| `src/game/hud/style/combat-panel-rows-style.ts` | `.panel-actions`(L47-48)に建造の行の規則を足す。主操作の見た目は既存の variant(`src/hud/widgets/button.ts:8`)から選び、新しい色をリテラルで書かない(CODING-RULE 1.12) |
| `tools/browser-smoke.mjs` | L752-756 のバッジ待ち・クリックを、艦のステータスパネルの建造ボタン(`data-id`)へ置き換える |

**達成条件と検証**: `npm run typecheck`、`npm run test:game`、`npm run check:boundaries`。`grep -rn "construction-badge\|syncConstructionBadge\|onConstructionStart" src tools` が 0 件。
`npm run build` の後に建造スモークが通る。`npm run dev` の `?stage=creative` で、基地を操作中に右レールの艦のステータスへボタンと説明文が出て、
押すと建造に入ること、ドックの無い船へ切り替えると消えることを目で見る。

### 手順 4. 建造の作業灯(波 A)

**目的**: P1 を直す。建造中だけ点く影無しの球光源を光源列へ足す(K1・K2)。

| ファイル | すること |
| --- | --- |
| `src/render/pipeline/lighting/work-light-source.ts`(新規) | `LightSource` を実装。拡散は `sphereIrradianceFactor`(`sphere-light.ts:15-33`)、鏡面は `SphereSpecular`(`sphere-light.ts:41-50`)。位置・半径・強さは uniform で、`set(position, intensity)` と `hasContribution()`(強さ > 0)を持つ。影は掛けない。`PlanetLightSlot.contribution`(`planet-light-source.ts:160-191`)を手本にする |
| `src/render/pipeline/render-pipeline.ts` | `_ambient`/`ambient`(L55, L103)と同型のフィールドと getter を足し、光源列(L132-134)へ加える |
| `src/render/graphics-settings.ts` | `GRAPHICS_OPTIONS`(L48-220)の照明の組(ambient の項 L185-188 の隣)へ「建造の作業灯」トグルを足す。全プリセットで既定オン |
| `src/game/game-presentation.ts` | 表示の同期(L461-484。`sunLight`/`bodyShadow` を渡しているところ)で、`shipConstruction.active` かつ設定オンのとき、カメラの右上後方(視線方向・上方向から作るカメラ基準のオフセット、距離は建造の視点寄せ距離 `max(12, r×2.5)` — `src/game/camera/camera-system.ts:127-132` — に比例)へ作業灯を置き、それ以外は強さ 0。このメソッドは `graphics: GraphicsSettingsData` を既に引数に持つ(L461)ので、設定の読み取りはここで行う(`celestial-illumination.ts:95` の `ambientFraction` と同じ扱い) |
| `tools/render-lab/lab.ts` | L320-331 付近で作業灯を駆動する(ケースが要求したときだけ点ける) |
| `tools/render-lab/ship-cases.ts` | 逆光の艦艇ケースへ撮影 `construction-work-light`(作業灯オン)と `construction-work-light-off` を足す |

**達成条件と検証**: `npm run typecheck`、`npm run test:render`、`npm run check:boundaries`。rendering-workflow 4 節に従い、撮影を足した後・光源を足す前のコードで
before を2組(`npm run render-lab:shot -- wl-before1`、`wl-before2`)、実装後に after を撮り、
`npm run render-lab:compare -- .render-lab-shots/wl-after .render-lab-shots/wl-before1 .render-lab-shots/wl-before2` で、
`construction-work-light` だけが封筒外になり、他の撮影(`construction-work-light-off` を含む)が封筒内であること。差分画像で影側が明るくなったことを目で見る。
デバッグ情報ウィンドウの照明パスの GPU 時間を、建造中と建造外で読む。

### 手順 5. モジュールのサムネイルを生成する(波 A)

**目的**: P4 のうちタイル化の材料を作る(K5)。この時点でゲームの挙動は変えない。

| ファイル | すること |
| --- | --- |
| `tools/render-lab/thumbnail-cases.ts`(新規) | カタログの各 `modelId` を1つずつ `buildShipModuleModel`(`src/render/dynamic/ship/ship-module-models.ts:79-93`)で置き、正方形・透過背景・固定の斜め視点・固定照明で撮る撮影の組。実機のコードを import し、lab 側に別実装を作らない |
| `tools/render-lab/cases.ts` | L13 付近へケースを登録 |
| `tools/export-module-thumbnails.mjs`(新規) | `tools/render-lab-shot.mjs` の撮影を使ってサムネイルの組だけを撮り、128×128 の PNG として `src/assets/module-thumbnails/<modelId>.png` へ書く |
| `package.json` | `export-module-thumbnails` スクリプトを足す |
| `src/assets/module-thumbnails/*.png`(新規・生成物) | 生成して commit |
| `AGENTS.md` のコマンド表 | 「モジュールの見た目を変えたときだけ」走らせる行を足す |

**達成条件と検証**: `npm run typecheck`。`ls src/assets/module-thumbnails | wc -l` がカタログの `modelId` の数と一致。画像を数枚開き、モジュールが中央に写り背景が透けていることを目で見る。

### 手順 6. カタログをサムネイル付きタイルにする(波 B、手順 5 の後)

**目的**: P4 のうちカタログを直す。この手順で操作の流れ(押す/ドラッグで手に取る)は変えない。

| ファイル | すること |
| --- | --- |
| `src/game/hud/panels/ship-construction-catalog.ts` | カード(L94-115)をタイル(画像 + 名称、寸法・質量・能力は `title` と既存の副行)へ。設計図(L149-195)は根元モジュールの画像 + モジュール数。ドラッグ(`wireCardDrag` L201-282)はそのまま |
| `src/game/ship/ship-construction-types.ts` / `ship-construction-panel-model.ts` | カードの表示語彙(`ShipBlueprintCardView` L92-99 など)へ画像の `modelId` を足す。設計図は根元モジュールの `modelId` |
| `src/game/hud/panels/ship-module-thumbnails.ts`(新規) | `modelId` → 画像 URL の表(`src/assets/module-thumbnails/*.png` の import、`src/types/png-shims.d.ts` の前例) |
| `src/game/hud/style/ship-construction-style.ts` | 縦1列(L42-45)を複数列のタイルグリッドへ。寸法はトークンから |
| `tests/game/`(新規テスト) | カタログの全 `modelId` に画像があることを固定 |

**達成条件と検証**: `npm run typecheck`、`npm run test:game`。`npm run dev` の建造で、幅 1280 px と 600 px の両方でタイルが並び、画像が出て、
タイルの押下とドラッグで手に取れることを目で見る。建造スモークが通る(カードのセレクタ `.construction-module-card` を変えたならスモークも直す)。

### 手順 7. 選択メニューを選んだモジュールの脇に出す(波 C)

**目的**: P4 のうち選択中の操作を直す。手元バーの選択中のボタンを、3D 追従の選択メニューへ移す(K6)。

| ファイル | すること |
| --- | --- |
| `src/game/hud/panels/ship-construction-selection-menu.ts`(新規) | `hud.layers.marker` 配下の DOM。`node-gizmo.ts` の `sync(specs)`(L147)と同じく毎フレーム画面座標で置き直す。ボタンは `Button`(キーキャップ付き)、`ship-construction-hand.ts` L61-84 の選択中のボタン群をここへ移す。画面内へ寄せる処理を持つ。`pointerdown` を止めて、船体側のクリック・カメラへ流さない |
| `src/game/hud/panels/ship-construction-hand.ts` | 選択中の状態(L95-144 の該当分岐)のボタンを削除し、名前と案内だけにする |
| `src/game/hud/panels/ship-construction-panel.ts` | メニューを組み、`ShipConstructionPanelPort`(`ship-construction.ts:75-102`)の既存の `on*` へ中継(L142-153 と同じ口) |
| `src/game/ship/ship-construction-view.ts` | 選択中モジュールの画面位置(`eciOfAssembly` L107 → `camera.project`)をメニューへ渡す |
| `src/game/ship/ship-construction.ts` | 「付け替える」= 選択中の先端部を `{ kind: 'piece' }` として手に取る口(`tryGrab` の `hold` と同じ)を公開する。他の操作は既存のメソッド(`rotate` L472、`swapEnds` L497、`removeSelected` L437、`duplicateSelected` L535)を呼ぶだけ |
| `tests/game/` | 「付け替える」で手持ちが `piece` になり、候補で置くと付け替わって手が空になるテスト |
| `tools/browser-smoke.mjs` | 選択後の操作を手元バーではなく選択メニューのボタンで行うよう直す |

**達成条件と検証**: `npm run typecheck`、`npm run test:game`、建造スモーク。`npm run dev` で、モジュールを選ぶと脇にメニューが出て、カメラを回すと追従し、
画面端のモジュールでもメニューが画面内に収まること、メニューのボタンを押しても選択が解けず船体がクリックされないことを目で見る。タッチ(開発者ツールのタッチ模擬)で
各ボタンがタップできること。

### 手順 8. 回転リング(波 C、手順 7 の後)

**目的**: P5 を直す。選択中のモジュールの接続軸まわりに 3D のリングと矢印を出し、ドラッグと押下で 90° 刻みに回す(K7・K8)。

| ファイル | すること |
| --- | --- |
| `src/render/dynamic/ship/construction-rotate-gizmo-view.ts`(新規) | 単位円の折れ線(端点を重ねる。`dock-snap-guide-view.ts:139-148`)と両回りの円錐の矢印(`plan-gizmo-3d.ts:47-83`)を `markOverlay` で描く。見かけの大きさ一定化(`plan-gizmo-3d.ts:115`)。宣言 `{ center, axis, radius, highlight, dragAngle }` を受けるだけの装置にする |
| `src/game/ship/ship-construction-gizmo.ts`(新規) | 選択中モジュールの接続軸の算出(根元接続 `pieceOfModule(...).rootConnection` — `src/game/ship/ship-assembly-graft.ts:45-66` — から、軸方向接続は親の local ±Z、側面接続は `sideSlotDirection` — `ship-assembly-transform.ts:126` — を持ち主の回転で回す)、リングの画面投影と画面距離のヒット判定(半径は `pickRadiusSq` — `src/input/pointer-precision.ts:9`)、ドラッグ角の累積(投影した中心まわりの画面角、接続軸が視線側を向くかで符号を反転)と 90° スナップ |
| `src/game/ship/ship-construction-pointer.ts` | `interpretPointer`(L125)の `takePresses(tryGrab)`(L130)より前に、リング/矢印への押下を奪う分岐を足す。リングは掴みドラッグ(`grabbedPressId` と同じ機構)、矢印は押下即 ±90°。離したら `rotate` を1回(スナップ段数ぶんの向きで `reorient` 1回)呼ぶ |
| `src/game/ship/ship-construction.ts` | `rotate(delta)`(L472)を段数 −3〜+3 で1回の `reorient` を発行できるようにする(現行は ±1 前提で `% 4` 済みなので、呼び出し側の段数を受けるだけ) |
| `src/game/ship/ship-construction-view.ts` | 選択中かつ `canEditModule`(L714)のときだけギズモの宣言を出す。手持ち中・カードのドラッグ中は出さない |
| `tests/game/` | 接続軸の算出(軸方向・側面の両方)、ドラッグ角 → 段数のスナップ(44° → 0、46° → 1、−135° → −1 or −2 の境界)、リング上の押下が `tryGrab` とカメラへ流れないこと |
| `tests/render/` | ギズモ装置が宣言を受けて頂点バッファを書き換えること(属性の差し替えでなく確保済みバッファへの書き込み) |

**達成条件と検証**: `npm run typecheck`、`npm run test:game`、`npm run test:render`、`npm run check:boundaries`。
`npm run dev` で、軸方向に付いたモジュールと側面に付いたモジュールの両方を選び、リングが接続軸を中心に描かれ、ドラッグで回すと角度の表示が出て、
離すと 90° 単位で回ること、取り消しで1回分だけ戻ること、リングの外からのドラッグはカメラ回転のままであることを目で見る。

### 手順 9. 仕上げ

**目的**: 規約からの逸脱とコメントを点検し、全体の検証を通す。挙動は変えない。

| ファイル | すること |
| --- | --- |
| 手順 2-8 で触ったファイル | `/refactor`、`/comment-cleanup` |
| `src/game/hud/windows/help-content.ts` | 建造中の操作の表(L130-203)へ、回転リングと選択メニューの行を足す |

**達成条件と検証**: 達成目標 1-8 を1つずつ当てる。`npm run lint`(触ったファイル)。

---

## 見積り

実行時の負荷。

| 手順 | 増える処理 | 導出 |
| --- | --- | --- |
| 4 | 建造中だけ、照明プリパスにフルスクリーンの加算パスが 1 枚 | 光源1つ = フルスクリーン1枚(`light-prepass.ts:61-69`)。式は天体照1スロットと同じ球光源の拡散 + LTC 鏡面なので、デバッグ情報ウィンドウの照明パスの GPU 時間が、天体照1スロット分だけ増えるのが上限。建造外は `hasContribution()` が偽で描画命令 0 |
| 5 | 実行時は画像の読み込みだけ | 128×128 PNG 約 10〜20 KB × カタログのモデル数(約 20)= 約 200〜400 KB。カタログを開いたときに読む |
| 7 | 毎フレーム、選択中モジュール1つの画面投影と DOM の位置書き込み | 投影1回 + `style.transform` 1回。接続ノードの投影(取り付け先 T 個)より小さい |
| 8 | リングの頂点更新と、押下時の投影 | リング N=64 頂点 + 矢印2つの変換を選択中だけ毎フレーム。ヒット判定は押下のフレームだけ 64 点の投影と線分距離 64 回 |

作業量(着手時の行数から)。

| 手順 | 触る既存ファイルの行数 | 見込み |
| --- | --- | --- |
| 2 | `ship-construction.ts` 990 | 変更は L406-411 の数行。テスト追加が主 |
| 3 | `hud-root.ts`・`vessel-panel.ts`・`hud.ts`・`hud-panel-presenter.ts` | バッジ関連の削除 約 25 行、建造の行の追加 約 40 行 |
| 4 | 新規 1 ファイル(`planet-light-source.ts` の1スロット分 L160-191 と同程度、約 80 行)+ 配線 約 30 行 |
| 7 | `ship-construction-hand.ts` の選択中分岐が新ファイルへ移る | 新規 約 150 行(`node-gizmo.ts` の追従部分と同程度)、手元バーは減る |
| 8 | 新規 2 ファイル | 描画装置 約 120 行(`dock-snap-guide-view.ts` + 矢印)、ギズモの計算 約 150 行 |

---

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 作業灯が全ての照らされる面へ届く(照明プリパスは物体を選べない)ため、カメラ近くの他の船・破片・地表も照らす | 建造中だけ周囲の物体が不自然に明るい | 手順 4。逆二乗の減衰距離を船体半径基準にし、render-lab の撮影で船体以外の明るさを差分画像で確かめる |
| 作業灯の位置をフローティング原点の座標系で取り違える(ECI と描画座標) | 光源が遠くへ飛んで寄与が 0 に見える | 手順 4。`construction-work-light` が `-off` と差分を持つこと(封筒外であること)で露見する |
| uniform でなく光源のマテリアルを毎フレーム作り直す | GPU 資源のリーク・カクつき | 手順 4。`material()` は遅延生成して使い回す(`ambient-source.ts` と同じ)ことをレビューで当てる |
| 描画品質設定の項目を足すと、保存済みの設定を読み込んだときに新項目が未定義になる | 作業灯が既定オンにならない | 手順 4。設定の保存値は表から導出される(`graphics-settings.ts:226-253`)ので、既存の保存値を読んだ後の値を `npm run test:render` のテストで固定する |
| 手持ちを空にすると、対称配置で複数の候補へ置いた後に対称数の表示が手元バーから消える | 次に手に取ったとき対称数が残っているか分からない | 手順 2。対称数は手持ちとは別の状態(`ship-construction.ts` の `symmetry`)なので保持されることをテストで固定し、手元バーで手に取った時点に表示されることを確かめる |
| 置いた直後のクリックが、コマンドキュー未適用の旧形状へレイキャストする | 置いたばかりのモジュールを同じフレームで押すと、選ばれず空白扱いで選択が解ける | 手順 2。次のフレーム以降で選べることをテストで固定する。同フレームの二重クリックは対象外 |
| バッジの削除で、艦のステータスパネルを畳んでいる・タッチで右レールが閉じていると入口が見えなくなる | 入口を見失う(P2 の再発) | 手順 3。パネルが畳まれている間の見え方を目で確かめる。見えないならパネルの見出しに建造の印を出すことを検討し、ユーザーに問う |
| サムネイル撮影のヘッドレス描画が不安定で、黒い画像や読み込み前の姿が撮られる | タイルに黒い四角が出る | 手順 5。ケースに `ready` を持たせて GLB の読み込みを待つ。生成後に全画像の平均輝度が 0 でないことをスクリプトで確かめる |
| `export-assets` で識別子が振り直されるのと同様、撮影の揺らぎで PNG が毎回差分になる | 無意味な差分の commit | 手順 5。モジュールの見た目を変えたときだけ走らせる運用を AGENTS.md に書く |
| 選択メニューの `pointerdown` が `Input` へ流れる | メニューを押すと船体のクリック扱いになり選択が解ける/カメラが回る | 手順 7。`node-gizmo.ts` と同じく伝播を止める。スモークでメニューのボタン押下後も選択が残ることを確かめる |
| 選択メニューと接続ノード(選択中にも出る — MARKERS.md)が重なる | ノードを押せない | 手順 7。メニューはモジュールの画面上の外接矩形の外側へ置き、ノードの多い側を避けない場合は目で確かめて位置規則を決める |
| リングのヒット判定がモジュール上の掴み(`tryGrab`)より先に走るため、リングの内側(モジュール本体)の押下まで奪う | 付け替えのドラッグができない | 手順 8。判定は投影したリングの線への距離だけ(内側は奪わない)にし、テストで固定する |
| 接続軸が視線とほぼ平行/垂直のとき、画面上のリングが潰れて角度が取れない | 視線と垂直な軸ではリングが線になり回せない | 手順 8。視線と軸の角度が浅いときは矢印の押下だけを受け、ドラッグは受けないことを決め、目で確かめる |
| 側面接続の `sideReversed`(`ship-construction-edits.ts:134`)を見落とし、軸の向きが逆になる | 矢印の向きと実際の回転方向が逆 | 手順 8。側面接続の向きをテストで固定し、`dev` で矢印の向きと回転方向が一致することを目で見る |
| 起点ドック・接舷の継ぎ目の先(`canEditModule` が偽)にリングとメニューの回転を出す | 押しても拒否される操作が見える | 手順 7・8。`canEditModule` が偽ならリングを出さず、メニューの該当ボタンを理由付きで無効にする |
| 手順 7 と 8 を同じ commit に混ぜる/並行して配る | 同じファイルで競合し、原因を切り分けられない | 全手順。波 C は直列、1手順1commit |
