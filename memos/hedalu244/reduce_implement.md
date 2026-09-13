# 無駄に複雑な挙動を作っている実装 — 削除・修正の候補

調査時点: `restructure-architecture` @ `042596fc`(段 1・2 実施後)。`path:line` はこの時点のもの。

**残すか消すかはユーザーが判断する。** この文書は候補の一覧と疑いの順位だけを持つ。挙動変化を伴うので、
実施する分は refactor とは別の PR にする。

## 読み方

- **確度** — 「レガシーで、維持する理由がない」という疑いの強さ。高=ほぼ意図されていない、中=判断が要る、低=擬陽性寄り。
- **確認** — `自分で確認` はコード・git 履歴で裏を取ったもの。`報告のみ` はサブエージェントの報告を統合しただけで、
  実施前に現地確認が要る。
- **仕様** — SPEC に書かれていれば消すべきでない疑いが上がる。ただし SPEC にも場当たりの追記があるので、
  **第4群**には「仕様ごと消す/直す」ものを分けた。
- **計画** — `memos/hedalu244/restructure-architecture.md` が既に手を付ける予定のものは段・手順を添えた。
  重複して着手しないための印で、そこに載っていること自体は「消してよい」の根拠にならない。

## 検出の方法と、例の再現

ユーザーが挙げた3例が機械検査で捕まることを確認してから配った。

| 例 | 捕まえた検査 | 現状 |
| --- | --- | --- |
| BGM を再出撃・タイトルで止めない | `grep -rn "bgm|Bgm|BGM" src` で呼び出し元6ファイルへ絞る | 段 1-6 の宣言化でほぼ解消。残りは **R15** |
| ランごとの項目がラン跨ぎ設定に載る | `grep -rn localStorage src` → 保存鍵の全量は `src/settings/user-settings.ts` の11項目 | 項目ごとの判定は **R23** |
| 自転が乱数・地球を名指し | `grep -rn "Math.random" src`(57件)→ `game.ts:170`、`grep -rniE "'(earth|moon|sun)'" src` | **R16**・**R17** |

これに加えて、未参照 export の全量走査(`export` 宣言を1件ずつ `src`/`tests`/`tools` へ突き合わせ)と、
`Date.now()`/`performance.now()` の層別走査、`undefined` を明示的に渡している引数の走査を通した。
範囲を7つに分けたサブエージェント(音 / 永続 / 天体 / HUD / 戦闘 / カメラ・計画・入力 / ラン寿命)の報告を統合した。

---

# 第1群 — 挙動が意図されていないもの(最優先)

仕様に反している、または誰も要求していない副作用が出ているもの。

### R1. 見ているビューがシミュレーションの積分経路を選んでいる
- 症状: `view !== 'map'` のとき `forceCurrent` が立って予測弧が伸びず、マップでは艦の実位置が予測弧のエルミート補間から読まれ、戦闘ビューでは RK4 で積分される。どちらを見ていたかで近地点や焼失時刻がずれる。
- 場所: `src/game/game.ts:409-415`、`src/game/dynamic/predictor.ts:59`、`src/game/dynamic/dynamic-motion.ts:299-325,419-425`
- 疑う理由: 弧の「なぞり」は積分を省く最適化だが、弧が在るかを決めるのが純粋な表示状態(ビュー・表示期間・軌道線トグル・ナビターゲット・解析窓)になっている。
- 仕様: INVARIANTS.md §3「表示のオンオフは、そのどれを選んでも、物体が実際に辿る軌道と、画面に出る数値を動かさない」/ PLAN.md §9「この予測はマップモードの機能ではなく常時裏で進んで」— **実装が仕様に反している**
- 減るもの: `canDisplayFuture` 引数と、後付けの3フラグ(R2)がまとめて落ちる。/ 確度: 高 / 確認: 自分で確認 / 計画: 段 3(手順 3-5、R4 の検査)

### R2. 表示側がモデル層のフラグを直接書いており、降ろし忘れが残る
- 症状: `trajectoryReader` / `analysisPanelReader` / `navTargetReader` を HUD・軌道線・ナビターゲットが直接書く。軌道分析ウィンドウは ✕/ESC で閉じても `dispose()` を通らないので、フラグが立ったまま永久に残り、窓が無いのに予測が回り続ける。
- 場所: `src/game/dynamic/dynamic-motion.ts:168-170,241-244`、`src/game/hud/orbit/orbit-analysis-window.ts:38-39,87`、`src/game/lines/entity-line-manager.ts:69`、`src/game/nav-target.ts:107-108`
- 疑う理由: `OrbitAnalysisWindow.dispose()` の呼び出し元がリポジトリに1件も無い(`src/game/hud/hud.ts:103` が `new` するだけ)。3フラグ自体が R1 の穴を塞ぐ後付け。
- 仕様: PLAN.md §13「パネルを開いている間は、戦闘ビューであっても未来の軌道計算が止まらない」— 閉じた後の記述なし
- 減るもの: R1 を直せばフラグ3種が消える。直すまでの暫定でも `onClose` で `dispose()` を呼ぶだけで残留が止まる。/ 確度: 高 / 確認: 自分で確認 / 計画: 段 3 の達成目標

### R3. 「決着後も世界は動き続ける」が実装されておらず、コメントが逆を主張している
- 症状: 勝敗が確定すると `advanceSimulation` ごと飛ぶので、結果画面の裏で弾・敵・補給タイマーが完全に凍る。
- 場所: `src/game/game.ts:121`(`simulating = !_isPaused && activeStage.isPlaying`、コメント「一時停止中と決着後は止まる」)、`src/game/game.ts:404-406`(コメント「決着は積分を止めないので」)
- 疑う理由: 隣接する2つのコメントが逆を言っている。以前は止めていなかった名残。
- 仕様: GAME.md §2.1「**決着後も世界は動き続ける**: 結果画面の背後で…敵行動・補給・タイマーも通常どおり進む。勝敗の再確定だけが起きない」
- 減るもの: 仕様を消せば嘘コメントと `stage.ts` の二重決着ガードの根拠が整理される。実装を直せば結果画面が静止画でなくなる。**どちらに倒すかは仕様判断**。/ 確度: 高 / 確認: 自分で確認

### R4. マップの「基地」表示トグルを閉じると、操作中の基地のエンジン音が止まる
- 症状: 持続する推進音・RCS 音の可聴判定に、マップの表示カテゴリが入っている。自艦操作時は常に真なので効かず、基地操作時だけ「アイコンを消すと音も消える」。
- 場所: `src/game/controlled-loop-sfx.ts:17`、`src/game/map/visibility-policy.ts:160`、`src/game/game.ts:605`
- 疑う理由: 誰も要求していない結合で、自艦では到達不能な分岐になっている。
- 仕様: AUDIO.md「一時停止中と勝敗確定後は…鳴らない」「聞こえるのは現在操作している1隻ぶんだけ」— 表示トグルとの連動は記述なし
- 減るもの: `syncControlledLoopSfx` の引数1つと条件1つ。INVARIANTS §3 への違反が1つ消える。/ 確度: 高 / 確認: 自分で確認

### R5. 戦闘 HUD の「ブースター追加」が、基地も費用も要らずに満タンの段を生む
- 症状: 飛行中に燃焼管理パネルのボタンを押すだけで、既定値の段が4段まで生える。唯一のガードは段数上限。
- 場所: `src/game/hud/panels/burn-management-panel.ts:96-98`、`src/game/game.ts:292-293`、`src/game/player/attached-boosters.ts:52-62`
- 疑う理由: 手元確認用のボタンがそのまま常設 UI に残った形に見える。
- 仕様: FLIGHT.md「段は基地での船体組立で追加し、最大4段まで」— HUD から追加できるという記述はない
- 減るもの: ボタンと `onAttach` 経路が落ち、段の入手口が基地1箇所になる。/ 確度: 高 / 確認: 自分で確認

### R6. 弾の消滅中心が「操作対象」で、操作対象が居ないと ECI 原点になる
- 症状: 交戦圏外判定の中心が `controlled?.state.r ?? v3()`。基地を操作中は基地基準になり、操作艦が居ない瞬間(creative で解除・全滅)は地球中心基準になって飛んでいる弾が一斉に消える。近接通過音も同じ中心。
- 場所: `src/game/dynamic/dynamic-entity/bullet-reaction.ts:55,59,63`、`src/game/dynamic/simulator.ts:110,158`
- 疑う理由: 交戦圏は `engagement-zone.ts` が「自機と基地の球の和」として正式に持っている。弾だけが視点1点という別表現を使い、引数名も `viewerPos`(表示の語彙)。
- 仕様: COMBAT.md「弾は自機から交戦圏の半径以上離れると消える」
- 減るもの: `viewerPos` 引数が `checkLoss` の4階層から消え、操作対象の切替で弾が消える挙動も無くなる。/ 確度: 高 / 確認: 自分で確認

### R8. ステージ選択画面で Enter を押すとステージ1 が始まり、隠しデバッグステージがキーで素通りする
- 症状: `stage1.selectKeys = ['Digit1', 'Enter']` なので、何を選んでいても Enter でステージ1 が起動する。`[E]`/`[L]` で一覧に無い DEBUG(架空星系)/DEBUG(高負荷)が起動する。
- 場所: `src/game/stages/stage1.ts:19`、`src/launcher/stage-select.ts:248-251`、`src/game/stages/stage-debug-alt-system.ts:105-106`、`src/game/stages/stage-debug-load.ts:25-26`
- 疑う理由: キー照合が `hiddenFromSelect` を見ていない(一覧と `resumableStageClass` は見ている)。`Enter` は確定キーなので誤爆しやすく、行ラベルにも出ない(`selectKeys[0]` しか表示しない)。
- 仕様: GAME.md「各ステージは…専用のショートカットキーでも選べる(例: ステージ1が `[1]`)」「いずれもタイトル画面のステージモードタブには出ず(画面隅の専用リンクからのみ到達できる)」
- 減るもの: `'Enter'` を外し、キー照合に `hiddenFromSelect` を足すだけ。隠し経路が1本化する。/ 確度: 高 / 確認: 自分で確認

### R11. 計画ノードの期限切れ・達成判定が戦闘ビューでしか走らない
- 症状: マップを開いているあいだ、実行時刻を60秒過ぎたノードは落ちず、マニューバ達成も判定されない。マップを閉じた瞬間にまとめて消化される。
- 場所: `src/game/plan/plan-guide.ts:27,52,158`、`src/game/view/combat-view.ts:47,104`
- 疑う理由: `consumeNodesUpTo` の呼び出し元が `CombatView` の所有する `PlanGuide` だけ。規則が表示器の寿命に乗っている。
- 仕様: PLAN.md「実行時刻を60秒過ぎたノードは、達成判定にかかわらず計画から自動的に落ちる」— ビューの条件は付いていない
- 減るもの: ノード列の寿命がビューから切れ、「マップを閉じたら急に3件消えた」が無くなる。/ 確度: 高 / 確認: 報告のみ / 計画: K3-1、手順 3-5(SPEC 更新込み)

### R12. [N] 自動ワープと [X] 計画全体破棄が、仕様と逆のビューに置かれている
- 症状: [N] と「未選択の [X] で計画全体を破棄」は戦闘ビューでしか効かず、マップビューの [X] は選択ノードが無いと何も起きない。
- 場所: `src/game/view/combat-view.ts:69-84`、`src/game/plan/plan-editor.ts:178`、`src/game/view/map-view.ts:114-116`
- 疑う理由: 同じ `K.deleteNode` を2つのビューが別の意味で消費している。
- 仕様: CONTROLS.md「N … マップビュー、ノードがある場合」「X 選択中のノードを削除(未選択なら計画全体を破棄) マップビュー」
- 減るもの: `CombatView.handleInput` と `clearPlan` が消え、計画キーの窓口が `PlanEditor` 1つになる。/ 確度: 高 / 確認: 報告のみ

### R16. 自転初期位相だけが乱数で、時刻決定性から外れている(地球を名指し)
- 症状: 同じ元期で始めても起動ごとに地球の経度が変わり、地表・海岸線・オーロラ・自転座標系の位置がランごとにずれる。雲と公転は時刻決定的。
- 場所: `src/game/game.ts:170`、`src/physics/celestial-motion.ts:324-327`(`eciPole`)、`src/game/celestial/solar-system/earth-system.ts:103`、`src/game/save/save-data.ts:293`
- 疑う理由: 他7惑星は `iau` 極モデルの `w0Deg + wRate·t` で時刻決定的に解けており、地球だけが1天体専用の極モデルを持ち、その位相原点を乱数で埋めている。IAU の地球自転角(W₀=190.147°)を定数で置けば乱数も位相の配線も要らない。
- 仕様: CELESTIAL.md §3「**地球の自転初期位相だけはゲーム起動のたびにランダムに決まる**」/ SAVE.md「地球の自転の位相…ゲーム開始時に一度だけランダムに決まる値」→ **第4群(仕様ごと消す)**
- 減るもの: `Math.random()` 1箇所・セーブ項目1つ・`spinPhase0` 引数(game→stage→solarSystem→earthSystem→planetSystem→PlanetMotion)・`eciPole` 専用分岐。暦から再現可能なランになる。/ 確度: 高 / 確認: `game.ts:170` は自分で確認、極モデルは報告のみ / 計画: K2(時刻層の構築値)、手順 6-4

### R17. 地球・月の名指しが一般の仕組みの隣に残っている(8箇所)
- 症状: 天体を一般に扱う仕組みがあるのに、地球・月・太陽を文字列で名指しする分岐が並んでいる。
  1. 軌道要素の基準が `'auto'|'earth'|'moon'|'target'` の固定2択。架空星系でもボタンが出て、押すと無言で自動選択のまま(`src/game/orbit-reference.ts:12,70-77`、`src/game/hud/orbit/orbit-panel.ts:14-19`)
  2. カメラの基準面が `findMotion('earth')`/`findMotion('moon')`。月が無い星系で「月軌道面」を選ぶと無言で黄道面に落ちる。赤道面は `?? motionOf(originId)` を併記していて二重決定(`src/game/camera/focus-camera.ts:271-284`)
  3. 衛星の軌道線で月だけ「系にいなくても出す」例外。土星系にいても月の楕円が出続ける(`src/game/map/visibility-policy.ts:178-183`)
  4. 近点/遠点の和名が `'earth'/'moon'/'sun'` の if 連鎖。火星・木星では一般名「近点」に落ちる(`src/game/hud/orbit/orbit-labels.ts:12-14`、`src/game/creative/placement-validation.ts:27-28` は `?? 'earth'` まで名指し)
  5. 天体メニューの副題が月だけ「衛星 (月)」で、タイタンやエウロパは「天体・ラグランジュ点」(`src/game/celestial/celestial-entity/celestial-entity.ts:103-107`)
  6. 「地球専用」参照軌道(静止・太陽同期・モルニヤ・ツンドラ)。物理側 `src/physics/earth-reference-orbits.ts:28-55` は mu・J2・自転周期を `CelestialBody` から読む完全に一般の実装(`src/game/celestial/orbit-guide/orbit-guide-model.ts:330-360`、`src/game/pickable/line-pickables.ts:55`)
  7. CR3BP の系→天体の固定表。系 id が「主-副」そのままで、表の `[0]`(主天体)は誰も読まない(`src/physics/orbit-guide.ts:40-55`)
  8. スケールグリッドが `findMotion('moon')`(`src/game/celestial/scale-grid-view.ts:41`)
- 疑う理由: どれも「地球-月しか無かった時期」の名残。一般の判定(`CelestialClass`・親子関係・`motion.primary.id`)が同じファイルの隣にある。
- 仕様: 1 は ORBIT.md に、3 は MAP.md に、6 は MAP.md に書かれている → **第4群**。4・5・7・8 は記述なし
- 減るもの: 名指し分岐8箇所と、無言で落ちる選択肢が消える。天体を増やしたときに HUD・カメラを触らなくて済む。/ 確度: 高(4・5・7・8)/ 中(1・2・3・6)/ 確認: 名指しの存在は自分で確認、一般化可能性は報告のみ

### R18. 主星の決定を描画 View の `stellarLight` から引き、弾の散布界まで届いている
- 症状: 「どれが恒星か」を見た目で決め、その結果が自機・敵の太陽グレア散布界に入る。
- 場所: `src/game/celestial/celestial-system.ts:147-150`、`src/game/player/fire-control.ts:313`、`src/game/dynamic/dynamic-entity/enemy.ts:412`
- 疑う理由: 同じ問いに正本が2つある — 積分側(輻射圧・日照)は `motion.kind === 'star'` で決め、表示・射撃側は View 由来。恒星の見た目を差し替えると命中精度が変わる。
- 仕様: CELESTIAL.md §1 は恒星を登録天体として定めるだけ。見た目から主星を決めるとは書かれていない
- 減るもの: 星の同定が1箇所になり、描画層への依存が1つ減る。/ 確度: 高 / 確認: 自分で確認

### R20. 接触代理の置き直しが履歴キューに毎サブステップ積み続ける
- 症状: 放熱板の折り 12 個とベルト節点 18 個が毎サブステップ `proxy.state = world` で置き直され、setter が `DynamicTrajectory.reset()` → `StateQueue.push()` を通る。間引きも切り捨ても無いので 30 本のキューが無制限に伸びる。
- 場所: `src/game/player/radiator.ts:193`、`src/game/player/belt-physics.ts:246`、`src/game/dynamic/dynamic-motion.ts:225-228`、`src/physics/state-queue.ts:55-62`
- 疑う理由: `state` setter は「不連続な飛び」のための口で、毎歩の再配置用ではない。代理の履歴は誰も `at()` で引かない。
- 仕様: SPEC に記述なし
- 減るもの: 長い戦闘での漸進的なフレーム落ちが無くなる。/ 確度: 中 / 確認: 報告のみ

---

# 第2群 — レガシーの名残で、消すと単純になる(挙動が小さく変わる)

### R23. ラン跨ぎ設定に、1ランの中の視点であるべき項目が混ざっている
- 症状: 「対象/ガイド/軌道ガイド」タブと軌道ガイドの群タブの選択が、ブラウザを閉じても次のランへ持ち越される。
- 場所: `src/settings/user-settings.ts:44-47,73-78`、`src/game/hud/hud-selection.ts:13,18,66-82`
- 疑う理由: **ユーザーの例2。** 11項目の判定は以下。
  - ラン跨ぎで正しい: `graphics` / `renderStyle` / `bgmVolume` / `themePalette`
  - UI-DESIGN.md が跨ぎを明記: `panelCollapsed`
  - 好みに近く跨ぎで許容: `mapDisplayToggles` / `gridVisibility` / `orbitGuide`
  - **ラン内の視点に見える: `viewOptionsTab` / `orbitGuideGroupTab`**(カメラ視点や選択中ビューはスナップショット側に入っているのに、タブだけ localStorage にある)
- 仕様: MAP.md「タブは常にどれか1つが選ばれている」/ UI-DESIGN.md — どちらも persistence の記述なし
- 減るもの: 保存鍵2つと parse/format 4関数。ランを始めると既定タブから始まる。/ 確度: 中 / 確認: 項目の全量は自分で確認、意味の判定は報告のみ

### R24. 波の同時展開数に、仕様に無い第二の上限が重なっている
- 症状: `allowedMaxWaveCount`(2→4→∞)が `maxGroups` とは別にあり、同じ波数でも `activeGroups` が 0 か否かで値が変わる。第4波で生存グループが1つでもあると新規の波が湧かず、全滅させるまで進行が止まる。
- 場所: `src/game/stages/stage-utils/wave-attack.ts:121-131,160-166`
- 疑う理由: 呼び出し側が既に `activeGroups >= maxGroups` で打ち切っている。2/4/∞ という値の出所も説明が無い。
- 仕様: GAME.md §2.3「同時展開数: 波数が進むほど上限が上がる(1 → 2 → 3 グループ)」— 波数そのものの上限は記述なし
- 減るもの: 分岐が5本から1本になり、「第4波で進行が止まる」停滞が消える。/ 確度: 中 / 確認: 報告のみ

### R26. 曲の選択が乱数で、時刻決定的でない
- 症状: ランごとに最初の曲が無作為に決まり、5分ごとの曲送りも「直前以外から無作為」。
- 場所: `src/audio/bgm/conductor.ts:50,125`、`src/audio/bgm/bgm.ts:103`
- 疑う理由: 作曲側は「同じ step には常に同じ音列」を約束して完全に決定的なのに、選曲だけが乱数。
- 仕様: AUDIO.md「複数の曲が用意されており、約5分ごとに次の曲へ自動的に切り替わる」— 無作為である要求は記述なし(「次の曲へ」は順送りと読める)
- 減るもの: 乱数2箇所・optional 引数1つ・クランプ1つ・重複回避1関数。/ 確度: 中 / 確認: 報告のみ

### R27. 既定名の言語プールが個体ごとに無作為で、一隻ずつ別文化の名前が混ざる
- 症状: 名前を省略して配置した艦・基地・敵に、ポリネシア語/広東語/フランス語のどれかが 1/3 で割り当たる。
- 場所: `src/game/random-name.ts:36-56`
- 疑う理由: どの文化かを誰も選べず・保存せず・表示で区別もしないので、プールを3つに割った意味が挙動に出ていない。
- 仕様: GAME.md「名前欄を空欄のまま確定すると、種類ごとの既定名が自動で付く」— 言語の記述なし
- 減るもの: `lang` 分岐と 9 本の配列が 3 本になる。/ 確度: 中 / 確認: 報告のみ

### R28. 視点リセットが2種類あり、マップ側は仕様の半分しかしない
- 症状: 同じ「視点リセット」で、戦闘ビューはフォーカスと基準フレームまで戻すが、マップはロールとパンだけ。さらに `/` と `_` の同時押しで、押している間ずっと `mapCamera.reset()` が走る隠し操作がある。
- 場所: `src/game/camera/camera-system.ts:61-70,188-194`、`src/game/camera/focus-camera.ts:398-409,513-527`
- 疑う理由: `reset()` と `resetToInitial()` の2経路が並立し、ヒント文も別々。同時押しはエッジ判定でなく、同じ操作が中クリックとボタンで既に届く。
- 仕様: CAMERA.md「**視点リセット**は、フォーカスを操作対象へ、基準フレームをそのビューの既定へ、視点を既定の後方見下ろしへ戻す」— ビューによる差は書かれていない。CONTROLS.md に同時押しの記述なし
- 減るもの: リセット経路が1つになり、ヒント文の二重管理とビュー分岐が消える。/ 確度: 中 / 確認: 報告のみ

### R29. ヘルプの「表示対象」タブが現在のビューに上書きされる
- 症状: ヘルプ内でタブを手動に切り替えても、ビューが変わった瞬間に黙って戻る。開いている間 `window` へ keydown を張っている。
- 場所: `src/game/hud/windows/help-panel.ts:120,180,220`、`src/game/hud/hud.ts:154`
- 疑う理由: `setView()` のコメント自身が「タブで手動に選んだモードもここで上書きされる」と認めている。キーボード図のハイライトという仕様外機能のために §7 の禁止事項を踏んでいる。
- 仕様: UI-DESIGN.md §8「ヘルプ — 操作の対応表を1つ持つ」/ §7-2 は画面全体への独自キー監視を禁止
- 減るもの: モード/入力方式/カテゴリの3タブ・検索・キーボード図・グローバル keydown が落ち、仕様どおりの1枚の表になる。/ 確度: 中 / 確認: 報告のみ

### R30. 折りたたみの初期値が4箇所で「畳む」になっている
- 症状: 初回起動時、左右レール・Orbit パネル・Enemies パネル・表示パネルが畳まれて始まる。`hud-root.ts:269` だけ `isCompactViewport()` を構築時に1度評価するので、画面回転で再評価されない。
- 場所: `src/game/hud/hud-root.ts:72,170,269`、`src/game/hud/panels/view-options-panel.ts:208`
- 疑う理由: 仕様が既定を1つに定めているのに、既定が4箇所へ散って別々の条件を持っている。
- 仕様: UI-DESIGN.md §5「折りたたみの選択がまだ保存されていない…ときの既定値は**展開**とする」
- 減るもの: `defaultCollapsed` の分岐と関数版/値版の二形が消える。/ 確度: 中 / 確認: 報告のみ

### R31. BGM 音量の初期値が4重に配られ、消音ボタンの復帰音量だけ保存されない
- 症状: 同じ初期音量が `Bgm`・`PauseMenu`・`SettingsView` の3コンストラクタへ渡され、直後に購読の初回通知で上書きされる。消音してから再読込すると「消音」解除で 100% に戻る。
- 場所: `src/main.ts:135,138`、`src/hud/windows/pause-menu.ts:50,130,207`、`src/settings/stored-setting.ts:80`
- 疑う理由: `StoredSetting.subscribe` は登録時に現在値で必ず1回呼ぶ。`lastVol` だけが保存されない隠れステートで、音量スライダーが 0 にできるのでボタン自体が無くても消音はできる。
- 仕様: AUDIO.md「設定画面の BGM 欄で、全体の音量調整と…ができる」/ UI-DESIGN.md の一時停止タブの一覧に消音ボタンの記述なし
- 減るもの: コンストラクタ引数3つ、ステート1つ、ボタン1つと `toggleMute`/`updateMuteState`。/ 確度: 中 / 確認: 報告のみ

---

# 第3群 — 死んだコード・到達不能な分岐(挙動不変、消すだけ)

### R32. `phaseOffsets` は値を入れる箇所が無く、常に空のまま全構築経路へ配線されている
- 症状: 天体ごとの平均黄経オフセットを受け渡す口が10以上のモジュールとセーブ形式にあるが、値は常に `{}`。
- 場所: `src/game/game.ts:172,197,203`、`src/physics/celestial-body-def.ts:115,161-176`、`src/game/celestial/celestial-system.ts:130,333`、`src/game/save/save-data.ts:291`、9系の構築関数
- 疑う理由: 唯一の生産者が `initialSave?.phaseOffsets ?? {}` で、セーブはそれをそのまま往復させるだけ。乱数も UI も書かない。全天体を暦から置く現在の方針では、平均黄経を散らす機能自体が成り立たない。
- 仕様: SAVE.md「天体暦の初期位相 — …ゲーム開始時に一度だけランダムに決まる値」だが CELESTIAL.md §2 は全天体を JPL 要素・暦パックで置くと定める → **第4群**
- 減るもの: `PhaseOffsets` 型、`planetDefForSimZero`/`satelliteDefForSimZero`/`keplerOrbitForSimZero` の phase 引数、9系の構築関数の引数、セーブ項目、`serialize()`。挙動不変。/ 確度: 高 / 確認: 自分で確認(全参照を走査。生産者は1箇所のみ)

### R33. 旧セーブ移行 `migrateLegacySave` は構造的に成立せず、毎起動走っている
- 症状: 起動ごとに `tepui.save` を読みに行くが、取り込みは絶対に成功せず `null` を返す。
- 場所: `src/launcher/save/legacy-save.ts:7,11,43`、`src/launcher/save/save-slots.ts:42`
- 疑う理由: **git で確認** — `tepui.save` を書いていた `save-manager.ts` の `SAVE_VERSION = 2`(`f6979d67^`)。現行の `readLegacy()` は `data.version === SAVE_VERSION`(=3)を要求するので必ず弾かれる。
- 仕様: SAVE.md に旧形式(単一スロット)の取り込みの記述なし
- 減るもの: モジュール1つ、`SaveSlots.load` の分岐1つ、出どころ不明の「移行データ」スロットが生まれる経路。UX 変化なし。/ 確度: 高 / 確認: 自分で確認(git archeology)

### R34. 版ゲートのせいで、セーブの optional フィールドと `??` 既定が全部到達不能
- 症状: 読み込み側が欠損に備えて既定値を持つが、`SnapshotService.load` が `version !== 3` を弾くので、欠損した形は一切入ってこない。
- 場所: `src/game/save/save-data.ts:66-67,93-94,112,114,116,131-134,199,299,301`、`src/game/player/fire-control.ts:108-109`、`src/game/player/throttle.ts:76-77`、`src/game/stages/stage-utils/logistics.ts:51-52`、`src/launcher/save/snapshot-service.ts:61`
- 疑う理由: `barrelTemperature`/`barrelDeviation`/`rcsDamp`/`progradeHold`/`fineAttitude`/`showTrajectoryLine`/`boosters`/`fuel`/`throttle`/`camera`/`navTarget`/`rcsFuelResupplyEnabled` はすべて serialize が無条件に書く。
- 仕様: SAVE.md「壊れている、または対応しない形式のスナップショットも読み込めない」— 部分欠損からの復元は書かれていない
- 減るもの: `?` と `??` が 12 組。「欠けているときは環境温度」のような二重既定が1箇所に戻る。/ 確度: 高 / 確認: 版ゲートは自分で確認、12組の網羅は報告のみ

### R35. 廃止モード・旧形式の読み替え・到達不能な分岐が型に残っている
- 症状: 以下がすべて生成・到達されないまま型と分岐に残っている。
  - `planExecution: 'powered'` と読み替え元 `followPlan`(`PlanExecutionMode` は `'off'|'instant'` のみ。`followPlan` を書き出すコードは無い)— `src/game/save/save-data.ts:106-112`、`src/game/player/player.ts:187-190`
  - 旧カメラセーブ形式 `ChaseSaveDataV1`(認識して捨てるためだけの型)と `rotatingWith: … | string` — `src/game/camera/camera-system.ts:91-93`、`src/game/camera/focus-camera.ts:78-82`、`src/game/save/save-data.ts:228-230`
  - ephemeris の `'legacy'` 状態と `isEphemerisContextCompatible`(v3 は必ず `ephemerisContext` を書く)— `src/physics/ephemeris/ephemeris-context.ts:31-38,62-83`
  - `SnapshotKind` の `'checkpoint'`(ラベル「決着」。`capture()` は `'auto'`/`'manual'` の2箇所だけ)— `src/launcher/save/slot-data.ts:9`
  - `LEGACY_PANEL_COLLAPSED_KEY` のビュー別移行(`f43e1973` の1回限り)— `src/settings/user-settings.ts:25,68-72`、`src/game/hud/hud-selection.ts:44-58`
  - `generateCluster` の `groupCount`/`perGroup`、`generateWave` の `forcedPattern`、`BoosterStack.step` の `fuelRate === 0` 無限燃焼、`WeaponPart.weaponType` の `'cannon'|'missile'`、`generatePointField` の既定引数2つ(片方は元期を畳む前の生の要素という誤った値)— `src/game/stages/spawner/enemy-spawner.ts:37-38`、`src/game/stages/stage-utils/wave-attack.ts:78`、`src/game/player/booster-stack.ts:189-192`、`src/game/celestial/solar-system/point-field.ts:231-234`
  - `BGM_TRACKS` が空のときのガード2箇所(リテラル定数で空になりえない)— `src/audio/bgm/bgm.ts:131`、`src/audio/bgm/conductor.ts:49`
  - 敵弾の弾種の二重判定(敵は `'plasma'` しか撃たない)— `src/game/dynamic/dynamic-entity/bullet-reaction.ts:61`
  - ラグランジュのヤコビ定数の二重既定値と、3つ目の質量比の正本 — `src/game/celestial/orbit-guide/orbit-guide-catalog.ts:38-45`
  - `crypto` 不在のフォールバック(WebGPU 必須=secure context なので到達しない)— `src/launcher/stage-select.ts:59-67`
- 仕様: いずれも該当の記述なし(`'powered'` は PLAN.md が「2段階の実行モード」と明言、無限燃焼は FLIGHT.md が「燃料が尽きるまで燃える」と明言)
- 減るもの: 省略可能引数6つ以上、分岐10本以上、セーブ型のフィールド4つ。挙動は変わらない。/ 確度: 高 / 確認: `SAVE_VERSION` 周りは自分で確認、個別の到達不能性は報告のみ

### R36. 未配線の足場が4モジュールある
- 症状: 定義だけがあり、どこからも import されていない。
  - `src/game/input/{game-input-router,game-actions,game-commands}.ts` — `claimedCodes` による先着消費という同じ仕組みが `src/input/input.ts:446-498` に既にある
  - `src/game/pickable/entity-inspection.ts` — `InspectedObject` と `MenuAction` が同じ役目を果たしており、語彙がほぼ丸写しで手で同期されている
  - `src/game/dynamic/{dynamic-presenter,entity-lifecycle}.ts`
- 疑う理由: 未参照 export の全量走査で確定。mikanixonable が 2026-09-11 に追加したもの。
- 仕様: CONTROLS.md は優先順位の結果だけを定め、port/router という仕組みを要求していない
- 減るもの: 約200行と型10以上。「入力の優先順位はどこで決まるか」の答えが1経路になる。/ 確度: 高 / 確認: 自分で確認(未参照を走査)/ 計画: K5 — **消すときは作者の合意を得る**。採否は手順 3-6・5-3・5-4 で決める

### R37. どこからも参照されていない export が9つある
- 場所: `src/physics/cr3bp.ts:63`(`cr3bpPropagate`)、`:117`(`sampleOrbitByArcLengthWithTime`)、`src/physics/sphere-contact.ts:42`(`sweptSagitta`)、`src/physics/ephemeris/pack-format.ts:221`(`encodeFloat64Payload`)、`src/physics/player-shape.ts:27,30`(`MAG_THICKNESS`/`MAG_WIDTH`)、`src/game/protein/protein-asset-loader.ts:128`(`isProteinAssetReady`)、`src/game/loading-progress.ts:9`(`LOADING_PHASE_WEIGHTS`)、`src/game/camera/focus-camera.ts:20`(`FOCUS_CAMERA_MIN_DIST`)
- 疑う理由: 機械検査で確定。`tests/physics` が `src/physics` を直接コンパイルすることを織り込んで `tests`/`tools` も走査対象に入れたので、「src に呼び出し元が無い」だけの誤検出ではない。
- 仕様: 該当なし
- 減るもの: 関数5つ・定数4つ。挙動不変。/ 確度: 高 / 確認: 自分で確認
- 付記: 同じ走査で「定義ファイル内でしか参照されない export」が約40件出た(多くは `interface`)。これは `export` の外し忘れで、挙動の話ではない。必要なら別途。

### R38. 索引に書くだけで誰も読まないフィールドが3つある
- 症状: スナップショットを撮るたびに `maxHp`/`magazines` が索引へ書かれるが一覧カードは表示しない。`StageHistoryMeta.clearCount` は常に 0 で、実際のクリア回数は `tepui.clearCounts`(UnlockManager)が全スロット横断で持っている。
- 場所: `src/launcher/save/slot-data.ts:24-25,35`、`src/launcher/save/snapshot-service.ts:45-46`、`src/launcher/save/save-slots.ts:170`、`src/launcher/unlock-manager.ts:6,45`
- 疑う理由: 同じ概念(クリア回数)の置き場が2つあり、片方だけが生きている。索引は全スナップショット分が1キーに載るので、容量超過の剪定頻度にも効く。
- 仕様: GAME.md「クリア回数は保存され、新たにアンロックされたステージがあればトースト通知される」— どこに属するかは書かれていない
- 減るもの: フィールド3つ。「解放は歴史線を跨ぐ」という現状の挙動が型からも読めるようになる。/ 確度: 高 / 確認: 報告のみ

### R39. 派生値を状態として保存し、整合を取り続けている
- 症状: マップ表示の「クラス全体トグル」10個と天球グリッドの `ecliptic`/`equator` は子トグルの OR として毎回計算し直されるのに、その結果も保存されている。保存値を手で壊すと UI に出せない中間状態が作れる。
- 場所: `src/game/map/display-toggles.ts:7-31,125-131`、`src/render/celestial-grid.ts:14,18,29-39,73-79`、`src/game/map/visibility-policy.ts:127`
- 疑う理由: `normalizeMapDisplayToggles`/`normalizeGridVisibility` が `children.some()` で親を上書きするので、親は常に導出値。結果 `visibility.equator && visibility.equatorPlane` のような冗長な AND が描画側に残る。
- 仕様: MAP.md「各行の見出しは、ラベル・軌道線をまとめてクラスごと表示/非表示にする**クラス全体トグル**を兼ねる」— UI の操作として定義され、独立した状態としては書かれていない
- 減るもの: 保存される boolean 12個、normalize 2関数、カテゴリ表2本、冗長 AND 5箇所。/ 確度: 中 / 確認: `display-toggles.ts` の構造は自分で確認

---

# 第4群 — 仕様ごと消す/直す候補

**仕様に書かれているが、実装を十分に無駄に複雑にしているもの。** 修正するなら `/modify-feature` で SPEC を先に直し、
`docs(spec):` の単独 commit にする。

| # | 挙動 | 仕様の位置 | 提案 |
| --- | --- | --- | --- |
| R16 | 地球の自転初期位相が乱数 | CELESTIAL.md §3、SAVE.md「保存される内容」 | IAU の地球自転角で時刻決定的にし、仕様の2文と保存項目を削る |
| R32 | 天体暦の初期位相をランダムに決める | SAVE.md「保存される内容」 | 実装が最初から満たしていない。仕様の文を削る |
| R3 | 決着後も世界は動き続ける | GAME.md §2.1 | 実装するか、仕様を「決着で止まる」へ直すか。**ユーザー判断** |
| R17-1 | 軌道基準を地球・月・ターゲットに固定できる | ORBIT.md | 登録天体から候補を引く形へ。ORBIT.md「未確定の案」の「基準天体とマップの参照フレームの統合」と合わせて進める |
| R17-3 | 月だけ衛星軌道線を常時表示 | MAP.md「ただし地球の月だけは常時例外的に表示される」 | 例外を消し、全衛星で同じ規則にする |
| R17-6 | 参照軌道は地球専用 | MAP.md「いずれも地球専用の軌道なので系の軸を持たない」 | 物理側は既に一般。仕様を実装の一般性へ進める |
| — | 一巡という長さを持たない曲ではシークできない | AUDIO.md | antipode も厳密な周期曲で、`kind==='antipode'` の case を書いていないだけ(`src/audio/bgm/track-cycle.ts:29,38`)。実装の穴を追認した文なので、仕様ごと消して全曲シーク可にする |
| — | 決着済みセーブから結果を組み立て直す | SAVE.md が自己矛盾(「決着後は保存できない」と「保存された勝敗から組み立て直す」) | 片側を落とせば `fallbackResult` と「結果の記録がありません」画面が消える(`src/launcher/launcher.ts:41-45,164-165`)/ 確度: 低 |
| — | T: RCS 回転制動の ON/OFF | CONTROLS.md の表 | 実キーは `P`。仕様と実装の両方が食い違っている(`src/input/key-mapping.ts:29`)/ 確度: 中 |

---

# 第5群 — 擬陽性寄り・判断が要るもの

確度が低い、または「無駄な複雑さ」ではなく別の種類の問題。一応挙げる。

- **R41. `lastStageId` が「直前のステージ」と「周回が進行中か」を兼ねている。** 空文字センチネル1つに2つの問いが載っていて、決着後のセーブ行が12件のスナップショットを抱えたまま「未プレイ」と表示される。`src/launcher/save/save-slots.ts:88-104`、`src/launcher/save-browser/slot-pane.ts:104`。/ 確度: 中
- **R42. CREATIVE で選んだ開始日時がスロットに残らない。** 最初の自動保存より前に再読み込みすると既定エポックへ戻る。`src/launcher/launcher.ts:109-118,179-191`。/ 確度: 中
- **R43. 基地が使えない `plan`/`planExecution`/`fineAttitude` を持つ。** `fineAttitude` は `[V]` を拾わないので常に false、`planExecution` は基地のメニューに項目が無いので `'off'` 固定。それでも軌道計画パネルは基地の `plan` を編集させる。`src/game/dynamic/dynamic-entity/base.ts:62-71,167`。/ 確度: 中
- **R44. タイトル画面で配色を変えても 3D 背景だけ追随しない。** `TitleScene` は `palette` を構築時に焼き込んで購読しない。ラン中の 3D は毎フレーム読む。UI-DESIGN.md「選択は画面へ即座に反映される」に反する。`src/launcher/title-scene.ts:333-349`。/ 確度: 中
- **R45. マーカーのサブ行の字形表が `ENTITY_GLYPH` を手で写し直している。** 敵 △ が `ascendingNode`、基地 ⬡ が `burnPoint` と衝突。MARKERS.md は中空の字形を「軌道上の点」の族と明記。`src/game/marker/celestial-sub-labels.ts:21-23`。/ 確度: 中
- **R46. マーカーの優先度の値が CSS クラス名から偶然決まっている**(コード自身の TODO)。`src/game/marker/grouped-markers.ts:24`。/ 確度: 中
- **R47. 一時停止が入れ子にならない真偽値で、2つのシステム窓が別々に書いている。** 衝突回避が「開くとき相手を閉じる」という呼び出し側の手作業だけ。`src/game/game.ts:118-119,352-357`。/ 確度: 低
- **R48. 入力の連打判定が実時刻ラッチ。** `performance.now()/1000` がモデル層にあり、時間加速と噛み合わない。`src/game/player/throttle.ts:145`。計画の K2 は「導出の入力解釈」へ移す予定。/ 確度: 低
- **R49. 被弾音が非操作の自艦の被弾でも鳴る。** 減衰が単艦前提の尺度。AUDIO.md の明文の対象は連続音だけ。`src/game/player/player.ts:466,494`。/ 確度: 低
- **R50. BGM の再生の退役が実時刻タイマー。** 待ち時間は音声時刻で計算しているのに `setTimeout` で待つので、タブを隠すと尾が切れる。`src/audio/bgm/conductor.ts:72,111`。/ 確度: 低
- **R51. 最初の周回の失敗だけ別の文言になる。** `start()` だけ `.catch(fail)` を通らない。`src/launcher/launcher.ts:96-105,207-214`。/ 確度: 低
- **R52. bgm-lab が `TrackPlayback` を二重実装している。** 「一致は検証で押さえてある」とコメントにあるが、`tests/` に Composer/TrackPlayback のテストは無い。`tools/bgm-lab/lab-player.ts:6,108`。/ 確度: 低
- **R53. モジュール寿命の採番器がランを跨いで残る。** `base.ts:48`、`pickup.ts:41-42`、`dynamic-entity.ts:18`(static)。id は増え続けるだけなので挙動は無害だが、ランの寿命の状態ではない。計画の手順 6-5 が移す予定。/ 確度: 低
- **R54(挙動の複雑さではない誤り). ヴァルナの半径が質量と整合しない。** 半径 450 km は旧直径 900 km 由来、質量は直径 654 km 由来。コード自身の TODO。衝突球・高度基準・描画サイズに直接効く。`src/game/celestial/solar-system/small-bodies.ts:211-219`。/ 確度: 中
- **R55(同). `EARTH_AURORA_OPTICS.bodyRadius: 6.371e6` が `R_EARTH` の直書き重複。** `CelestialBodies` の doc 2箇所(`ancestorsOf`・`chainFrom`)が実装と逆のことを書いている。/ 確度: 低

---

## 計画との重なり

`restructure-architecture.md` が既に手を付ける予定のもの: R1・R2(段 3)、R11(K3-1 / 手順 3-5)、R14・R53(K2 / 手順 6-5)、
R16・R32(K2 / 手順 6-4)、R18(K2)、R36(K5 — 作者の合意が要る)、R48(K2)。

**これらは「リファクタリングで置き場が変わる」予定であって、「挙動を消す」判断は別である。** 置き場を動かす前に
消すと決めたものは、動かす手間が丸ごと省ける(特に R32 は 9 系の構築関数の引数が消える)。

## 再現コマンド

```sh
grep -rn "Math.random" src --include=*.ts --include=*.tsx          # 57件
grep -rn "localStorage" src --include=*.ts                          # 保存鍵の全量は src/settings/user-settings.ts
grep -rniE "findMotion\('(earth|moon)'\)" src --include=*.ts
grep -rn "Date.now()\|performance.now()" src --include=*.ts | grep -vE "^src/(render|launcher)/"
grep -rnE "\(\s*[^)]*,\s*undefined\s*[,)]" src --include=*.ts       # 省略可能引数が不要な徴候

# 未参照 export の全量走査(数分かかる)
grep -rnoE "^export (async )?(function|class|const|let|interface|type|enum) [A-Za-z0-9_]+" \
     src --include=*.ts --include=*.tsx \
  | while IFS= read -r l; do f="${l%%:*}"; n="${l##* }"; \
      [ "$(grep -rlwF "$n" src tests tools --include=*.ts --include=*.tsx | grep -v "^$f$" | wc -l)" -eq 0 ] \
        && echo "$l"; done
```
