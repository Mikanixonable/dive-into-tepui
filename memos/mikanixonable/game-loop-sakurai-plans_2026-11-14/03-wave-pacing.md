# 計画 03 — 波の起伏: 組成表、ボス波と息抜きの波、敵の型ごとの性格

コードのスナップショット: `bbe81c893`

## 目的

ステージ00の波は、機数が 5 + 2 × (波 − 1)、相対速度が 200 + 10 × (波 − 1) m/s の一次関数で
強くなるだけで、攻め方を考え直させる場面が来ない。強さが一直線の坂は作業になる。難関と平地を
交互に置き、難関は「周りより強い」ではなく「攻略を考えさせる困難」にする。

- **難関**: タンパク質陣形(盾役のルビスコ・供給役の ATP シンテターゼ・攻撃担当)をボス波として
  混ぜる。陣形は「供給役を落とせば攻撃担当が黙る」という攻略の答えを持っているのに、いまは
  CREATIVE でしか出ない。
- **平地**: ボス波の直後に、機数も速度も落とした息抜きの波を置く。
- **敵を一言で言える性格に**: いまの金属の敵は型(`typeIndex` 0〜2)で形と接触半径が違うだけで、
  射撃は全型が同じ定数で動く。型ごとに射撃の性格を持たせ、形を見れば戦い方が決まるようにする。

### SPEC へ追記・置換する文面(手順 1 で書く)

**GAME.md 2.3「ステージ00」の「1 波の機数」と「フライパス速度」の項を置き換える:**

> - **波の組成**: 10 波で一巡する組成表で決める。一巡するたびに、表の機数を +2、相対速度を
>   +20 m/s して繰り返す(1 波の上限 30 機、相対速度の上限 400 m/s)。
>
>   | 波 | 種類 | 金属の敵 | タンパク質陣形 | 相対速度 |
>   | --- | --- | --- | --- | --- |
>   | 1 | 通常 | 5(標準) | — | 200 m/s |
>   | 2 | 通常 | 6(標準 4・突撃 2) | — | 210 m/s |
>   | 3 | 通常 | 8(標準 4・突撃 2・狙撃 2) | — | 220 m/s |
>   | 4 | 通常 | 9(標準 3・突撃 3・狙撃 3) | — | 230 m/s |
>   | 5 | **ボス** | 2(標準) | 1 組 | 180 m/s |
>   | 6 | 息抜き | 3(標準) | — | 170 m/s |
>   | 7 | 通常 | 10(突撃 5・狙撃 5) | — | 240 m/s |
>   | 8 | 通常 | 11(標準 3・突撃 4・狙撃 4) | — | 250 m/s |
>   | 9 | 通常 | 12(標準 4・突撃 4・狙撃 4) | — | 260 m/s |
>   | 10 | **ボス** | 0 | 2 組 | 200 m/s |
>
> - タンパク質陣形は、波の中心に置いた攻撃担当を挟んで、ルビスコを自機側へ、ATP シンテターゼを
>   反対側へ 450 m 離して置く(陣形の規則は COMBAT.md)。陣形の3機も、その波の1グループとして
>   交戦中のグループ数に数える。
> - **ボス波の報酬**: ボス波の全機が撃破で失われる(焼失・衝突・交戦圏離脱を含まない)と、自機の
>   軌道上前方に弾薬補給を2個、台本投入する。
> - 息抜きの波の後は、次の波までの待ちを 45 秒にする。

**COMBAT.md「AI と射撃」に項を足す:**

> - 金属の敵は型ごとに射撃の性格を持つ。形を見れば戦い方が分かるようにするため。
>   - **標準型**: 1.0 秒ごとに射撃の機会を持ち、3・5・7・20 発のいずれかのバーストを撃つ。
>   - **突撃型**: 0.6 秒ごとに機会を持ち、3・5 発の短いバーストを撃つ。8 km より遠い相手には撃たない。
>   - **狙撃型**: 2.0 秒ごとに機会を持ち、7・20 発の長いバーストを撃つ。散布角は標準型の半分。
>     2 km より近い相手には撃たない。
> - 型に属さない金属の敵(漂う敵)と、タンパク質型・組み立て型の敵は標準型と同じ射撃をする。

## 決めたこと

| 決めたこと | 根拠 | 覆されたときに変わる手順 |
| --- | --- | --- |
| 10 波一巡の表にし、一巡ごとに機数 +2・速度 +20 m/s | 数式で増やすより、表で起伏を描くほうが調整しやすい。一巡後の上乗せは現状の増え方(10 波で +20 機・+100 m/s)よりずっと緩い。代わりに型の混ぜ方で強さを出す | 手順 3 の表だけ |
| ボス波の報酬は弾薬補給 2 個の台本投入にする | 他の仕組みに依存せず、この計画だけで完結する。ボス後の息抜きの波で拾いに行ける | 手順 4 |
| 型と性格の対応は typeIndex 0 = 標準、1 = 突撃、2 = 狙撃 | 型はすでに形と接触半径が違うので、見た目の区別はすでにある。どの形がどの性格に合うかは、手順 5 の目視で入れ替えてよい | 手順 5 の対応表だけ |
| 狙撃型の「近い相手に撃たない」は 2 km | 近づかれると弱い、という短所を持たせ、突っ込む攻略を生む(長所を伸ばし、短所も伸ばす) | 手順 5 の定数だけ |

## 達成目標

1. ステージ00の第5波に、タンパク質陣形 1 組と金属の敵 2 機が出る。第10波に陣形 2 組が出る。
2. ボス波の陣形が実体化する前(アセットの読み込み待ち)に、交戦中のグループ数が 0 と数えられず、
   次の波が早まらない。
3. ボス波の全機を撃破すると、弾薬補給が 2 個、自機の前方に出る。
4. 第6波は金属の敵 3 機・相対速度 170 m/s で、その後の待ちが 45 秒になる。
5. 突撃型は 8 km より遠くでは撃たず、狙撃型は 2 km より近くでは撃たない。
6. 手動セーブを第5波の途中で取って読み込み直しても、波数・組成・陣形の役割が保たれる。
7. `npm run typecheck`・`npm run test:game` が通る。

## 手順

### 手順 1. SPEC を更新する

**目的**: 振舞いを先に確定させる。この時点で `src/` は触らない。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `DEVELOP/SPEC/GAME.md` | 2.3 の「1 波の機数」「フライパス速度」を「波の組成」以下の文面で置き換える |
| `DEVELOP/SPEC/COMBAT.md` | 「AI と射撃」に型ごとの射撃の性格を足す |

**達成条件と検証**: `/modify-feature` の手順で書き、`docs(spec):` の単独 commit にする。

### 手順 2. タンパク質陣形を波に属させる

**目的**: 陣形を波のグループとして数えられるようにする。**この時点で波の組成は変えない。**

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `src/game/dynamic/dynamic-entity/protein-enemy.ts:43` `ProteinEnemyRequest` | `waveId: number \| null` を足す(欠けた古い記録は null で読む) |
| `src/game/dynamic/dynamic-entity/protein-enemy.ts:161` | `waveId: request.waveId ?? null` にする |
| `src/game/stages/spawner/enemy-generator.ts:57` `proteinFormationRequests` | 引数 `waveId: number \| null` を足して各要求へ入れる |
| `src/game/creative/manual-spawn.ts:116` | `waveId: null` を渡す |
| `src/game/dynamic/entity-lifecycle.ts:99` 付近 | 実体化待ちの要求が持つ `waveId` の一覧を返す読み口 `pendingEnemyWaveIds` を足す。`src/game/dynamic/dynamic-system.ts:132` と `entity-registry.ts:28` に同名の読み口を通す |
| `src/game/stages/stage-utils/wave-attack.ts` `countActiveWaveGroups` | 生存中の敵の `waveId` に、実体化待ちの `waveId` を足して数える。`update` の引数で受け取る |

**達成条件と検証**

- `npm run typecheck`・`npm run test:game` が通る。
- `grep -rn "proteinFormationRequests(" src` の全呼び出しが `waveId` を渡している。
- `tests/game/` に `wave-groups.test.ts`(新規): 生存 0 機・実体化待ち 3 件(同じ waveId)で
  グループ数 1 を返す。

### 手順 3. 波を組成表から作る

**目的**: 一次関数の坂を、10 波一巡の表に置き換える。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `src/game/stages/stage-utils/wave-composition.ts`(新規) | 組成表 `WAVE_TABLE`(10 行。種類・型ごとの機数・陣形の組数・相対速度)と、`waveComposition(wave): WaveComposition`(一巡ごとの上乗せと上限 30 機・400 m/s を適用)。純関数 |
| `src/game/stages/stage-utils/wave-attack.ts` | `STAGE00_WAVE_BASE_SHIPS` / `STAGE00_WAVE_SHIPS_PER_WAVE` / `STAGE00_FLYBY_SPEED` / `STAGE00_FLYBY_SPEED_RAMP` を消し、`generateWave` と `makeFlybyVelocity` を `waveComposition` から作る。金属の敵は型ごとの機数を並べて `generateApproachingEnemy` に `typeIndex` を1機ずつ渡す。陣形は波の中心から `proteinFormationRequests(…, wave)` で要求し、`WaveAttackStage` に足す `addProteinEnemy(request)` で登録する。息抜きの波を湧かせたら `spawnTimer` を 45 秒にする |
| `src/game/stages/stage.ts:312` `addProteinEnemy` | `WaveAttackStage` から呼べるよう public にする(ステージ00の `addEnemy` と同じ扱い) |
| `tests/game/wave-composition.test.ts`(新規) | 第1・5・6・10・11・15・50 波の組成、上限の適用 |

**達成条件と検証**

- `npm run typecheck`・`npm run test:game` が通る。
- `grep -n "STAGE00_WAVE_SHIPS_PER_WAVE\|STAGE00_FLYBY_SPEED_RAMP" src -r` が 0 件。
- 開発サーバの `?stage=00` で第5波まで進め、マップの被選択物一覧にタンパク質の敵 3 体が
  そろって載る。HUD の「第5波」の表示が正しい。

### 手順 4. ボス波の報酬

**目的**: 難関を越えたことに、相応の報酬を出す。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `src/game/stages/stage-utils/wave-attack.ts` | ボス波の番号ごとに「出現数・撃破数・撃破以外の喪失数」を持つ表 `bossWaveTally` を足し、直列化する(`SerializedWaveAttack` に足し、欠けていれば空)。`noteEnemyDeath(waveId, cause)` で数え、全機が撃破で失われた瞬間に一度だけ true を返す |
| `src/game/stages/stage00.ts` | `recordEnemyDeath` を override し、`super` の後に `waveAttack.noteEnemyDeath(enemy.waveId, cause)` を呼ぶ。true なら `logistics.spawnForPlayer(player, LOGISTICS_SCRIPTED_MIN_DIST, LOGISTICS_SCRIPTED_MAX_DIST)` を 2 回呼び、記録 `bossWaveCleared`(新規)を積む |
| `src/game/run-events.ts` | `{ kind: 'bossWaveCleared'; wave: number }` を足す |
| `src/game/run-event-presenter.ts` | `bossWaveCleared` でヒント「第 N 波の陣形を撃破 — 補給が届いた」を出す |
| `tests/game/wave-composition.test.ts` | 3 機中 2 機撃破 + 1 機焼失で true にならないこと、3 機撃破で 1 回だけ true になること |

**達成条件と検証**

- `npm run typecheck`・`npm run test:game` が通る。
- 開発サーバで第5波の全機を落とすと、ヒントが出て前方に補給が 2 個増える。

### 手順 5. 金属の敵の型ごとの射撃の性格

**目的**: 形を見れば戦い方が分かるようにする。

**変更が必要な箇所**

| ファイル | すること |
| --- | --- |
| `src/game/dynamic/dynamic-entity/enemy-fire-profile.ts`(新規) | `EnemyFireProfile`(射撃間隔・バースト弾数の候補・散布角の倍率・撃つ最短/最長距離)と、`STANDARD` / `ASSAULT` / `SNIPER` の3つ、`fireProfileOfType(typeIndex: number \| null)` |
| `src/game/dynamic/dynamic-entity/enemy-fire-controller.ts:18-24` | `ENEMY_FIRE_INTERVAL` / `ENEMY_BURST_COUNTS` / `PLASMA_SPREAD_DEG` / `ENEMY_AI_MIN_RANGE` の参照を、ポートから受け取る `profile` の値へ置き換える(`:85`・`:100`・`:101`・`:105`・`:127`)。最長距離は `min(ENGAGEMENT_RANGE, profile.maxRange)` |
| `src/game/dynamic/dynamic-entity/enemy.ts:191` | `EnemyFireController` のポートへ `profile` を渡す。値は `protected fireProfile(): EnemyFireProfile`(既定 `STANDARD`)から取る |
| `src/game/dynamic/dynamic-entity/metal-enemy.ts` | `fireProfile()` を override し、`fireProfileOfType(this.typeIndex)` を返す(`typeIndex` が null なら STANDARD) |
| `tests/game/` に `enemy-fire-profile.test.ts`(新規) | 型 0/1/2/null の対応と、各型の距離の条件 |

**達成条件と検証**

- `npm run typecheck`・`npm run test:game` が通る。
- `grep -n "ENEMY_FIRE_INTERVAL\|ENEMY_BURST_COUNTS" src -r` が `enemy-fire-profile.ts` だけに出る。
- 開発サーバの `?stage=00` で第3波を待ち、10 km 先から撃ってくるのが狙撃型の形だけで、
  近づくと狙撃型が撃ち止む。

## 見積り

| 手順 | 見積り | 導出 |
| --- | --- | --- |
| 1 | 30 分 | 2 か所 × 15 分(表の転記込み) |
| 2 | 1.5 時間 | 要求型の変更と呼び出し 3 か所 × 10 分 + 実体化待ちの読み口 3 ファイル × 10 分 + テスト 30 分 |
| 3 | 3 時間 | 組成表と純関数とテスト 1.5 時間 + 生成の書き換え 1 時間 + 目視(第5波まで約 5 波 × 40 秒 ≈ 4 分、×3 回) 30 分 |
| 4 | 1.5 時間 | 集計と直列化 45 分 + ステージ側 20 分 + テストと目視 25 分 |
| 5 | 2 時間 | 新規の性格表 30 分 + 射撃制御の置き換え 5 か所 × 10 分 + 継承の配線 20 分 + テストと目視 20 分 |
| 計 | 約 8.5 時間 | |

## リスクと落とし穴

| リスク | 影響 | 露見する場所 |
| --- | --- | --- |
| 陣形の実体化待ちの間、グループ数が 0 と数えられる | 波の待ちが 2 秒へ短縮され、ボス波と次の波が重なる | 手順 2(実体化待ちを数えるテスト) |
| 陣形の要求は要求時の位置・速度を持つので、実体化が遅れると古い位置に出る | 自機の近くを素通りした後に出る、または自機に重なって出る | 手順 3(開発サーバで第5波を目視。遅れが目立つなら要求の直前にアセットを先読みする) |
| ボス波の撃破数の集計を直列化し忘れる | 第5波の途中でセーブ・読み込みすると報酬が出なくなる | 手順 4(セーブ往復を目視) |
| 一巡後の上乗せで、機数より先に相対速度が上限 400 m/s に張り付く | 張り付いた後は機数しか増えない | 手順 3(表の最大 260 m/s + 20 × 巡 ≥ 400 は 7 巡を足した 8 巡目(第 79 波)、表の最大 12 機 + 2 × 巡 ≥ 30 は 9 巡を足した 10 巡目(第 99 波)。第 79・99 波をテストで固める) |
| 狙撃型の散布角を半分にすると、逆光の規則(`sunGlareSpreadScale`)と掛け合わせた値が順光で極端に締まる | 順光の狙撃型が実質必中になる | 手順 5(順光での散布角 = 0.05° × 0.5 × 0.5 = 0.0125° を、30 km 先で 6.5 m の散りとして確かめ、強すぎれば倍率を 0.7 にする) |
| `addProteinEnemy` を public にすると、他のステージからも陣形を足せる | 意図しない経路で敵が増える | 手順 3(呼び出しを `grep -rn "addProteinEnemy(" src` で確かめ、ステージ00と CREATIVE 以外に無いこと) |
