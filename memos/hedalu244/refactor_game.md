# game.ts の条件分岐を下位モジュールへ移す

`for` 文の排除は完了した。次は `if`(および三項演算子・`??`・`&&` によるガード)を、
「下位モジュールで決定可能なことは自決させる」原則で減らす。

**原則**: 下位が自決できるようにフラグを持たせる。持たせられないときだけ `Game` に残す。
残す場合はその理由を明文化し、`/refactor-fixed` へ昇格させる。

---

## 1. 現状 — game.ts に残る分岐

依存している値で **6軸** に分類する。軸A・軸E は決着済み、軸B・軸D は残りが判断待ち。

### 軸A: `player: Player | null`(操作対象艦の不在) — **解消済み**

受け手3つ(`NanWatchdog.checkPlayer` / `Targeter.updateBoardMarks` / `EnvironmentScene.sync`)を
`| null` 許容にしたことで、`Game` 側の判断ではなかったガードがすべて消えた。
残るものと理由は 3節 A-4。判断そのものは `/refactor-fixed` 21bis へ昇格済み。

### 軸B: `activeStage.isPlaying`(勝敗の決着) — 残り4箇所、うち3箇所は要判断

| 箇所 | 分岐 | 状態 |
|---|---|---|
| `advanceSimulation` | `if (player && activeStage.isPlaying) player.behave(...)` | **B-α 要判断** |
| `handleMapPointerInput` | `if (!activeStage.isPlaying) return` | **B-γ 要判断** |
| `handleInput` | `simSpeedManager.handleInput(input, isPlaying, ...)` | 残す(`toggleAutoWarpToFirstNode` 内で自決済みの中継) |
| `sync` | `entities.syncPlayers(..., isPlaying, ...)` | **B-δ 要判断** |

### 軸C: `_isPaused`(ポーズ) — 5箇所、**全件 `Game` に残す**(3節 C)

### 軸D: ビューモード(`editMode` / `overviewMode` / `dock`) — 残り5箇所(3節 D-4)

### 軸E: 時間加速の閾値 — **解消済み**

`can*` 述語規約を迂回した裸の比較(`simSpeed > MAX_PHYS_SIM_SPEED`)、
決着後のワープ上限 `min()`、冗長な `sfx.setRcs(false)` の3件とも消えた。

### 軸F: コンストラクタ内の初期状態分岐 — 5箇所、1件だけ移せる(3節 F)

---

## 2. 判断基準 — `if` を3種類に分ける

### (a) 判断の合成 — 無条件で移す

複数モジュールの値を組み合わせて**新しい判断を作っている**もの。
`/refactor-fixed` 1節「条件分岐を伴う判断を Game に置かない」に真正面から反する。

- AND / 三項 / `min` — `playing && canResolvePhysicalCollisions`、
  `playing ? simSpeed : min(simSpeed, MAX_PHYS_SIM_SPEED)`、
  `editMode && selectedNodeIdx !== null`
- **他モジュールの内部フィールドへの直書き** — `player.thrust = null; player.torque = v3()`
- **閾値との直接比較** — `simSpeed > C.MAX_PHYS_SIM_SPEED`(`can*` 述語規約の迂回)

### (b) 単純な呼び出し可否 — 受け手が参照を持っているときだけ移す

フラグを1つ読んで呼ぶ/呼ばないを決めるだけのもの。
**受け手が既にその参照を持っているなら二重判定**なので受け手へ寄せる。
持っていないなら `Game` に残す — **持たせると層の逆転(simulation → camera など)が起きる**。

| 受け手 | 参照 | 判定 |
|---|---|---|
| `MapPicker` | `cameraSystem` を保持済み | 移した |
| `Docking` | `viewManager` を保持済み | 移した |
| `Simulator` | `SimSpeedManager` を毎フレーム引数で受け取れる(`Stage.update` に前例) | 移した |
| `Stage` | 自分の `_phase` の所有者 | 既に自決済み(二重判定) |
| `ViewManager` | `Stage` を持たないが同ファイルに後注入の前例あり | 移した(ただし B-β で分岐自体を再検討) |
| `Predictor` | simulation 層。`CameraSystem`/`Stage` を持たない | **残す** |
| `Player` | 汎用エンティティ。view 層への参照を一切持たない | **残す** |

**同じ `if` ブロックに、そのフラグに依存しない処理が同居している**箇所は、
ほぼ確実に「相乗り」であり分解できる。

### (c) 決着(`isPlaying`)による分岐は、まず存在意義を疑う

creative モードの「複数艦を配置でき、艦が1隻も無くてもシミュレーションは続く」世界が**普通**で、
「艦が1隻しかなく、失うと終了する」stage ミッションの方が**逸脱**。したがって
**stage の決着後という極めて特殊な場面のためだけに立っている分岐は、移す前に消せないか見る。**
性能目的の簡略化なら特に疑う — 軽くすべきなのは高ワープ中・戦闘中であって、決着後は
ボトルネックではないので、可読性を落としてまで軽量化する意義が無い。

---

## 3. 軸ごとの調査結果

### 軸A: `player: Player | null` — 解消済み

#### A-3. `EnvironmentScene.sync` の null は暫定 — 近似そのものが原因

`?? null` にしたことで「艦がいない」を値で表現できるようになったが、**これは対症療法**である。
狂いの原因は、**アクティブ艦1点の日照率を平行光・環境光の全体へ流用している雑な近似**の方で、
その帰結として「艦がいないと、実在する他のエンティティを照らせない」というおかしなことが起きる。

「全エンティティがアクティブ艦の近くにいる」は事実誤認。現状害が出ていないのは
**追従カメラではアクティブ艦の近くの実体しか見えない**ことと、**広範囲視点では照明の影響を受ける
メッシュが小さすぎてほぼ見えない**ことの、二つの偶然による。

近い将来、遮蔽度はシャドウマップによる計算に置き換えるか、そうでなくても各エンティティの照度を
それぞれ利用する形に置き換える。暫定である旨は `environment-scene.ts` の `sync` 直前に TODO として
明記済み。

#### A-4. `Game` に残すもの(委譲先が無い)

| 箇所 | 理由 |
|---|---|
| `player.behave(...)` の呼び出し可否 | `Player` のメソッドなので非 null 必須 |
| `this.player.plan.trackAnchor(this.player.state)` | 自機が null だと**引数の式自体が組み立てられない**。防御的分岐ではなく構造的制約 |
| `FloatingOrigin` 初期値 | `Game` 自身のフィールドの初期化。委譲先が無い |
| `excludedIds` の配列組み立て | 単なる値変換。下位は `readonly string[]` を要求 |
| `player?.state.v ?? v3()` | `FloatingOrigin` の速度基準。ゼロが「基準なし」の単位元として意味を持つので既定値でよい(位置の `?? null` とは別) |
| `?? null`(`syncMarkers` / `applyVisibility` の viewerPos) | **意味のある null**。`EntityMarker.sync` は `viewerPos` の有無でラベルを変えるので、これが正しい形 |
| `touchControls?.syncModeButtons` | `TouchControls` は `Player` 型から疎結合に保たれている(プリミティブ3つを受ける)。この設計は妥当なので、null 分岐は呼び出し側に残る |
| `handleMapPointerInput` の戦闘枝の `&& this.player` | 受け手(`navTarget.updateCombatBasePicking` / `targeter.updateCombatTargeting`)はどちらも自機を要求しなくなったので、いまは純粋な「操縦しているか」のゲート。外すと艦を失った後も右クリックメニューが開く — 軸C/Dと併せて再検討 |

### 軸B: `activeStage.isPlaying` — 残った分岐はすべて「決着で挙動/表示を変える」もの

`_phase` の書き手は `Stage`/具象ステージ自身に閉じており、`game.ts` は一度も書かない。
**正本の所有は正しい。** 残っているのは「決着したら何を止めるか」という判断だけで、
2節(c)の基準ではすべて存在意義を問う対象になる。次に判断すべきは以下の5件。

#### B-α. `player.behave` の決着ゲート — 効くのは「決着したが自機は生存」だけ

`advanceSimulation` に残った唯一の `isPlaying` ゲート。

- 喪失した自機は同一フレーム末に `reclaimDead()` で取り除かれるので、次のフレームには
  `player` が `null` になっている。**死亡を理由にこのゲートが効くことはない。**
- したがってこのゲートが実際に効いている場面は **決着したが自機は生存している**とき、つまり
  勝利後(stage1/2 の全滅)と stage0 の timeup だけ。`else if (player)` 節の
  `clearTransientCommands()` も同じ場面でしか走らない。
- **外した場合の見え方**: 結果画面(`#hud-end` は `hud.layers.system` の全画面オーバーレイ)が
  出たまま、自機を操縦・射撃できる。
- **外した場合の非対称**: 各具象 `Stage.update` は自分で `if (!this.isPlaying || !player) return;` を
  持つので敵は行動しない。stage0 の timeup は敵が生存したまま残るため、
  「自機だけ動けて敵は止まっている」状態が見える。

選択肢: (i) ゲートを外す(2節(c)どおり。非対称は許容する) /
(ii) 残して理由をコメントに書く / (iii) 具象ステージ側の自決ガードも同時に見直して対称にする

#### B-γ. `handleMapPointerInput` の `if (!isPlaying) return`

決着後にポインタ操作を配らない理由がコードにも文書にも無い。
`Input` はキャンバス(`renderer.domElement`)を購読しており、結果画面は `pointer-events:auto` の
全画面要素なので、**そもそもクリックがキャンバスへ届かない**可能性が高い。
届かないならこのガードは実効を持たない。実機で確認して、実効が無いなら削除する。

#### B-δ. `RcsEffects.sync` の `phasePlaying` — 決着で**表示**を変えている典型

`entities.syncPlayers(..., activeStage.isPlaying, _isPaused, ...)` →
`Player.syncPlayer(..., phasePlaying, paused, ...)` → `RcsEffects.sync` の
`rotating = alive && phasePlaying && !paused && |torque| > eps`。

B-α のゲートを残す限り決着後の `torque` は畳まれているので `phasePlaying` は実質冗長。
B-α を外すなら、これが唯一「決着後に RCS 噴射煙と RCS 音を止める」判断になる。
2節(c)の基準では削除候補(`isPaused` の方は 3節 C のとおり残す理由がある)。

### 軸C: `_isPaused`(ポーズ)— **全件 `Game` に残す**

`/refactor-fixed` 1節が
「`Game` 自身の状態と、それを切り替えるだけのメソッドは配線の一部として残してよい(`isPaused` と
`pause`/`resume`)」と**明示的に例外として許可している**。以下すべてその範囲内。

| 箇所 | 判定と理由 |
|---|---|
| `_isPaused` / `pause()` / `resume()` | 残す。分岐も組み立ても持たない単純なセッター |
| `if (!_isPaused) advanceSimulation(dt)` | 残す。**`SimSpeedManager` へ `simSpeed = 0` として寄せるのは筋が悪い** — `SIM_SPEED_LEVELS` は `[1, 4, 16, ..., 131072]` の離散段で 0 を表現できず、混ぜると `shift()`/`update()` がすべて「0はワープ操作の対象外」の特殊扱いを要する。かつポーズ(時間を進めない)とワープ閾値(進める前提で相互作用の範囲を決める)は別の関心事(`/refactor-fixed` 8節) |
| `_isPaused && modalController.isOpen` | 残す。`Game` 所有の `_isPaused` と `Hud` 所有の `isOpen` を跨ぐ単純な AND。`ModalController` にポーズを教えるのは責務の逆流、AND 1本のために横断モジュールを立てるのも重すぎる |
| `!_isPaused && this.player` | 残す。同上(優先順位付きディスパッチの一部) |
| `syncPlayers(..., _isPaused, ...)` | 残す。`EntityManager` → `Player.syncPlayer` → `RcsEffects.sync` への**単純な中継**(途中に分岐なし)。最終用途は「RCS 噴射煙と SFX の可否」で、`pause()` が畳むのはアクティブ艦の `torque` だけなのに対しパッシブ艦は `advanceSimulation` ごと飛ぶので古い `torque` が残りうる。その残存トルクで演出が動かないよう明示的にゲートするのは正しい |

### 軸D: ビューモード(`editMode` / `overviewMode` / `dock`)

フラグの正本と同時性は既に正しい。`ViewManager` の状態は
`worldView: 'combat' | 'map'` と `isDockOpen: boolean` の**2軸**で、`applyChrome()` が唯一の
書き込み経路。`overviewMode ≡ editMode ≡ !forceCurrent` は**たまたまではなく設計上の恒等**。
`dock` は独立軸で、ドック開閉は裏の `worldView` を一切動かさない。

#### D-4. `Game` に残すべきもの

| 箇所 | 理由 |
|---|---|
| `Predictor.update` の `overviewMode ? 'map' : 'combat'` | `Predictor` は simulation 層で `CameraSystem` を持たない。持たせると **simulation 層が camera 層へ依存する向きの逆転**になる。`mode` は「予測対象範囲と予算」という Predictor 自身の語彙であり、`overviewMode` とはたまたま連動しているだけの別概念(`/refactor-fixed` 8節) |
| `Player.behave` の `mapMode` | `Player` は複数インスタンスが並存する汎用エンティティで、`PlanEditor`/`ViewManager`/`CameraSystem` への参照を一切持たない。view 由来の値は「その瞬間の表示文脈」として毎フレーム引数で渡す(`/refactor-fixed` 7節) |
| `handleMapPointerInput` の `editMode` 分岐 | `PlanEditor` は `MapPicker`/`NavTarget`/`Targeter` のいずれも持たない。`handleInput` と同型の**優先順位付きディスパッチ**であり、どちらかへ寄せると「持っていない側への参照追加」が要る |
| `render` の dock 早期 return | `renderer`/`scene` は `Game` 自身の資源で `ViewManager` は持たない。持たせると責務が「ビュー選択の正本」から「描画実行の決定」へ肥大する |
| sync 全域の `overviewMode` 引数配布 | 受け手(`EntityManager`/`Targeter`/`NavTarget`/`Stage`/`EnvironmentScene`/`marker/*`)はいずれも camera 層を持たない設計。渡すのが正しい |

#### D-5. 検討の余地

`sync` の `overviewMode ? this.mapPicker.visibilityPolicy : null` は、`refresh()` が
マップ外で早期 return するようになった今なら、`MapPicker` 側が
「マップを見ていないフレームでは `visibilityPolicy` を `null` に戻す」ことで
`this.mapPicker.visibilityPolicy` の素通しにできる。
ただし「前フレームの値が残る」現在の挙動との差を確認してから。

### 軸F: コンストラクタ内の初期状態分岐 — **1件だけ移せる、4件は模範例**

| 箇所 | 判定 |
|---|---|
| `ephemerisConfig === undefined ? ... : ...` | **移せる(任意)**。`main.ts` が `ephemerisConfigFor(launch) === undefined` として**同じ真偽値を既に評価している**(外部暦パックを `await` でロードするか判断するため)。`Ephemeris`(`physics/`)側へは寄せられない(`physics/` は `game/` に依存できない、`/refactor-fixed` 4節)が、`stage-dictionary.ts` に既にある `*For(launch)` 群の隣へ `ephemerisFor(launch, phaseOffsets, absoluteEphemeris): Ephemeris` を新設すれば `game.ts` は1行になる。**ただし `main.ts` 側の判定(非同期ロードの要否という別の関心事)は残るので、重複自体は完全には消えない** |
| `initialSave ? {saved} : {playerCount}` | **残す**。`/refactor-fixed` 13節が模範例として挙げている判別共用体そのもの |
| `initialSave?.camera?.view ?? (initialPlayer ? 'combat' : 'map')` | **残す**。21節「起動時の状態は、モードではなく状態から導く」の模範例そのもの |
| `if (TouchControls.isTouchDevice())` | **残す**。null チェックは全体で3箇所の optional chaining のみ。Null Object 化するとコンストラクタが実際に DOM を `document.body` へ追加する副作用を持つため空実装クラス+インターフェースが要り、**現状の1行より複雑になる**。`OWNERSHIP.md` にも意図的な設計として明記済み |
| `onShipPlaced` の `if (this.player === null)` | **残す**。CLAUDE.md が明示的に肯定した配線 |
| `floatingOrigin` 暫定値 | **残す**。`Game` 自身のフィールドの初期化で委譲先が無い。理由もコメント済み |

---

## 4. 次の作業

### Step A(要判断) — 決着後分岐の残り3件

B-α / B-γ / B-δ。いずれも 2節(c)の基準に当たる。B-α と B-δ は連動するので一緒に判断する。

### Step B — 各具象 `Stage.update` 冒頭の重複ガード

8ステージのうち7つが `if (!this.isPlaying || !player) return;` の同じ2行を持つ
(`CreativeStage` だけ構造的に不要)。`Stage.update` を公開の入口として、具象は
`protected updatePlaying(dt, player, ...)` を実装する形にすれば重複が消えるが、
`CreativeStage` が例外になる。**B-α の判断が付いてから**着手する。
なお `!player` の枝は、艦を喪失したステージでも通るようになった(喪失即除去のため)。

### Step C — D-5(`visibilityPolicy` の素通し化)

`refresh()` の早期 return が入ったので実施可能。前フレームの値が残る差の確認が要る。

### Step D(任意) — `ephemerisFor(launch, ...)`(軸F)

`stage-dictionary.ts` の `*For(launch)` 群の隣へ追加。効果は `game.ts` で6行→1行。
`main.ts` 側の重複判定は残るので優先度は低い。

---

## 5. 見込み

| 軸 | 当初 | 移した/消した | 残す |
|---|---|---|---|
| A `player \| null` | 13 | **完了** | 8(`behave` 呼出、`trackAnchor`、`FloatingOrigin` 初期値ほか) |
| B `isPlaying` | 9 | **6** | 3(全件 Step A の判断待ち) |
| C `isPaused` | 5 | **0** | 5(ルールで明示的に許可された例外) |
| D ビューモード | 8 | **3** | 5(層の逆転を避けるため) |
| E ワープ閾値 | 3 | **3** | 0 |
| F コンストラクタ | 5 | **1**(任意) | 4(いずれもルールの模範例) |

`for` 文の排除と違い `if` はゼロにはならないし、するべきでもない —
**残った `if` が「なぜ Game にあるのか」を全部言えることがゴール。**
