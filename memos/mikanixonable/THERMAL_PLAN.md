# 熱系統・装甲・デバッグモード 実装計画

作成日: 2026-08-01 / 対象ブランチ: `workspace2` / 起点コミット: `3a12d7a`
**この文書は単体で読めるように書いてある。** 前提知識なしに、何を作るのか・どこを触るのか・
どういう順で進めるのかが把握できることを目的とする。
出典要件は `memos/mikanixonable/dev.md`(人間のみ記入可)の「機体の熱系統などの修正を計画的に行いたい」節。

---

## 0. 前提（この文書を読むのに必要な最小限）

`dive-into-tepui` は TypeScript + Three.js(`WebGPURenderer`) 製の、地球低軌道を舞台にした
実寸・実時間のシューティングゲーム。この計画に関係する構造は次の6点。

1. **毎フレームは `Game.update(dt)` → `Game.sync(dt)` → `Game.render()` の3フェーズ。**
   `update` は論理状態のみを進め、THREE.js オブジェクトに触れない。`sync` は既に計算済みの
   論理状態をメッシュ・HUD DOM へ流し込む。`render` は描画呼び出しのみ。
   新しく足す処理も、この境界のどちら側かを最初に決めること。
2. **熱の現状の持ち主は `src/game/player/thermal.ts` の `ThermalSystem`。**
   `Player` が composition で保持し、`Player.checkLoss` から
   `updateAltitudeAlarm(dt, alive, alt)` を呼ぶ。内部で空力加熱(Sutton–Graves)と
   放射冷却(Stefan–Boltzmann)を積分して `hullTemp` を更新し、限界超過を
   `ThermalLimit = 'heat' | 'dynpressure' | null` として返す。**破壊そのものは
   `Player.checkLoss` 側で行う**（`alive = false` と `recordPlayerLost(reason)`）。
   この「判定は `ThermalSystem`・実行は `Player`」の分担は今回も維持する。
3. **HP は現在「磁気装甲」という名前で2箇所に出ている。**
   `src/game/hud/panel.ts`(TARGET パネル内、`t.hp/t.maxHp` のバー)と
   `src/game/stages/stage-utils/stage-status-panel.ts:39`(自機ステータス)。
   実体は `GameEntity.hp` / `maxHp` で、`Player.attacked` が
   `C.PLAYER_HIT_DAMAGE` を減算し、`Player.behave` 内の `hpRegen` が
   `C.HP_REGEN_RATE`(1 HP/s)で自然回復させる。
4. **自機モデルは実行時に組み立てていない。** `tools/export-models.mjs` の
   `buildPlayerShip()` がプリミティブを組んで `src/assets/models/player.json` に
   焼き出し、`src/render/ships.ts` は `ObjectLoader` でそれを parse して `clone(true)`
   するだけ。**モデルを変えるときは `tools/export-models.mjs` を編集して
   `npm run export-assets` を実行する**。ハルは機首 +Z、上 +Y、右舷 +X。
   `MUZZLE_OFFSETS` / `RCS_BLOCK_OFFSETS` のように、コードから位置を参照したい
   取り付け点は `ships.ts` から export する慣習になっている。
5. **右クリックは既に埋まっている。** 戦闘ビューでは射撃 + 敵のターゲットロック
   (`Targeter.handleTargetLockByRightClick`)、マップモードではノード/フォーカスの
   コンテキストメニュー。汎用ポップアップは `src/game/hud/context-menu.ts` の
   `ContextMenu`（画面座標に開き、項目クリックで `onSelect(act)`、外側クリックで自動クローズ）。
6. **ステージは `Stage` 抽象クラスの実装で、`STAGE_CLASSES` に列挙されている**
   (`src/game/stages/stage-dictionary.ts`)。`StageId` は `'00' | '0' | '1' | '2'`。
   タイトル画面は `stage-select.ts` の `selectStage()` が `STAGE_DEFINITIONS` から
   ボタンを組み立てる。`?stage=<id>` で選択画面をスキップできる。

**このプロジェクトの作業規約**（`CLAUDE.md` に全文がある。特に効くもの）:
- `src/` を変更したら**同じ変更セットで** `CLAUDE.md` / `DEVELOP/CALLSTACK.md` /
  `DEVELOP/OWNERSHIP.md` / `DEVELOP/SPEC.md` を更新する。手順は `/develop-docs`。
- 機能追加は書き始める前に `/add-feature` を通す（既存の類似実装を先に探し、
  再利用可能なら呼ぶ。切り出すなら既存側の置き換えまで同じ変更セットで行う）。
- 改名は痕跡を残さない。旧名エイリアスも「かつては〜」というコメントも残さず、
  旧名の全文検索が 0 件になるまでやる。
- コメントは `/comment` の方針（責務外に言及しない。「なにをするか」と
  非自明な理由だけ。「どう実装しているか」「以前どうだったか」は書かない）。
- 検証は既定で `npm run typecheck` のみ。`src/physics/` を触ったときだけ
  `npm run test:physics` を追加する。

---

## 1. 要件の一覧（原文の分解）

| # | 要件 | 主な影響先 |
|---|---|---|
| R1 | 敵集団が一つだけで、敵の射撃 ON/OFF を切り替えられるデバッグモードを追加。タイトル画面の小さなボタンから入る | `stages/`, `stage-select.ts` |
| R2 | 機体温度・装甲・エンジン出力等を、戦闘ビュー上部のステータスウィンドウに追加 | `stage-status-panel.ts` |
| R3 | 「磁気装甲」を「装甲」に改名し、機体の機械的損傷度を総合的に示す指標にする | HUD 2箇所 + 意味づけ |
| R4 | 射撃で機体温度が上昇し、連続射撃すると温度による機能不全でゲームオーバー | `thermal.ts`, `player-fire.ts` |
| R5 | ラジエーター展開で温度を下げられる。上下2枚、右クリックメニューで個別展開。被弾で上下別々に損傷。昼夜で効率が変わり、昼は太陽方向に垂直だと効率が上がる | 新規 `radiator.ts`, モデル, 右クリック |
| R6 | 再突入接近時に燃焼エフェクトを追加。再突入では温度死と機械的破壊死の2通り | `vfx/`, `thermal.ts` |
| R7 | 敵と 50 m/s 以上で衝突したら速度に応じて装甲がダメージを受ける | `collision.ts` ないし新規 |

---

## 2. 全体設計方針（責務の置き場所）

この計画で最も重要な判断は「熱の持ち主を誰にするか」。**現在の
`ThermalSystem`（＝空力加熱だけの担当）を、機体の熱収支全体の持ち主へ拡張する**。

```
Player
├─ ThermalSystem   … 熱収支の唯一の正本。hullTemp を持ち、毎フレーム
│                     「入る熱」と「出る熱」を合算して積分し、限界超過を判定する
│                     入: 空力加熱(既存) + 射撃による発熱(R4) + 太陽輻射
│                     出: ハル自体の放射冷却(既存) + ラジエーター放熱(R5)
├─ RadiatorSystem  … ラジエーター2枚の展開状態・展開アニメーション・損傷度を持ち、
│                     「今フレームの放熱能力 [W]」を ThermalSystem へ提供する。
│                     太陽方向・地球影の判定はここ（日陰かどうかは Ephemeris から）
└─ PlayerFire      … 発砲イベントを ThermalSystem へ通知する（熱量そのものは持たない）
```

**守るべき境界:**
- `ThermalSystem` は「温度がいくつか」「限界を超えたか」だけを答える。
  破壊の実行（`alive = false`、`recordPlayerLost`）は今まで通り `Player.checkLoss`。
- `RadiatorSystem` は放熱能力 [W] を返すところまで。温度を自分で書き換えない。
- メッシュ（ラジエーターパネルの回転）は `sync` フェーズ。展開状態の数値
  （0=収納 〜 1=全開）を `update` で進め、`sync` がそれを角度へ変換する。
- 新規 HUD 項目は `stage-status-panel.ts` の責務。`ThermalSystem` は DOM を触らない
  （現状 `Hud` を持って `hint()` を出しているのは警告トーストのためで、これは踏襲する）。

**モジュール構成の結論:**
- `src/game/player/radiator.ts` を新設（`RadiatorSystem` + `RadiatorPanel`）。
  `Player` が composition で保持し、`Player.behave` から `update`、
  `Player.syncPlayer` から `sync` を呼ぶ。既存の `thrust-effects.ts` /
  `rcs-effects.ts` と同じ立ち位置。
- 熱の定数は全て `src/game/const.ts` に置く（既存の `SG_CONST` 〜
  `HULL_TEMP_FLOOR` の並びの直後）。

---

## 3. 実装フェーズ

**各フェーズは独立してコミット可能な単位**にしてある。上から順に進めるのが安全
（R3 の改名は他より先に済ませると以降の差分が読みやすい。R5 が最大の塊）。
各フェーズ末尾の「完了条件」を満たしてから次へ進む。

---

### フェーズ 1 — 「磁気装甲」→「装甲」の改名（R3）

**難易度: 小 / 依存: なし**

1. `src/game/hud/panel.ts:224`（TARGET パネル）と
   `src/game/stages/stage-utils/stage-status-panel.ts:39`（自機ステータス）の
   ラベル文字列を `装甲` に変える。
2. `grep -r 磁気装甲 .` が **0 件**になることを確認する（`docs/` のビルド成果物は
   `npm run build` で再生成されるので手で直さない）。
3. 意味づけの変更（「機械的な損傷度を総合的に示す指標」）は**この段階では
   ドキュメントだけ**。`DEVELOP/SPEC.md` の該当記述を「装甲 = 機体の機械的損傷度の
   総合指標。被弾・高速衝突で減少し、時間で自然回復する」と書き換える。
   実際に減少要因が増えるのはフェーズ 6（R7）。

**完了条件:** `npm run typecheck` が通る / 旧名 0 件 / `SPEC.md` 更新済み。

---

### フェーズ 2 — ステータスウィンドウの拡充（R2）

**難易度: 小 / 依存: フェーズ1（ラベル名）**

対象は**戦闘ビュー上部の**パネル、つまり
`src/game/stages/stage-utils/stage-status-panel.ts`（`StageStatusPanel`）。
左側の STATS パネル（`hud/dom.ts` + `hud/panel.ts`）には既に
`動圧 Q` / `機体温度` があるので、**そちらは増やさない**（重複表示になる）。

1. `StageStatusPanel.sync(...)` の引数に温度・エンジン出力を追加する。
   現在の引数は `(hp, maxHp, message, kills, throttleIdx)`。
   引数が5個を超えるので、**ここは引数オブジェクトではなく
   `player` を1個渡す形に変える**ことを推奨（`Stage.sync` は既に `player` を
   受け取っている。`*Ctx` スナップショットを新設するのは禁止事項なので、
   スナップショットではなく `Player` 本体の参照を渡すこと）。
2. 表示項目:
   - **装甲** — 既存のバー（フェーズ1で改名済み）
   - **温度** — `player.thermal.hullTemp`。`MAX_HULL_TEMP` に対する
     比率でバー表示 + 実数値 [K]。`0.7×MAX` 超で警告色（既存の
     `warn-hot` クラス相当の見た目に揃える）
   - **エンジン出力** — `player.throttleIdx` から `弱/中/強` +
     `C.THROTTLE_LEVELS[idx]` [m/s²]。バーではなく段階表示
   - （フェーズ5以降で **ラジエーター** 行を追加する。この時点では作らない）
3. 配色は `src/game/theme.ts` の定数のみを使う。オレンジ(`ACCENT`)は
   注意喚起にだけ使う既存ルールを守る。

**完了条件:** `npm run typecheck` / 実機で戦闘ビュー上部に3項目が出る。
`CLAUDE.md` の `stage-status-panel.ts` の説明を更新。

---

### フェーズ 3 — 射撃による発熱と過熱ゲームオーバー（R4）

**難易度: 中 / 依存: フェーズ2（温度の可視化が無いと調整できない）**

1. `const.ts` に追加:
   - `GUN_HEAT_PER_ROUND` — 1発あたりの投入熱量 [J]。
2. `ThermalSystem` に発熱の受け口を作る:
   ```ts
   // 1発分の発砲熱を熱収支へ加える。
   addGunHeat(rounds: number): void
   ```
   内部では**温度を直接いじらず、そのフレームの投入熱量 [J] を貯める**。
   `updateThermal(dtSub, r, v)` の積分式で、既存の空力加熱項と同じ分母
   （`HEAT_CAPACITY`）で温度に変換して加算し、貯めた分をクリアする。
   → こうしないと `dtSub` 分割やタイムワープで発熱量が変わってしまう。
3. `src/game/player/player-fire.ts` の `fireGun`（実際に1発撃つ箇所、
   `ScoreCounter.recordShot` を呼んでいるところ）から `addGunHeat(1)` を呼ぶ。
   `PlayerFire` は `Player` を持っているので `this._player.thermal.addGunHeat(1)`。
4. **過熱ゲームオーバー**は既存の `checkThermalLimits()` の `'heat'` 分岐が
   そのまま使える。ただし喪失理由の文言が「断熱圧縮による加熱で〜」固定なので、
   `Player.checkLoss` 側で**原因を出し分ける**。→ 詳細はフェーズ7（R6の2系統死）。
   このフェーズでは既存文言のままでよい。
5. **要調整**: 連射で温度が上がるが、通常の交戦では死なない値にする。
   目安の設計値は §5 の質問 Q2 を参照。

**完了条件:** `npm run typecheck` / 連続射撃で温度計が目に見えて上がり、
撃ち続けると `MAX_HULL_TEMP` に到達して敗北する。撃つのをやめれば放射冷却で下がる。

---

### フェーズ 4 — ラジエーターのモデル（R5 前半）

**難易度: 中 / 依存: なし（フェーズ5と分けてコミットできる）**

1. `tools/export-models.mjs` の `buildPlayerShip()` に、上下2枚の
   ラジエーターパネルを追加する。**必ず名前付きの `THREE.Group` にする**
   （例: `name = 'radiatorUp'` / `'radiatorDown'`）。ランタイムで
   `getObjectByName` して回転させるため。
2. **ヒンジの取り方**: パネルは「ヒンジ位置に置いた空 Group の子」にして、
   Group を回転させれば展開する構造にする。板をそのまま回すとヒンジ位置が
   板の中心になり、収納時にハルへめり込む。
   - ヒンジ軸は機体 **X 軸**（左右方向）。上パネルは +Y 側の
     アーマーストリップ付近（`y ≈ +1.05`）、下は `-1.05`。
   - 収納時 = パネルがハルに沿って寝ている（`rotation.x = 0`）
   - 全開 = 上下へ直立して大面積を晒す（`rotation.x = ±π/2` 前後）
3. 取り付け点・寸法を `src/render/ships.ts` から export する
   （`MUZZLE_OFFSETS` と同じ慣習）:
   ```ts
   export const RADIATOR_HINGE_OFFSETS: { x: number; y: number; z: number }[]
   export const RADIATOR_PANEL_AREA: number  // 1枚の片面面積 [m²]
   ```
   `RADIATOR_PANEL_AREA` は放熱計算（フェーズ5）が使うので、
   **モデルの寸法と物理計算がここで一本化される**。
4. `npm run export-assets` を実行して `src/assets/models/player.json` を再生成する。
   **これを忘れると見た目が変わらない。**

**完了条件:** `npm run typecheck` / 実機で自機モデルに（収納状態の）
ラジエーターが見える / `src/assets/models/player.json` が更新されている。

---

### フェーズ 5 — ラジエーターの機能（R5 後半）

**難易度: 大 / 依存: フェーズ3（熱収支）+ フェーズ4（モデル）**

新規ファイル `src/game/player/radiator.ts`。

```ts
// ラジエーター1枚分の状態。
class RadiatorPanel {
  readonly side: 'up' | 'down';
  deployTarget: 0 | 1;     // 展開指示
  deploy: number;          // 実際の展開度 0..1（時定数付きで target へ追従）
  integrity: number;       // 損傷度 1=無傷 0=全損
}

export class RadiatorSystem {
  // 展開度を deployTarget へ向けて進める。
  update(dt: number): void
  // 今フレームの放熱能力 [W] を返す。
  heatRejection(sunDir: Vec3 | null, att: Attitude): number
  // メッシュのヒンジ角を展開度へ同期する。
  sync(): void
  // 上下いずれかの展開を切り替える（右クリックメニューから）。
  toggle(side: 'up' | 'down'): void
  // 被弾を受け、当たった側のパネルの integrity を減らす。
  damage(side: 'up' | 'down', amount: number): void
}
```

**放熱の計算（`heatRejection`）:**
```
1枚あたり = RADIATOR_PANEL_AREA × deploy × integrity × ε × σ × (T⁴ − T_env⁴)
            − 太陽入射   (昼のみ)
太陽入射   = SOLAR_CONSTANT × α × RADIATOR_PANEL_AREA × deploy
             × |cos(パネル法線と太陽方向のなす角)|
```
- **昼夜の判定**: 地球影に入っているかどうか。`Ephemeris` が
  `sunDirAt(t)` を持っているので、自機位置 `r` と太陽方向で
  円柱影（`dot(r, sunDir) < 0` かつ `|r − (r·ŝ)ŝ| < R_EARTH`）を判定する。
  影の中なら太陽入射 0 = 最大効率。
  → **この影判定は既に別の場所にあるかもしれない**。`/add-feature` の手順通り、
  実装前に `render/environment-scene.ts` や `earth.ts` の日照計算を検索し、
  再利用可能な形で切り出されていればそれを呼ぶ。無ければ
  `src/physics/ephemeris.ts` に純関数として追加し、既存側もそれに置き換える。
- 「昼は太陽方向に垂直だと効率が上がる」＝ パネル法線が太陽方向と直交
  （`cos ≈ 0`）のとき入射がゼロになる、で自然に表現できる。
  パネル法線は機体姿勢 `att.q` と展開角から求まる。
- `RadiatorSystem` は `Ephemeris` と `simTime` を必要とする。**`Player.behave`
  の引数に足す**（`Player.behave` のパラメータオブジェクトは規約上の例外として
  残っている survivor なので、ここへの追加は許容。新しい `*Ctx` は作らない）。

**`ThermalSystem` との接続:**
`updateThermal` の冷却項に `heatRejection` の結果を加える。
`ThermalSystem` が `RadiatorSystem` を直接持つのではなく、
**`Player` が両方を持ち、`Player` が値を渡す**（片方向依存を保つ）:
```ts
this.thermal.updateThermal(dtSub, r, v, this.radiator.heatRejection(sunDir, this.att));
```

**右クリックメニュー（展開操作）:**
- `src/game/hud/context-menu.ts` の `ContextMenu` をそのまま使う。
  `NodeGizmo` / `FocusGizmo` と同じ使い方。
- **衝突する既存操作に注意**: 戦闘ビューの右クリックは「射撃」と
  「敵のターゲットロック」に既に割り当たっている。→ §5 の質問 Q3 で
  どの操作系にするかを決める必要がある。**この決定なしにフェーズ5の
  この部分は着手できない。**
- 決定後は `Game.handleInput` の優先順位（先に取った者が消費する
  `input.takeRightClicks` 方式）に新しい消費者を1つ足す形になる。

**被弾による上下別損傷:**
- 被弾位置は `Player.attacked(bullet, simTime, stage, hitR)` の `hitR`（world 座標）
  で分かる。`hitR − state.r` を機体座標へ逆回転し、**Y 成分の符号**で
  上下どちらのパネル寄りかを決める。展開度 0 のパネルには当たらない扱いにする。
- ダメージ量は §5 の質問 Q4。

**完了条件:** `npm run typecheck` / 右クリックメニューから上下個別に展開でき、
展開すると温度上昇が鈍る / 影に入ると効率が上がる / 被弾で効率が落ちる。
`CLAUDE.md` に `radiator.ts` の項を追加、`DEVELOP/OWNERSHIP.md` に
`Player → RadiatorSystem` を追加、`DEVELOP/CALLSTACK.md` に
`update`/`sync` の呼び出し位置を追加、`DEVELOP/SPEC.md` に挙動を記述。

---

### フェーズ 6 — 高速衝突による装甲ダメージ（R7）

**難易度: 中 / 依存: フェーズ1（装甲の意味づけ）**

1. `const.ts` に追加:
   - `COLLISION_DAMAGE_MIN_SPEED = 50` — これ未満の相対速度では無傷 [m/s]
   - `COLLISION_DAMAGE_PER_SPEED` — 超過分 1 m/s あたりの装甲ダメージ
2. **どこに置くか**: `src/game/simulation/collision.ts` の
   `CollisionPhysics.resolveCollisionPair` は接触時の法線速度 `vn` を既に持っている。
   ただし `CollisionPhysics` は現在「剛体接触の解決」だけの責務で、
   ダメージという**ゲームルール**を持っていない。
   → `resolveCollisionPair` は既に「反発したか」を bool で返しているので、
   **衝突の事実と `|vn|` を呼び出し元へ通知するコールバック**を足し、
   ダメージの適用は `Player` / `Enemy` 側で行う。
   既に `onPlayerCasingImpact` という同型のコールバックがあるので、それに倣う。
   （薬莢の衝突音がこの経路を通っているのと同じ構造。）
3. 適用対象は **自機 ⇄ 敵機のペアのみ**（要件の文言通り）。
   薬莢・デブリ・補給・ベルトは対象外。
4. **50 m/s は低すぎないか要確認** → §5 の質問 Q5。
   軌道上のランデブーでは 50 m/s は「かなり速い接近」だが、
   同一軌道でない敵とすれ違う場合は数 km/s になる（＝即死）。
5. **注意**: `CollisionPhysics.resolve` は
   `SimSpeedManager.canResolvePhysicalCollisions` が true のとき、つまり
   タイムワープ ×4 以下でしか走らない。高速ワープ中は衝突ダメージも発生しない。
   これは既存の仕様として受け入れる（ワープ中は物理接触自体が無意味なため）。

**完了条件:** `npm run typecheck` / 敵に 50 m/s 超で突っ込むと装甲が減る。
`DEVELOP/SPEC.md` に数値を記述。

---

### フェーズ 7 — 再突入の燃焼エフェクトと2系統の敗北（R6）

**難易度: 中 / 依存: フェーズ3（発熱源が増えた後でないと文言の出し分けが決まらない）**

1. **2系統の敗北**は実は既に `ThermalLimit` として実装されている
   （`'heat'` = 熱防御飽和、`'dynpressure'` = 動圧による空力分解）。
   要件が求めているのは**この2つが再突入時に両方起こり得ることの明示**なので、
   まず `DEVELOP/SPEC.md` にその旨を書く。
   コード側で必要な変更は、フェーズ3で射撃発熱が入ったことによる
   **`'heat'` の原因の出し分け**:
   - 大気密度が有意（動圧 or 空力加熱がある）→「断熱圧縮による加熱で〜」
   - 大気がほぼ無い高度で温度限界 →「排熱が追いつかず機体は機能不全に陥った」
   判定は `ThermalSystem` が持つ（どちらの熱源が支配的かを知っているのはここだけ）。
   `ThermalLimit` を `'heat-aero' | 'heat-internal' | 'dynpressure' | null` に
   拡張し、`Player.checkLoss` の分岐に1本足す。
   **`ThermalLimit` の値は改名になるので、旧値の全文検索が 0 件になること。**
2. **燃焼エフェクト**: `src/game/vfx/effects-system.ts` が VFX 生成の唯一の窓口。
   `Billboard`（`render/billboard.ts`）+ 共有 `glow-texture` の既存の仕組みに乗る。
   - 発生条件: 動圧 or 空力加熱が閾値以上（`qdyn > REENTRY_GLOW_MIN_Q` 程度）。
     `ThermalSystem` が既に `qdyn` を持っているのでそれを見る。
   - 見た目: 機体の**進行方向前方**にプラズマ状の輝きを1枚。強度は
     `qdyn` に対して連続的に変化させる（閾値でパッと出ると安っぽい）。
   - 置き場所: `thrust-effects.ts` / `rcs-effects.ts` と同じ立ち位置で
     `src/game/player/reentry-effects.ts` を新設し、`Player` が持って
     `syncPlayer` から `sync` する。**`update` フェーズでは何もしない**
     （強度は `thermal` が計算済みの `qdyn` から都度導けるため状態を持たない）。
3. 「再突入が近づいているとき」の警告自体は
   `ThermalSystem.updateAltitudeAlarm` の高度しきい値警告
   （120/100/80 km、ヒステリシス付き）が既にある。**重複して足さない。**

**完了条件:** `npm run typecheck` / 近地点を下げて大気に触れると機首前方が
光り、深く入ると熱死または動圧死する / 軌道上で撃ちすぎると別文言で熱死する。
`CLAUDE.md` / `DEVELOP/*` を更新。

---

### フェーズ 8 — デバッグステージ（R1）

**難易度: 中 / 依存: なし（ただし最後に置くと上記全部の動作確認に使える）**

1. **新しい `Stage` 実装** `src/game/stages/stage-debug.ts` を追加する。
   - `static id = 'debug'` → `StageId` 型に `'debug'` を追加。
     `StageId` は `stage.ts` で `'00' | '0' | '1' | '2'` と定義されており、
     `isStageId` / `?stage=` / `restart()` / `UnlockManager` の
     クリア数キーが全てこの型に乗っている。**型を1箇所広げれば全部追随する。**
   - `STAGE_CLASSES`（`stage-dictionary.ts`）に追加する。
   - 敵集団は1つだけ。`stages/spawner/enemy-spawner.ts` の
     `generateCluster` が stage0 の訓練クラスタ生成に使われているので、
     **まずこれが再利用できるか確認する**（`/add-feature` の手順）。
     使えるならそのまま呼ぶ。
   - `isUnlocked()` は既定（常に true）のまま。
2. **敵の射撃 ON/OFF**:
   - 射撃するかどうかを決めているのは `Enemy.behave`。
     現在は `SimSpeedManager.canEnemyFire` でワープ時にのみ抑止している。
   - **フラグの置き場所**: `Stage` 側が持ち、`behaveAllEnemies` を
     override して敵へ渡すのが素直。`Enemy` に `fireEnabled` フィールドを
     足して `Stage` が書くのが最小。**グローバル変数や `Game` へのフラグ追加は避ける**
     （デバッグステージだけの関心なので、そのステージが持つ）。
   - トグル UI: `hud/buttons.ts` の `SegmentedControl` を使った小さなパネルを
     デバッグステージが自前で作る（`StageStatusPanel` と同じく `hud.root` に足す）。
     マップモードの各パネルと同じ作り方。
3. **タイトル画面の小さなボタン**:
   - `stage-select.ts` の `selectStage()` は `STAGE_DEFINITIONS` を回して
     全ステージ分の大きなボタンを作る。デバッグは**この列に混ぜない**
     （通常プレイの選択肢に見えてしまう）。
   - `STAGE_DEFINITIONS` から除外する仕組みが必要。→ `Stage` に
     `readonly hiddenFromSelect?: boolean` を足し、`selectStage` のループで
     スキップして、代わりに画面隅に小さなテキストリンク調のボタンを1つ置く。
   - `?stage=debug` でも直接入れる（`isStageId` が通るので自動的にそうなる）。

**完了条件:** `npm run typecheck` / タイトル隅のボタンからデバッグステージへ入れ、
そこで敵の射撃を ON/OFF できる。通常のステージ選択列には出ない。
`CLAUDE.md` の Current state と stages 節、`DEVELOP/SPEC.md` を更新。

---

## 4. 検証とドキュメント

- **毎フェーズ**: `npm run typecheck`。
- **`src/physics/` を触った場合のみ**: `npm run test:physics`。
  この計画で該当し得るのはフェーズ5の影判定を `ephemeris.ts` に足す場合。
  その場合は影判定の純関数に対するテストも `tests/physics/` に追加する。
- **`tools/export-models.mjs` を触ったら**: `npm run export-assets`。
- **実行時確認**: ユーザーが明示的に求めたときだけ `/verify`（ヘッドレス実行）。
- **文書**: 各フェーズの「完了条件」に書いた通り、**同じ変更セットで**
  `CLAUDE.md` / `DEVELOP/CALLSTACK.md` / `DEVELOP/OWNERSHIP.md` /
  `DEVELOP/SPEC.md` を更新する。手順は `/develop-docs`。
- **大きな変更の後**: `/comment-cleanup` で既存コメントを一括点検する
  （特にフェーズ5の後）。

---

## 5. 確認したい質問（実装前に決めたいもの）

**★ が付いたものは、それが決まらないと着手できない。**

- **★Q1（フェーズ5・操作系）— ラジエーターの右クリックメニューをどう出すか。**
  戦闘ビューの右クリックは既に「射撃 + 敵のターゲットロック」に埋まっている。
  候補:
  - (a) **自機モデルを右クリックしたときだけ**メニューを出す。他は従来通り。
    → 直感的だが、戦闘中に自機は画面中央〜下にいるので誤爆しやすい。
  - (b) **専用キー（例 `[B]`）を押しながらの右クリック**、または
    キー単発でメニューを画面中央に開く。→ 誤爆しない。
  - (c) **右クリックはやめて、上下それぞれにトグルキーを割り当てる**
    （例 `[,]`/`[.]` は使用済みなので `[Y]`/`[H]` など）。
    → 最も確実で戦闘中も使いやすいが、要件の「右クリックから表示されるメニュー」
    という文言からは外れる。
  - (d) **ステータスウィンドウのラジエーター行を右クリック**してメニューを出す。
    → HUD 上の操作なので射撃と衝突しない。要件の文言も満たす。**推奨。**

- **★Q2（フェーズ3・バランス）— 射撃発熱の強さ。**
  「連続して射撃すると温度上昇によるゲームオーバー」とのことだが、目安は?
  マガジンは 32 発、初期 3 マグ = 96 発。
  - (a) **1マガジン（32発）を連射しきると危険域(0.7×1300K)に入り、
    2マガジン目の途中で死ぬ** — かなり厳しい。射撃管理が主要な駆け引きになる。
  - (b) **ラジエーター全開なら撃ち続けられるが、収納状態だと1.5マガジンで死ぬ** —
    ラジエーターに存在意義が出る。**推奨。**
  - (c) **弾を撃ち尽くしても死なない程度**（温度は上がるが警告止まり）。
    → 「ゲームオーバーを追加する」という要件を満たさない。
  また、**放置してどれくらいで冷えるべきか**（10秒? 60秒?）も併せて決めたい。

- **Q3（フェーズ5・バランス）— ラジエーター全開時の放熱能力。**
  ハル自体の放射冷却面積は現在 `RAD_AREA = 70 m²`。
  ラジエーター2枚全開でこれに対しどれくらい上乗せするか。
  - (a) 2枚で `+70 m²`（＝全開で冷却能力が2倍）
  - (b) 2枚で `+140 m²`（＝全開で3倍。ラジエーターが主役になる）
  実際の宇宙機では放熱面積は機体表面積より大きいのが普通なので (b) 寄りが
  現実的だが、これは Q2 の答え次第。

- **Q4（フェーズ5）— ラジエーター損傷の量と回復。**
  - 被弾1発で `integrity` がどれだけ減るか（例: 0.25 = 4発で全損）。
  - **損傷は回復するか?** 装甲(HP)は `HP_REGEN_RATE` で自然回復する。
    ラジエーターも同様に回復させるか、それとも**戦闘中は回復しない**
    （＝損傷が蓄積して撤退圧力になる）か。後者のほうが緊張感は出る。
  - **収納すれば被弾しないのか?**（＝展開度 0 なら無敵）。
    そうすると「戦闘中は畳んで熱を溜め、間合いを取ったら開いて冷やす」
    という駆け引きが生まれる。**これは面白いので推奨したい。**

- **Q5（フェーズ6）— 高速衝突ダメージのスケール。**
  50 m/s から装甲が減るとして、何 m/s で即死（装甲全損）にするか。
  - (a) 200 m/s で全損 — 衝突は基本的に致命的
  - (b) 500 m/s で全損 — 軽い接触事故が成立する
  なお異なる軌道の敵とのすれ違いは数 km/s になるため、どちらでも即死になる。
  **接近戦（ステージ0）で意図的にぶつかる遊びを許すかどうか**が判断軸。

- **Q6（フェーズ8）— デバッグステージの位置づけ。**
  - リリース版（`docs/` への `npm run build`）にも含めるか、
    それとも開発時だけ（`?debug=1` が無いとタイトルにボタンが出ない等）か。
  - デバッグステージのクリアを `UnlockManager` の記録に含めるか
    （含めない方がよいと思われる — 他ステージの解放条件を汚さないため）。

- **Q7（全体）— 「エンジン出力」の意味。**
  フェーズ2の表示項目「エンジン出力」は、現状の
  `throttleIdx`（並進出力の弱/中/強）を指しているという理解でよいか。
  それとも**新しく推進剤/電力のような消耗リソースを導入する**含みがあるか。
  後者なら別途大きな設計が必要なので、この計画からは切り離したい。

---

## 6. 提案（要件に無いが、併せて検討したいもの）

- **温度の警告音を段階化する。** `Sfx` には既に `altAlarm()` があり、
  高度警告で鳴っている。射撃過熱は「気づかないうちに死ぬ」事故になりやすいので、
  危険域（0.7×MAX）到達時に専用の警告音を1回鳴らすことを推奨する。
  `ThermalSystem.checkThermalLimits` に既にヒステリシス付きの
  「危険域に入ったら1回だけ」の判定があるので、そこに `_sfx` の呼び出しを足すだけ。

- **温度が高いと射撃レートが落ちる、という中間ペナルティ。**
  現状の設計だと「限界に達するまで無害、達したら即死」で、二値的すぎる。
  例えば `0.8×MAX` を超えたら発射間隔を伸ばす、あるいはリロードが遅くなる、
  といった連続的なペナルティがあると、プレイヤーが温度計を見る動機になる。
  要件外なので必須ではないが、R4 の「機能不全」という言葉はこれを含意している
  かもしれない（→ Q2 とセットで判断したい）。

- **ラジエーターは推力と干渉させる。** 現実の宇宙機のラジエーターは
  展開状態で大きな加速をかけると構造的に危ない。「展開中は並進出力が
  中までに制限される」といった制約を入れると、熱管理と機動が
  トレードオフになって設計が締まる。ベルトの慣性力シミュレーションが既にあるので、
  演出面でも整合する。

- **`ThermalSystem` の分割は今回はしない。** 熱源が3つ（空力・射撃・太陽）に
  増えるが、いずれも「1フレームの投入熱量 [J] を出す」だけの数式なので、
  クラスを分けるほどの責務は無い。1つの `updateThermal` の中で合算するのが
  読みやすい。将来 4つ目以降が増えたときに再検討する。

- **フェーズ8を先に作ることも検討に値する。** デバッグステージ（敵1集団・
  射撃 OFF 可能）があると、フェーズ3〜7 の熱・衝突の挙動を安全に検証できる。
  上記の順序は依存関係の少なさで並べてあるが、**実際の作業効率では
  フェーズ1 → 8 → 2 → 3 → 4 → 5 → 6 → 7 の順が良い可能性がある。**
