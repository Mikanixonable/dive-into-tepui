# セーブ機能 修正・拡張計画

対象: `src/game/save-data.ts` / `src/game/save-manager.ts` / 各クラスの `serialize`・`restore` /
`src/main.ts` のセーブ配線 / `KEY_MAPPING.quickSave`・`quickLoad`。

区分 A(正しさの欠陥)・B(構造)・C(機能追加)。本計画では **A を実装対象**とし、B/C は記録に留める。

---

## A. 正しさの欠陥

### A-1. 月の位相が保存されない

`physics/ephemeris.ts` の `Ephemeris` は `phaseOffsets` の既定値を
`{ moon: Math.random() * 2 * Math.PI }` とし、ゲームごとに月の平均経度をランダム化している。
`GameSaveData` はこれを保存しないため、ロードすると月が別の位置にいる世界へ艦だけが戻る。
軌道が再現しないので、セーブ機能そのものが成立していない。

方針:
- `GameSaveData` に `phaseOffsets: Partial<Record<AttractorId, number>>` を追加する。
- `Ephemeris` は `phaseOffsets` を `private readonly` で抱えているので、読み出す口
  (`get phaseOffsets()` 相当)を用意して `SaveManager.save` が保存する。
- 復元は `Game` が `Ephemeris` を作り直す形を取らない。`ephemeris` は `EnvironmentScene` /
  `Simulator` / `OverviewCamera` / `PlanEditor` / `FocusMarkers` などに**参照で共有**されており、
  差し替えると共有先が古いインスタンスを掴んだままになる。よって `Ephemeris` 側に
  位相を書き換えるメソッドを設け、`Game.restore` がそれを呼ぶ。
- `Ephemeris` にメモ化キャッシュは無いので、位相書き換え後の無効化処理は不要。

### A-2. 復元した慣性テンソルが偽物

`player/player.ts` の `Player.restore` と `game-entity/enemy.ts` の `Enemy.restore` が
どちらも `inertia: v3(1, 1, 1)` で `Attitude` を組んでいる。実際の値はクラス固有の定数
(`PLAYER_INERTIA_PITCH/YAW/ROLL` 等)で、ロード後は姿勢ダイナミクスが別物になり、
Dzhanibekov 効果も消える。

方針: `inertia` はセーブ対象ではない(クラス固有の定数)。復元時に各クラスが持つ
正しい慣性テンソルを使う。`Player` は `progradeAttitude` が組んでいるものと同一の値を
参照できる形にし、両者に同じ数値が二重に書かれる状態を作らない。

### A-3. セーブ失敗が必ず「成功」と表示される

`SaveManager.save` は内部で `try/catch` して例外を握りつぶすのに、`main.ts` 側は
例外が飛ぶ前提で `catch` してエラー表示している。QuotaExceeded でも「セーブしました」と出る。

方針: `save(): boolean` に変更し、呼び出し側が戻り値で分岐する。`main.ts` の
`try/catch` は削除。`load` は既に `boolean` を返しているので変更しない。

### A-4. クリエイティブモードの艦が 1 隻しか保存されない

`SaveManager.save` は `game.player`(操作対象 1 隻)だけを保存する。`entities.players` は
複数持てる設計(クリエイティブモード)なので、配置した他の艦が失われる。
`Player.followPlan`(自動追従フラグ)も未保存。

方針:
- `GameSaveData.player: PlayerSaveData | null` を `players: PlayerSaveData[]` +
  `activePlayerId: string | null` に置き換える。
- `PlayerSaveData` に `followPlan: boolean` を追加。
- `Game.restore` は全艦を `addPlayer` し、`activePlayerId` に一致する艦を
  `setActivePlayer` する(該当が無ければ先頭、`players` が空なら `null`)。

### A-5. `hp`/`maxHp`/`parts` の直代入が `Ship.refreshFromParts()` を迂回する

`Player.restore` は `player.hp = data.hp` / `player.maxHp = data.maxHp` /
`player.parts = data.parts.map(restorePart)` と直代入している。parts が体力と性能の唯一の
正本という `Ship` の規約を回避しており、「船体またはコックピットが落ちたら hp=0」という
規則もバイパスされ得る。加えて `parts` の配列 identity を差し替えている(`DockView` の
交換は `splice` で identity を保つ)。

方針:
- parts を復元したうえで `refreshFromParts()` を通し、`hp`/`maxHp` はそこから導出する。
- 配列は `splice` で中身を入れ替え、identity を保つ。
- `PlayerSaveData` の `hp`/`maxHp` は parts から導出できる冗長な値なので、保存対象から外す
  ことを検討する(外す場合は `save-data.ts` からフィールドごと削除する。互換用に残さない)。

### A-6. ステージ状態が丸ごと未保存

`ScoreCounter` の撃墜数・射撃数、`Stage.phase`、stage0 のカウントダウン、stage00 の
ウェーブ機械、`Logistics` の補給タイマー。stage0/00 をロードすると別のゲームが始まる。

方針: `Stage` に `serialize()` / `restore(data)` を持たせ(`hudSubStatus` と同じく
各ステージの責務)、`GameSaveData.stage: unknown` として丸ごと格納する。基底 `Stage` が
`ScoreCounter` と `phase` と `Logistics` を、各具象ステージが自分の固有状態を担当する。

### A-7. 艦の内部状態の取りこぼし

未保存: ラジエーターの展開状態と損耗(`RadiatorSystem`)、`ThermalSystem.pendingHeat`、
`PowerSystem.charge`、スロットル段(`PlayerThrottle`)、リロードタイマー(`PlayerFire`)。
debris / casings / bullets は寿命の短い演出なので保存しない(意図的)。

方針: 上記 5 つを `PlayerSaveData` に追加する。各値の所有者は各サブシステムなので、
`Player.serialize` がサブシステムから読むのではなく、サブシステム側に
`serialize()`/`restore()` を持たせて `Player` が合成する。
ラジエーターの損耗はラジエーター**部品**の HP から導出される値なので、
`RadiatorSystem` 側では保存せず、parts の復元から自然に決まることを確認する。

### A-8. 復元後に同期されない周辺状態

`simSpeed`、表示時刻(`DisplayTimeManager`)、ビュー(`ViewManager`)、`Targeter` の
主/副ターゲット、`NavTarget`、`Docking` の選択基地。
また `Game.restore` の `this.navTarget.clearIfTargeting('')` は「空 id を渡して全解除」という
ハックで、`NavTarget` に素直な `clear()` を生やすべき。

方針:
- `NavTarget.clear()` を追加し、`clearIfTargeting('')` の呼び出しを置き換える。
- 復元時に `simSpeed` を ×1 へ、表示時刻を現在時刻へ、ターゲット類を解除へ、
  それぞれ明示的にリセットする(セーブ対象にはしない — 復元直後は「現在を見ている」
  状態が唯一妥当なため)。
- ビューは `ViewManager` の現在値を維持する(ロードはビューの遷移ではない)。

---

## B. 構造(今回は実装しない)

- B-9: `game.ts` ↔ `save-manager.ts` の相互 import と保存経路の二重化(`Game` の `F5`/`F9`
  処理と `main.ts` の設定パネル配線)。`Docking` / `MapPicker` と同じ横断関心モジュールとして
  `SaveManager` をインスタンス化し、`Game` が所有する形へ寄せる。
- B-10: Vec3/Quat/KinematicState の詰め替えが各 `serialize` に手書きされている。
  `save-data.ts` に変換ヘルパーを 1 組だけ置き、既存側もすべて置き換える。
- B-11: 死んだフィールドと不要なコメント。`EntitySaveData.kind` は書くだけで読まれない、
  `AmmoSaveData` は空の拡張、`accent: string | number` が緩い、`name?` の
  「旧セーブデータには無い」コメントは CLAUDE.md の「歴史的経緯を書かない」に反する。
- B-12: 失敗が `console.warn` のみでユーザーに出ない。`hud.hint` へ統一し、
  `console.log('Saved game state', data)` のデバッグ出力を削除。

## C. 機能追加(今回は実装しない)

- 「続きから」でのロード(タイトル画面から `stageId` に応じて起動してから復元)。
- 複数スロット + メタデータ(保存日時・ステージ・MET・自艦名)。
- オートセーブ(ドッキング時・ステージ開始時)。
- クリエイティブシーンの JSON エクスポート/インポート。
- localStorage 容量(5MB)の見張り。

---

## 実装単位とコミット

A-1〜A-8 を 4 コミットに分ける。各コミットは `npm run typecheck` を通す。
`src/physics/` に触れる A-1 のみ `npm run test:physics` も走らせる。
`src/` を変更するため、各コミットで CLAUDE.md / `DEVELOP/OWNERSHIP.md` /
`DEVELOP/CALLSTACK.md` / `DEVELOP/SPEC.md` の該当箇所を同じ変更セットで更新する。

1. **A-1 + A-2** — 月の位相と慣性テンソル。復元した世界が保存時と同じ物理になる、という一点。
2. **A-3 + A-8** — セーブ結果の伝達と復元後の周辺状態リセット。
3. **A-4 + A-5** — 複数自艦の保存と parts 正本の遵守。
4. **A-6 + A-7** — ステージ状態と艦内部状態。
