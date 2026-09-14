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

### R12. [N] 自動ワープと [X] 計画全体破棄が、仕様と逆のビューに置かれている
- 症状: [N] と「未選択の [X] で計画全体を破棄」は戦闘ビューでしか効かず、マップビューの [X] は選択ノードが無いと何も起きない。
- 場所: `src/game/view/combat-view.ts:69-84`、`src/game/plan/plan-editor.ts:178`、`src/game/view/map-view.ts:114-116`
- 疑う理由: 同じ `K.deleteNode` を2つのビューが別の意味で消費している。
- 仕様: CONTROLS.md「N … マップビュー、ノードがある場合」「X 選択中のノードを削除(未選択なら計画全体を破棄) マップビュー」
- 減るもの: `CombatView.handleInput` と `clearPlan` が消え、計画キーの窓口が `PlanEditor` 1つになる。/ 確度: 高 / 確認: 報告のみ

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
| R17-1 | 軌道基準を地球・月・ターゲットに固定できる | ORBIT.md | 登録天体から候補を引く形へ。ORBIT.md「未確定の案」の「基準天体とマップの参照フレームの統合」と合わせて進める |
| R17-3 | 月だけ衛星軌道線を常時表示 | MAP.md「ただし地球の月だけは常時例外的に表示される」 | 例外を消し、全衛星で同じ規則にする |
| R17-6 | 参照軌道は地球専用 | MAP.md「いずれも地球専用の軌道なので系の軸を持たない」 | 物理側は既に一般。仕様を実装の一般性へ進める |
| — | 一巡という長さを持たない曲ではシークできない | AUDIO.md | antipode も厳密な周期曲で、`kind==='antipode'` の case を書いていないだけ(`src/audio/bgm/track-cycle.ts:29,38`)。実装の穴を追認した文なので、仕様ごと消して全曲シーク可にする |
| — | 決着済みセーブから結果を組み立て直す | SAVE.md が自己矛盾(「決着後は保存できない」と「保存された勝敗から組み立て直す」) | 片側を落とせば `fallbackResult` と「結果の記録がありません」画面が消える(`src/launcher/launcher.ts:41-45,164-165`)/ 確度: 低 |
| — | T: RCS 回転制動の ON/OFF | CONTROLS.md の表 | 実キーは `P`。仕様と実装の両方が食い違っている(`src/input/key-mapping.ts:29`)/ 確度: 中 |

---

# 第5群 — 擬陽性寄り・判断が要るもの

確度が低い、または「無駄な複雑さ」ではなく別の種類の問題。一応挙げる。

- **R43. 基地が使えない `plan`/`planExecution`/`fineAttitude` を持つ。** `fineAttitude` は `[V]` を拾わないので常に false、`planExecution` は基地のメニューに項目が無いので `'off'` 固定。それでも軌道計画パネルは基地の `plan` を編集させる。`src/game/dynamic/dynamic-entity/base.ts:62-71,167`。/ 確度: 中
- **R44. タイトル画面で配色を変えても 3D 背景だけ追随しない。** `TitleScene` は `palette` を構築時に焼き込んで購読しない。ラン中の 3D は毎フレーム読む。UI-DESIGN.md「選択は画面へ即座に反映される」に反する。`src/launcher/title-scene.ts:333-349`。/ 確度: 中
- **R45. マーカーのサブ行の字形表が `ENTITY_GLYPH` を手で写し直している。** 敵 △ が `ascendingNode`、基地 ⬡ が `burnPoint` と衝突。MARKERS.md は中空の字形を「軌道上の点」の族と明記。`src/game/marker/celestial-sub-labels.ts:21-23`。/ 確度: 中
- **R48. 入力の連打判定が実時刻ラッチ。** `performance.now()/1000` がモデル層にあり、時間加速と噛み合わない。`src/game/player/throttle.ts:145`。計画の K2 は「導出の入力解釈」へ移す予定。/ 確度: 低
- **R49. 被弾音が非操作の自艦の被弾でも鳴る。** 減衰が単艦前提の尺度。AUDIO.md の明文の対象は連続音だけ。`src/game/player/player.ts:466,494`。/ 確度: 低
- **R50. BGM の再生の退役が実時刻タイマー。** 待ち時間は音声時刻で計算しているのに `setTimeout` で待つので、タブを隠すと尾が切れる。`src/audio/bgm/conductor.ts:72,111`。/ 確度: 低
- **R53. モジュール寿命の採番器がランを跨いで残る。** `base.ts:48`、`pickup.ts:41-42`、`dynamic-entity.ts:18`(static)。id は増え続けるだけなので挙動は無害だが、ランの寿命の状態ではない。計画の手順 6-5 が移す予定。/ 確度: 低

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
