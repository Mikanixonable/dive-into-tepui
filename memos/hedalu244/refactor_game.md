# game.ts のリファクタリング

目標は3つ。**モジュール疎結合・`game.ts` からのロジック排除・可読性。**

---

## 0. 判断の原則

**下位が自決できるようにフラグを持たせ、呼び出しガード不要で呼べるようにする。**
ただし**下位が責務外のことまで気にしてガードするのは責務分割の失敗**なので、それが避けがたい
ときだけ `Game` に残す。残すなら理由を言えること。

`if`(三項・`??`・`&&` を含む)は3種類に分けて扱う。

### (a) 判断の合成 — 無条件で移す

複数モジュールの値を組み合わせて**新しい判断を作っている**もの、および**他モジュールが読む値を
組み立てている**もの。`/refactor-fixed` 1節に真正面から反する。

### (b) 単純な呼び出し可否 — 受け手へ寄せる

フラグを1つ読んで呼ぶ/呼ばないを決めるだけのもの。**受け手が判定に要る値を毎フレーム引数で
受け取れるなら、受け手の先頭で早期 return させる**(`/refactor-fixed` 21bis)。
受け手が参照ごと持つのは、**フレームの流れの外**(DOM イベント)で使う場合だけ
(`/refactor-fixed` 7節) — 保持させると層の逆転(simulation → camera など)を招く。

### (c) 決着(`isPlaying`)による分岐は、まず存在意義を疑う

`/refactor-fixed` 21節のとおり、**一般形は「自機0..n隻・勝敗なし」で、攻略ステージのほうが
その特殊化**。決着後という極めて特殊な場面のためだけに立っている分岐は、移す前に消せないか見る。
性能目的の簡略化なら特に疑う — 軽くすべきなのは高ワープ中・戦闘中であって、決着後はボトルネック
ではない。

---

## 1. ユーザー判断待ち

### 1-1. 決着後に自機を動かせるべきか

`isPlaying` が実際に効いているのは「**決着したが自機は生存している**」場面だけ
(喪失した自機は同一フレーム末に `reclaimDead()` で除去されるので、死亡を理由にこのゲートが
効くことはない)。つまり勝利後(stage1/2 の全滅)と stage0 の timeup のみ。
CREATIVE は `checkWin()` が常に false なので無関係。

**次の3件は連動するので一緒に決める。**

| 箇所 | 効果 |
|---|---|
| `advanceSimulation` の `player.behave` ゲート | 決着後に操縦・射撃できるか |
| `syncPlayers(..., isPlaying, ...)` → `RcsEffects.sync` の `phasePlaying` | 決着後に RCS 噴射煙と RCS 音が出るか |
| `handlePointerInput` の `if (!isPlaying) return` | 決着後にポインタ操作を配るか |

論点:

- 0節(c)の基準では消す方向。ただし**消すなら3件同時**でないと、「トルクは効くが噴射煙と音が
  出ない」という中途半端な状態になる。
- 消した場合の見え方: 結果画面(`#hud-end`、`system` レイヤの全画面オーバーレイ)が出たまま
  背後で操縦できる。各具象 `Stage.update` は自分で `if (!this.isPlaying || !player) return;` を
  持つので敵は行動せず、stage0 の timeup では「自機だけ動けて敵は止まる」非対称が見える。
  対称にするには具象ステージ側の自決ガードも同時に見直すことになる。
- ポインタの件だけは先に実機確認できる: 結果画面は `pointer-events` を受ける全画面要素なので、
  **そもそもクリックがキャンバス(`Input` の購読先)へ届いていない可能性が高い。**
  届かないならこのガードは実効ゼロなので、他2件と切り離して即削除できる。

### 1-2. `phaseOffsets` は空オブジェクトを往復しているだけ(コメントが実装と矛盾)

`ephemeris.ts` のコメントは「既定は月のみ乱数で」と書いているが、**現在の既定値は `{}` で、
`ephemeris.ts` に乱数は1つも無い。** 本番コードでこのフィールドに値を入れる経路は存在せず
(唯一の書き手は `Game` の `initialSave?.phaseOffsets ?? {}`、唯一の読み手は
`getPhaseOffsets()` → `SnapshotService`)、**セーブが往復させているのは常に `{}`。**
値を渡しているのはテストだけ。

`EarthBody.spinPhase0`(`earthSpinPhase0`)のほうは実際に乱数で、セーブ往復にも意味がある。
つまり**似た形の2つのうち片方だけが空回りしている。**

判断が要る: 月の初期位相の乱数化を戻すのか、`phaseOffsets` の往復配線ごと畳むのか。
どちらにせよ**`ephemeris.ts` の嘘のコメントは即座に直す**。

### 1-3. `DisplayWindowManager.resolve` が1フレームに3回

`update` 冒頭・`advanceSimulation` の積分後・`sync` 冒頭の3箇所で `resolve(simTime, player)` を
呼び、`Game` が「いつ確定させるか」を決めている。クラス側は
`(simTime, player, player.state の同一性, revision)` でキャッシュしているので、
**`Simulator` と `ActivePlayerController` の参照を持てば `current` を遅延ゲッターにでき、
3つの `resolve` 呼び出しは丸ごと消える。**

ただし CLAUDE.md は「参照を持たず引数で受け取る」ことを意図的な設計として明記している。
参照2つはどちらも既に他モジュール(`PlanEditor` など)が持っているものなので、
層の逆転にはならない。

---

## 2. 未着手(判断待ちに依存しないもの)

### 2-1. `Ephemeris` の組み立てが `Game` にある(+ `main.ts` と述語が二重)

現状、`Game` のコンストラクタが3つの出所を合成している:

```ts
const ephemerisConfig = stageClass.ephemerisConfig;          // ステージの静的宣言
const phaseOffsets = initialSave?.phaseOffsets ?? {};        // セーブ
this._ephemeris = ephemerisConfig === undefined
  ? new Ephemeris(undefined, undefined, SIM_EPOCH_ET, phaseOffsets, absoluteEphemeris, SIM_EPOCH_JD_TDB)
  : new Ephemeris(ephemerisConfig.registry, ephemerisConfig.originId,
                  ephemerisConfig.epochOffsetSec, phaseOffsets);
```

問題は3つ。

1. **述語が2箇所にある。** `main.ts` も `stageClass.ephemerisConfig === undefined` を評価している
   (外部暦パックを `await` で読むか決めるため)。「このステージは現実の太陽系で遊ぶのか」という
   同じ問いに、2つのファイルが別々に答えている。
2. **`Game` が状態を組み立てている**(0節(a)に該当)。`undefined, undefined` の位置合わせ引数まで
   `Game` が知っている。
3. **`Ephemeris` だけが「起動時に確定して以後変わらない資源」なのに `Game` 生成扱い**になっている。
   `Hud` / `Sfx` / `SettingsPanel` / `FrameSections` / `UnlockManager` / `StageClass` / `initialSave` は
   すべて `main.ts` が確定させて参照で渡す形なのに、暦だけ違う。

**提案: 起動時の暦を1つの関数へまとめ、`Game` は完成した `Ephemeris` を受け取るだけにする。**

```ts
// 新規モジュール(仮): src/game/launch-ephemeris.ts
export async function ephemerisFor(
  stageClass: StageClass, phaseOffsets: Partial<Record<AttractorId, number>>,
): Promise<Ephemeris>
```

- 中で `ephemerisConfig` の有無を1度だけ判定し、無ければ `profileAt(SIM_EPOCH_JD_TDB)` →
  `await loadAbsoluteEphemeris(...)` → `new Ephemeris(..., SIM_EPOCH_ET, ..., pack, SIM_EPOCH_JD_TDB)`、
  有ればその宣言から同期的に組む。
- `Game` のコンストラクタ引数は `absoluteEphemeris?: AbsoluteEphemeris` → `ephemeris: Ephemeris`。
  `game.ts` から `SIM_EPOCH_*` / `AbsoluteEphemeris` の import が消え、分岐も消える。
- `main.ts` は `initialSave` の解決を暦の構築より前へ動かし(どちらも `stageClass` しか要らないので
  順序は自由)、`showLoading()` は `await` を無条件で囲む — 同期経路は**マイクロタスク境界しか
  跨がず描画されない**ので、点滅は起きない。これで `main.ts` からも分岐が消える。
- `stage-dictionary.ts` には置かない(あそこは一覧と id 引きだけ)。

置き場所と関数名は実装時に確定させる。`/refactor-fixed` 10節の語法では暦を答えるものは
`ephemeris` 族なので `ephemerisFor` が素直。

### 2-2. 下位へ寄せられるもの

| 箇所 | 移し先と方法 | 依存 |
|---|---|---|
| `sync` の `overviewMode ? mapPicker.visibilityPolicy : null` | `MapPicker.refresh` は `!overviewMode` で早期 return するが、`_visibilityPolicy` を**前フレームの値のまま残す**。return の前に `null` を代入すれば、`Game` は `mapPicker.visibilityPolicy` を素通しできる | なし |
| `render` の `if (viewManager.current === 'dock')` | `Game` が `ViewId` のリテラルと比較しているのが判断。`ViewManager` に `rendersWorld: boolean` を持たせて `if (!viewManager.rendersWorld) return;` にする | なし |
| `advanceSimulation` の `if (player) player.plan.trackAnchor(player.state)` | 直前の `guide.update(player, ...)` は既に `Player \| null` を受けて自決している。「毎フレーム計画を飛行中の艦に追随させる」は `PlanGuide` の責務そのものなので、`trackAnchor` をその中の末尾へ移す。`if` と「trackAnchor より前に置く」という順序コメントの両方が消え、順序が内部で保証される | なし |
| `handleInput` の `simSpeedManager.handleInput(input, isPlaying, editMode, plan?.firstNode(), simTime)` | 引数4つの中継。`[N]`(次ノードへ自動ワープ)は計画編集の操作で、`PlanEditor` は `simSpeedManager` も `plan` も `editMode` も既に持っている。`PlanEditor.handleInput` へ移せば `simSpeedManager.handleInput(input)` は `,`/`.` だけになる | なし |
| `handlePointerInput` の `if (editor.editMode)` / `else` | 各受け手(`MapPicker` の4メソッド・`PlanEditor.handleMapPointer`・`NavTarget.updateCombatBasePicking`・`Targeter.updateCombatTargeting`)が `overviewMode` を毎フレーム引数で受けて自決。`if/else` が消え、呼ぶ順序だけが残る。**`MapPicker` だけは `game` 経由で自力到達できてしまうが、それは使わない(2-3)** | 1-1 の判断 |

### 2-3. `MapPicker` と `Docking` が `Game` そのものを保持している — 逆流

`src/game/` 配下で `Game` 型を import しているのは `map-picker.ts` / `docking.ts` /
`hud/panel.ts` の3つ。このうち `HudPanels` は `/refactor-fixed` 12節が明示的に許した例外
(条件は「**全情報を集約表示することそのものに価値があり、表示専用であること**」)。
残る2つは条件を満たしていない。

- **`MapPicker`** … `game` 経由で `frameControls` / `player` / `activePlayers` / `activeStage` /
  `cameraSystem` / `simTime` の6つへ到達(21箇所)。`activePlayers.set/remove` も
  `frameControls.setFocus` も `authoring.openShipPlacer` も呼ぶので**表示専用ではない**。
  しかも `cameraSystem` は**コンストラクタ引数として直接も保持している**のに、
  配置UIを開く箇所だけ `this.game.cameraSystem` 経由で読んでおり、同じものへの経路が2つある。
- **`Docking`** … `game` 経由で `pause()` / `resume()` / `isPaused` / `player` /
  `activePlayers` / `activeStage` へ到達。**このうち `pause`/`resume`/`isPaused` だけは正当** —
  それらは `/refactor-fixed` 1節が `Game` に置くことを認めた `Game` 自身の状態なので、
  到達するには `Game` を持つしかない。残り3つは直接参照にできる。

この逆流があるせいで「ガードを `MapPicker` へ寄せる」が技術的には常に可能に見えてしまうが、
それは**逆流を深めるだけで疎結合にはならない**。2-2 のポインタ配分も、`game` 経由ではなく
毎フレーム引数で受ける形にする。**2-2 のポインタ配分より先に着手するのが望ましい。**

**提案: `game: Game` を、実際に使っている参照へ分解する。**
`player` は `activePlayers.current`、`simTime` は既に引数で受け取っている
`displayWindow.simTime` / `sync(simTime, ...)` から引ける。`MapPicker` は `game` を丸ごと落とせ、
`Docking` は `pause`/`resume`/`isPaused` のためだけに残る(**それが正当な唯一の理由**であることを
コメントに書く)。`game.ts` の行数は減らないが、**`Game` を「ほぼ誰も参照しないオーケストレータ」に
保つ**ための残作業。

---

## 3. `Game` に残すもの(理由を言えること)

| 箇所 | 理由 |
|---|---|
| `_isPaused` / `pause()` / `resume()` / `if (!_isPaused) advanceSimulation(dt)` | `/refactor-fixed` 1節が明示的に許した例外。ポーズを `SimSpeedManager` の `simSpeed = 0` へ寄せるのは筋が悪い(`SIM_SPEED_LEVELS` は離散段で 0 を表現できず、ポーズと相互作用の閾値は別の関心事 — 8節) |
| `_isPaused && hud.modalController.isOpen` | `Game` 所有の `_isPaused` と `Hud` 所有の `isOpen` を跨ぐ単純な AND。**ただし論点あり**: 全画面のモーダルが自分でポインタを消費すれば、この AND 自体が要らなくなる。ポーズ経路は「設定パネル/一覧を開いた(=モーダル)」か「ドック」しかないので、両者の実効差を確認する価値はある |
| `syncPlayers(..., _isPaused, ...)` | `EntityManager` → `Player.syncPlayer` → `RcsEffects.sync` への分岐なしの中継。`pause()` が畳むのはアクティブ艦の `torque` だけで、パッシブ艦は `advanceSimulation` ごと飛ぶため古い `torque` が残りうる |
| `Predictor.update(..., overviewMode ? 'map' : 'combat')` | `Predictor` は simulation 層。`CameraSystem` を持たせると層の逆転。`mode` は「予測対象範囲と予算」という `Predictor` 自身の語彙で、`overviewMode` とはたまたま連動しているだけの別概念(8節) |
| `Player.behave` の `mapMode` / `dvEditActive` | `Player` は複数並存する汎用エンティティで、view 層への参照を一切持たない。view 由来の値は毎フレーム引数で渡す(7節) |
| `player?.state.v ?? v3()`(`FloatingOrigin` の速度基準) | ゼロが「基準なし」の単位元として意味を持つ(位置の `?? null` とは別、21bis) |
| `player?.state.r ?? null`(`syncMarkers` / `applyVisibility` の viewerPos) | **意味のある null**。`EntityMarker.sync` は有無でラベルを変える |
| `if (player) touchControls?.syncModeButtons(...)` | `TouchControls` は `Player` 型から疎結合に保たれている(プリミティブ3つを受ける)ので自決できない。**ただし論点あり**: 艦がいないときに前の艦のモード表示が凍結して残る。本来は仮想パッドごと畳むべきで、それは `ViewManager.applyChrome` の側の話 |
| `initialSave ? {saved} : {…}` 系の判別共用体 | `/refactor-fixed` 13節の模範例そのもの |
| `initialSave?.camera?.view` → `ViewManager` へ | 21節「起動時の状態は、モードではなく状態から導く」の模範例 |
| `TouchControls.isTouchDevice() ? … : null` | Null Object 化するとコンストラクタが DOM を `document.body` へ足す副作用を持つため空実装クラス+インターフェースが要り、現状の1行より複雑になる |

---

## 4. 進め方

| Step | 内容 | 節 | 依存 |
|---|---|---|---|
| A | `ephemeris.ts` の嘘のコメントを実装に合わせる | 1-2 | なし(判断より先に単独で可) |
| B | `MapPicker.refresh` の早期 return で `_visibilityPolicy = null` → `sync` の三項を消す | 2-2 | なし |
| C | `render` を `viewManager.rendersWorld` へ | 2-2 | なし |
| D | `trackAnchor` を `PlanGuide.update` の末尾へ | 2-2 | なし |
| E | `[N]`(次ノードへ自動ワープ)を `PlanEditor.handleInput` へ | 2-2 | なし |
| F | `ephemerisFor(stageClass, phaseOffsets)` を新設し、`Game` は完成した `Ephemeris` を受け取る | 2-1 | なし |
| G | `MapPicker` / `Docking` の `game: Game` を実参照へ分解 | 2-3 | なし |
| H | ポインタ配分の受け手に `overviewMode` を渡して自決させ、`handlePointerInput` を平坦化 | 2-2 | 1-1 の判断、G |

`for` 文と違い `if` はゼロにはならないし、するべきでもない —
**残った `if` が「なぜ `Game` にあるのか」を全部言えることがゴール。**
