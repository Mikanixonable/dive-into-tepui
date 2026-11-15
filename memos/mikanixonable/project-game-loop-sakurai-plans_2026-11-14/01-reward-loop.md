# 計画 01 — 報酬ループ: 拾える撃破ドロップと、鹵獲品を積んだ補給艇

コードのスナップショット: `bbe81c893`

## 目的

撃破のご褒美を「その場で拾える・そのランの中で使える」ものにする。

- **撃破ドロップがほぼ拾えない。** ドロップは敵機の速度に ±1.5 m/s の乱れを足すだけで放たれる。
  ステージ00の敵は自機に対して 200〜400 m/s ですれ違うので、ドロップも同じ速さで遠ざかる。
  回収半径は 100 m なので、半径を横切る時間は 2×100 m ÷ 200 m/s = 1 秒以下になる。速度を
  合わせない限り拾えず、そのまま 50 km で消える。「撃つほど弾が減る → 近くで落とすほど拾いやすい」
  という駆け引きが成り立っていない。
- **鹵獲品がそのランで使えない。** 鹵獲の設計図は設計図棚へ入るだけで、ステージモードの自機は
  建造ドックを持たないため建造できない。しかも同名の設計図が棚にあれば授与されないので、2周目
  以降のランでは「あと M で鹵獲」が何も指さない。
- **授与が褒められていない。** 知らせはヒント1行で、撃墜3機の節目も25機の節目も同じ扱いになる。

### SPEC へ追記・置換する文面(手順 1 で書く)

**GAME.md 8「補給(弾薬ピックアップ)」の「撃破ドロップ」の項を置き換える:**

> - **撃破ドロップ**: 敵機を撃破(弾・剛体接触による破壊)すると、その敵機の位置へ弾薬補給を
>   1個放出する。補給の速度は、自機の速度へ「自機から見た敵機の相対速度」の 0.15 倍を足し、小さな
>   乱れを加えたものとする。**近くで落とした敵の補給ほど自機の近くを漂い、拾いやすい。** 自機が
>   いないときは敵機の速度をそのまま引き継ぐ。
> - 撃破ドロップの補給が持つマガジン数は、落とした敵の手強さで決まる。金属の敵と組み立て型の敵は 2、
>   タンパク質陣形の攻撃担当と ATP シンテターゼは 4、ルビスコは 6。自動投入・台本投入の補給は 6。
>   弾薬補給のプロパティウィンドウには、取り込むと増えるマガジン数を出す。
> - 以後は通常の補給と同じ回収・遠方消滅の規則に従う。台本投入と同じく、自動投入の可否と時間倍率の
>   条件とは無関係に、すべてのステージで起きる。焼失・天体への衝突・交戦圏離脱による消滅では
>   放出しない。

**GAME.md 3.1「鹵獲」を次のように改める:**

> - 勝敗判定を行うステージで、そのランの撃破数が 3・10・25 に達したとき、それぞれ「鹵獲: 砲座」
>   「鹵獲: 物資ポッド」「鹵獲: 強襲艇」を授与する。**授与はランごとに毎回起きる。** 設計図棚への
>   追加は、棚に同名の設計図が無いときだけ行う。
> - ステージ00では、25 機より後も 15 機ごとに「鹵獲: 物資ポッド」を授与する(40・55・70…)。
> - 授与の瞬間に、専用の効果音と、画面上部中央に鹵獲品の名前を大きく出す告知で知らせる。告知は
>   撃墜の演出と重ならないよう、授与から 0.5 秒遅らせて 3 秒間出す。
> - HUD の「あと M で鹵獲」は、補給艇が来るステージ(ステージ00)ではそのランでまだ越えていない
>   次の節目までの残りを出す。それ以外のステージでは、棚にまだ無い次の節目までの残りを出し、
>   残る節目が無ければ出さない。
> - CREATIVE とデバッグ専用ステージの撃破は数えない。設計図はカタログの既知モジュールだけで
>   組まれたもので、撃破した敵そのものの構造ではない。

**GAME.md 2.3「ステージ00」に項を足す:**

> - **補給艇**: 鹵獲を授与すると、その鹵獲品を積んだ補給艇が、次に交戦中のグループが 0 になった
>   時点で自機の軌道上 300〜500 m 前方に現れる。補給艇は健全なコックピットを持たない物資で、
>   建造ドックを1基持つ。自機は補給艇の建造ドックへドッキングして建造を始め、積荷のモジュールを
>   付け替えで自艦へ移せる(健全な建造ドックへの接続なので、修理もできる → 7.1)。
> - 補給艇が現れた波間は、次の波までの待ちを 60 秒以上に延ばす。補給艇は自然には消えない。
>   複数の授与が1つの波間に重なったときは、1隻の補給艇がまとめて積んで来る。

**AUDIO.md「同時に鳴る効果音の優先順位」の順位 3 に「鹵獲の授与」を足す。**

## 決めたこと

| 決めたこと | 根拠 | 覆されたときに変わる手順 |
| --- | --- | --- |
| ドロップの相対速度の残し率を 0.15 にする | 200〜400 m/s × 0.15 = 30〜60 m/s。交戦圏 30 km の中で追えば数十秒で届く速さで、追わなければ数分で 50 km の消滅距離へ出る。拾うには追う判断が要り、近接で落とすほど相対位置も近い | 手順 2 の定数だけ |
| ドロップのマガジン数を 2 / 4 / 6 にする | 現状の一律 6(240 発)だと1機ごとに満タン近くまで戻り、弾の残りを気にする場面が来ない。陣形の盾役は integrity が攻撃担当の 2 倍なので、報酬も最大にする | 手順 3 の表だけ |
| 補給艇はステージ00だけに出す | ステージ1・2 は敵 5 機で、建造を挟む波間が無い | 手順 5・6 の対象ステージ |
| 補給艇は積荷を軸方向に連ねた物資として組み、`attachPiece` での接ぎ木はしない | 接ぎ木には取り付け変換の計算(建造の候補探索)が要る。積荷の組み立てを `salvage-blueprints.ts` と同じ `append` / `prepend` で書けば、設計図と補給艇で同じ組み立てを共有できる | 手順 4 |
| 「鹵獲の授与」を効果音の順位 3 に入れる | 順位 4 は上限で鳴らないことがあり、ご褒美の音が消えるのはまずい | 手順 1 の AUDIO 文面と手順 7 |
| 25 機より後の節目を 15 機ごとの物資ポッドにする | 25 機を越えたあと、ステージ00では吊るす目標が無くなる。物資ポッドは弾と燃料の余力で、延命にだけ効く | 手順 5 |

## 達成目標

1. ステージ00で、すれ違いざまに 2 km 以内で撃墜した敵のドロップが、撃墜から 45 秒の間に自機から
   5 km 以内に残っている(自機は撃墜時の速度のまま、推進しない。最悪の 400 m/s × 0.15 = 60 m/s で
   2 km + 60 m/s × 45 s = 4.7 km)。`tests/game/` の単体テストで
   位置と速度を与えて確かめる。
2. ドロップのマガジン数が敵の種類ごとに 2 / 4 / 6 になり、プロパティウィンドウに出る。
3. ステージ00で撃破数 3 に達すると、次に交戦中のグループが 0 になった時点で補給艇が現れる。
   補給艇の建造ドックへドッキングして建造を始めると、砲座(装甲+機関砲)を自艦へ付け替えられる。
4. 同じセーブデータで2回目のランでも、撃破数 3 で補給艇が来る。設計図棚の「鹵獲: 砲座」は
   1件のまま増えない。
5. 授与の瞬間に専用の効果音と、画面上部中央の告知が出る。
6. `npm run typecheck`・`npm run test:game`・`npm run test:launcher` が通る。

## 手順

### 手順 1. SPEC を更新する

**目的**: 振舞いを先に確定させる(仕様はコードより先行する)。この時点で `src/` は触らない。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `DEVELOP/SPEC/GAME.md` | 8「撃破ドロップ」の置換、3.1「鹵獲」の改訂、2.3 へ「補給艇」を追記(文面は「目的」節のとおり) |
| `DEVELOP/SPEC/AUDIO.md` | 「同時に鳴る効果音の優先順位」の順位 3 に「鹵獲の授与」を足す |

**達成条件と検証**: `/modify-feature` の手順で書き、`docs(spec):` の単独 commit にする。
`git show --stat HEAD` に `DEVELOP/SPEC/` だけが出る。

### 手順 2. 撃破ドロップの速度を自機寄りにする

**目的**: 近くで落とすほど拾えるようにする。マガジン数はこの時点では変えない。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `src/game/stages/stage-utils/logistics.ts:155` `dropAt` | 引数に自機の状態 `playerState: KinematicState \| null` を足す。速度を `playerState.v + (state.v − playerState.v) × DROP_RELATIVE_VELOCITY_KEEP + randVec(1.5)` で組む。null なら従来どおり `state.v + randVec(1.5)`。定数 `DROP_RELATIVE_VELOCITY_KEEP = 0.15` を他の定数の並びへ置く |
| `src/game/stages/stage.ts:351` `recordEnemyDeath` | `this.logistics.dropAt(enemy.motion.state, this.ship?.motion.state ?? null)` に変える |
| `tests/game/` に `drop-velocity.test.ts`(新規) | 自機速度 v、敵速度 v + 300 m/s の入力で、ドロップの相対速度が 45 ± 1.5√3 m/s に収まること、自機 null で敵速度を引き継ぐことを確かめる |

**達成条件と検証**

- `npm run typecheck`・`npm run test:game` が通る。
- `grep -n "dropAt(" src -r` の呼び出しが、すべて2引数になっている。

### 手順 3. ドロップのマガジン数を敵ごとに変える

**目的**: どの敵を落とすかに意味を持たせる。補給1個が自分のマガジン数を持つようにする。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `src/game/dynamic/dynamic-entity/pickup.ts:237` `AmmoPickup` | `mags: number` を持たせる。`create` の引数に足し、直列化 `SerializedAmmoPickup` に `mags` を足す。復元時に欠けていれば 6 で補う(SAVE.md「項目が増えただけでは版を上げない」)。`supplyRows` を override して「マガジン ○」の行を出す |
| `src/game/stages/stage-utils/logistics.ts` | `AMMO_PICKUP_MAGS` を自動・台本投入の既定値として `spawnForPlayer` で渡す。`absorbNearbyAmmoPickups` は `player.onPickup(ammoPickup.mags)` と、記録 `ammoPickedUp` の `mags` に補給の値を使う。`dropAt` に `mags` 引数を足す |
| `src/game/stages/stage.ts` `recordEnemyDeath` | 敵からマガジン数を引く関数 `dropMagsOf(enemy)` を呼んで `dropAt` へ渡す |
| `src/game/stages/stage-utils/drop-mags.ts`(新規) | `dropMagsOf(enemy: Enemy): number`。`enemy.formationRole` が `'shield'` → 6、`'attacker'` / `'energy'` → 4、それ以外 2 |
| `src/game/creative/` の弾薬配置の経路(`grep -rn "AmmoPickup.create" src` で出るもの全部) | `mags` に 6 を渡す |
| `tests/game/drop-velocity.test.ts` | `dropMagsOf` の 3 区分を足す |

**達成条件と検証**

- `npm run typecheck`・`npm run test:game` が通る。
- `grep -rn "AmmoPickup.create(" src` の全呼び出しが `mags` を渡している。
- 開発サーバ(`npm run dev`)の `?stage=creative` でタンパク質陣形を生成して撃破し、ルビスコの
  ドロップのプロパティウィンドウに「マガジン 6」が出る。

### 手順 4. 鹵獲品の組み立てを、設計図と補給艇で共有できる形にする

**目的**: 積荷を補給艇へ連ねるための下ごしらえ。**この時点で挙動は変えない**(設計図の中身は
同じモジュール列のまま)。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `src/game/ship/salvage-blueprints.ts` | `gunPodPiece` / `supplyPodPiece` / `assaultCraftPiece` の組み立て部分を、`appendSalvageCargo(assembly, salvageId, anchorId, idPrefix)` として切り出す(アンカーの後ろへ軸方向に連ねる。モジュール識別子へ `idPrefix` を付ける)。設計図はこれを空の組み立てに対して呼んで作る |
| `tests/game/salvage-blueprints.test.ts` | 既存テストがそのまま通ること。`appendSalvageCargo` を2回、別の `idPrefix` で呼んで識別子が衝突しないことを足す |

**達成条件と検証**: `npm run typecheck`・`npm run test:game` が通る。`SALVAGE_BLUEPRINTS` の
各 `piece` を JSON にした文字列が、変更前と同じ(テストで固定する)。

### 手順 5. 鹵獲の授与をランごとにし、ステージ00の節目を延ばす

**目的**: 2周目以降も節目が意味を持つようにする。棚への追加は従来どおり初回だけ。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `src/game/stages/stage-rules.ts` | `StageRules` に `salvageTender: boolean` を足す。`CAMPAIGN_STAGE_RULES` は false、ステージ00専用の `SURVIVAL_STAGE_RULES`(新規の定数。`salvageRewards: true, salvageTender: true`)を足す |
| `src/game/stages/stage00.ts` | `stageRules` を `SURVIVAL_STAGE_RULES` にする(`deserializeCommonState` へ渡す規則も同じもの) |
| `src/game/ship/salvage-blueprints.ts` | `crossedSalvageMilestones(previous, kills, repeatAfter: number \| null)`(棚を見ない。25 より後は `repeatAfter` ごとに物資ポッド)と、`nextSalvageMilestoneRemaining(kills, repeatAfter)` を足す。既存の `crossedSalvageBlueprints` / `nextSalvageRemaining` は棚への追加判定と、補給艇の無いステージの HUD に使い続ける |
| `src/game/stages/stage.ts:365` `grantSalvageBlueprints` と `:259` の HUD の残り | `salvageTender` のステージでは、節目を越えるたびに記録 `salvageAwarded`(新規)を積み、棚に無いものだけ従来の `salvageBlueprintGranted` も積む。HUD の残りは `nextSalvageMilestoneRemaining` に切り替える。授与した積荷の待ち行列 `pendingSalvageCargo: string[]` を持ち、直列化する(`SerializedStage` に `pendingSalvageCargo` を足し、欠けていれば空) |
| `src/game/run-events.ts:221` 付近 | `{ kind: 'salvageAwarded'; name: string }` を足す |
| `tests/game/salvage-blueprints.test.ts` | 25 → 40 → 55 の跨ぎ、1撃破で2節目を跨ぐ場合、棚に全部ある状態でも `crossedSalvageMilestones` が返すこと |

**達成条件と検証**

- `npm run typecheck`・`npm run test:game` が通る。
- ステージ1の HUD は従来どおり(棚に全部あれば「あと M で鹵獲」が出ない)。ステージ00では
  棚の状態によらず「あと 3 で鹵獲」から始まる。開発サーバで両方を開いて目で見る。

### 手順 6. 補給艇を出す

**目的**: 鹵獲品をそのランで使えるようにする。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `src/game/ship/ship-presets.ts` | `createSalvageTenderPreset(cargoIds: readonly string[])`(新規)。根は `tank-combat-main`、側面 `side:+x` に `dock-standard`、`side:-x` に `solar-panel-standard`、積荷は根の後ろへ `appendSalvageCargo` で順に連ねる。コックピットは持たない |
| `src/game/stages/stage.ts` | `addSupplyCraft(assembly, state, name)`(新規、protected)。`ModularShip.create` して登録するが、`claimIfNone` はしない |
| `src/game/stages/stage-utils/wave-attack.ts:129` `updateActiveCombatPhase` | 交戦中のグループが 0 になったフレームで、ステージから渡されたコールバック `onLull()` を呼ぶ。戻り値が true なら `spawnTimer = Math.max(spawnTimer, STAGE00_TENDER_LULL)`(60 秒)にする。`WaveAttackStage` に `onLull(): boolean` を足す |
| `src/game/stages/stage00.ts` | `onLull()`: `pendingSalvageCargo` が空なら false。空でなければ自機の軌道上 300〜500 m 前方(`logistics.ts` の `spawnForPlayer` と同じ位相ずらし)に補給艇を `addSupplyCraft` で置き、待ち行列を空にして、記録 `salvageTenderArrived`(新規)を積み、true を返す |
| `src/game/run-events.ts` | `{ kind: 'salvageTenderArrived' }` を足す |
| `src/game/run-event-presenter.ts` | `salvageTenderArrived` でヒント「補給艇が鹵獲品を運んできた — ドックへ接続して建造 [B]」を出す |

**達成条件と検証**

- `npm run typecheck`・`npm run test:game` が通る。
- 開発サーバの `?stage=00` で 3 機落とし、波が途切れたところで補給艇が前方 300〜500 m に出る。
  マップの被選択物一覧に物資として載る。ドッキングし `[B]` で建造を始め、積荷の機関砲を自艦の
  空いている取り付け位置へ付け替えられる。切り離したあと、自艦に機関砲が2門ある。
- 補給艇を出した直後に手動セーブし、読み込み直して補給艇と積荷が残っている。

### 手順 7. 授与を褒める

**目的**: 節目の到達を、報酬にふさわしい演出で知らせる。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `src/audio/sfx/ui-sfx.ts:7` `UiSound` | `'salvage-award'` を足し、合成を書く(短い上行の和音。アタックを強く、残響を短く) |
| `src/audio/` の優先順位の実装(別作業で `bbe81c893` の SPEC を実装中のもの。`grep -rn "優先順位\|priority" src/audio` で特定する) | `salvage-award` を順位 3 に登録する。実装がまだ入っていなければ、この行は手順から外して報告する |
| `src/game/run-event-presenter.ts:286` | `salvageAwarded`(手順 5)で 0.5 秒遅らせて `notifier.toast` へ鹵獲品の名前の告知を 3 秒出し、`salvage-award` を鳴らす。`salvageBlueprintGranted` のヒントは「設計図棚にも追加した」の1行に縮める |
| `src/hud/notifier.ts` の toast の見た目(`grep -n "toast" src/hud -r` で出る CSS) | 授与の告知だけ大きく出す修飾クラスを足す。`/ui-design` を先に通す |

**達成条件と検証**

- `npm run typecheck` が通る。
- 開発サーバの `?stage=00` で 3 機目を落とした 0.5 秒後に、画面上部中央へ「鹵獲: 砲座」が出て
  3 秒で消え、専用の音が鳴る。撃墜の爆発音と重なっても両方聞こえる。

## 見積り

| 手順 | 見積り | 導出 |
| --- | --- | --- |
| 1 | 30 分 | 文面は本計画にあるので、3 か所の転記と読み合わせ 10 分 × 3 |
| 2 | 45 分 | 2 ファイル × 10 分 + 新規テスト 25 分 |
| 3 | 1.5 時間 | 直列化を伴うファイル 1 つ 30 分 + 呼び出しの付け替え 4〜5 か所 × 5 分 + 新規 1 ファイルとテスト 30 分 + 目視 10 分 |
| 4 | 45 分 | 組み立て 3 つの切り出し × 10 分 + 同一性テスト 15 分 |
| 5 | 2 時間 | 規則とステージの配線 30 分 + 節目の純関数とテスト 45 分 + 直列化 20 分 + HUD の目視 2 ステージ × 10 分 |
| 6 | 3 時間 | 補給艇の preset 30 分 + ステージ側の配置と待ち時間 1 時間 + 建造での付け替えの実機確認 1 時間(ドッキングの手操作込み) + セーブ往復 30 分 |
| 7 | 1.5 時間 | 効果音の合成 30 分 + 告知の配線 20 分 + `/ui-design` を通した CSS 30 分 + 目視 10 分 |
| 計 | 約 10 時間 | |

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 自機がいない瞬間(喪失と同フレームの撃破)に `dropAt` が自機の状態を読む | 例外で進行が止まる | 手順 2(null の分岐をテストで当てる) |
| 補給艇と自機のモジュール識別子(`main-tank` など)がドッキングで衝突する | ドッキング確定で例外、または片方のモジュールが上書きされる | 手順 6(実機でドッキングして確かめる。衝突するなら `idPrefix` を補給艇側へ付ける) |
| 古いセーブの `AmmoPickup` に `mags` が無い | 読み込みで NaN マガジンになる | 手順 3(欠けを 6 で補うテスト) |
| 補給艇の待ち 60 秒が `STAGE00_CLEARED_SPAWN_INTERVAL` の 2 秒短縮で毎フレーム潰される | 補給艇が来た直後に次の波が湧く | 手順 6(短縮は `Math.min` で効くので、延長は短縮より後で `Math.max` を掛ける順にする) |
| 授与を毎ランにしたことで、棚への追加判定まで棚を見なくなる | 同名の設計図が棚へ重複して積まれる | 手順 5(棚の追加は `crossedSalvageBlueprints` を使い続ける。2回目のランのテストで当てる) |
| 補給艇は物資なので交戦圏の外へ出ても消えないが、敵の弾には当たる | 波間に置いた補給艇が次の波で壊され、積荷が失われる | 手順 6(実機で確かめる。仕様上はそれでよい — 守るか急ぐかの判断になる) |
| 建造中はシミュレーションが止まるので、波間の 60 秒が実時間では無制限になる | 波間に何分でも考えられる | 手順 6(仕様どおり。止まっている間は敵も来ない) |
