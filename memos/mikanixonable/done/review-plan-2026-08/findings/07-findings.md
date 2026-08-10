# 章07: カメラ・マップ操作系のレビュー findings

対象: `src/game/camera/*`, `src/game/map-picker.ts`, `map-pick.ts`, `nav-target.ts`,
`view-manager.ts`, `targeter.ts`, `src/game/marker/*`, `src/game/input/{input,touch}.ts`,
`src/physics/{projection,occlusion}.ts`

## 検証結果(ベースライン)
- `npm run typecheck`: **成功**(エラーなし)
- `npm run test:physics`: **390/390 passed**(projection.test.ts 相当・occlusion 経由のテストを含む全体が green)

## Findings

### 1. [CLAUDE.md不一致] 右クリックの優先順が文書と逆転している
- ファイル: `src/game/game.ts:392-396`, `421-425`, `529-533`
- 該当コード(3箇所とも同型):
  ```ts
  this.mapPicker.handleRightClick(this.input, this.simulator.simTime);
  this.mapPicker.handleLeftClick(this.input);
  this.mapPicker.handleDoubleClick(this.input);
  this.editor.handleMapPointer(this.input);
  this.mapPicker.handleEmptySpaceRightClick(this.input, this.simulator.simTime);
  ```
- 問題: CLAUDE.md は複数箇所で明示的に「`PlanEditor.handleMapPointer` が先、`MapPicker.handleRightClick` が後」という呼び出し順で優先が表現されていると書いている:
  - L108: `...(PlanEditor.handleMapPointer → MapPicker.handleRightClick for map clicks, ...)`
  - L170: `The node-vs-context-menu split: in map mode game.ts calls PlanEditor.handleMapPointer then MapPicker.handleRightClick. The editor consumes only the right-clicks that actually hit a node, so the leftovers fall through to MapPicker.handleRightClick's own pickNearest ...`
  - L174 (map-picker.ts のエントリ内): `PlanEditor.handleMapPointer runs before this and consumes the right-clicks that hit a node, so priority is expressed purely as call order ...`
  - しかし実際の `game.ts` の呼び出し順は **`MapPicker.handleRightClick` が先、`PlanEditor.handleMapPointer` が後**(上記コード)。
- なぜ問題か: ノードのハンドル(`plan-editor.ts` の `handleNodeRightClick`)は `MapPickable` の候補集合(`this.items`)には含まれていないため、通常はノードだけを右クリックすれば `MapPicker.handleRightClick` の `pickNearest` は外れて `editor.handleMapPointer` に流れ、実害は出にくい。ただしノードが天体ラベル・近点/遠点アイコン・敵船などの `MapPickable` と画面上で近接している(`C.MAP_PICK_PX_SQ` の許容半径内に入る)状況では、現在の呼び出し順だと **`MapPicker` 側のプロパティウィンドウが先に開いてしまい、ノードの右クリックメニュー(削除・ワープ)には絶対に届かない** — 文書が明言する優先順位("editor が先")と逆の挙動になる。少なくとも文書とコードのどちらかが古い。左クリックについては `map-picker.ts` 内のコメント(`handleLeftClick` 直上)が現在の呼び出し順(`handleLeftClick` → `editor.handleMapPointer`)と一致しており、右クリックの順序だけが CLAUDE.md 側で更新されていない可能性が高い。
- 対応: 設計判断(「ノードを優先すべきか、ピック候補を優先すべきか」)が絡むため **修正はせず指摘のみ**。CLAUDE.md 側の記述を直すか、`game.ts` の呼び出し順を文書に合わせるか、いずれかを意図的に選ぶ必要がある。

### 2. [CLAUDE.md不一致] ChaseCamera が「破壊後のタンブル追従停止」を実装していない
- ファイル: `src/game/camera/chase-camera.ts:71-115`(`update` メソッド全体)、`src/game/camera/combat-camera-system.ts:82-90`
- 該当コード: `ChaseCamera.update` は
  ```ts
  update(mouse: MouseDelta, keyYaw: number, keyPitch: number, keyRoll: number, dt: number): void {
    if (!this.player) return;
    let q = this._camFollowAttitude ? qMul(this.player.att.q, this.rot) : this.rot;
    ...
    this.rot = this._camFollowAttitude ? qNormalize(qMul(qInvert(this.player.att.q), q)) : q;
    ...
  }
  ```
  で `this.player.alive` を一度も参照しない。呼び出し元 `CombatCameraSystem.update`(85-87行目)も
  ```ts
  const useGunsight = player?.alive === true && this.zoomActive;
  if (useGunsight) this.gunsightCamera.update(player);
  else this.chaseCamera.update(mouse, keyYaw, keyPitch, keyRoll, dt);
  ```
  で `alive` を見ているのは `useGunsight` の判定だけで、`chaseCamera.update` 自体は生死に関わらず毎フレーム呼ばれる。
- CLAUDE.md の記述(Controls セクション、`camFollowAttitude` の説明): 「While the ship is destroyed, ON stops folding in the ship's attitude (which would otherwise be its post-destruction tumble) and holds the last orientation instead.」および camera-system.ts の解説文にも同旨の記載がある。
- なぜ問題か: `Simulator.stepAttitudes`(`src/game/simulation/simulator.ts:123`)は `players` 配列に対して `alive` チェックなしで毎 substep 姿勢を積分する(`for (const p of this.entities.players) p.att = stepAttitude(p.att, p.torque, simDt);` — enemies/ammo は `if (e.alive)` を挟むのに players だけ素通し)。したがって撃破された自機の `att` は(トルクが偶然ゼロでない限り)引き続き変化しうる。`camFollowAttitude=true` のままだと `ChaseCamera.update` は毎フレーム `this.player.att.q` を読み続け、CLAUDE.md が明言する「破壊後は最後の向きで静止する」挙動にならず、ゴースト状態の艦の姿勢(タンブル)に視点が振り回され続ける可能性がある。
- 対応: 単純に `this.player.alive` を条件へ追加するだけでは、死亡した瞬間に「相対姿勢」から「絶対姿勢」への変換(`camFollowAttitude` セッターがやっているような re-interpretation)が行われないため、視点が瞬間的に跳ぶ副作用が出る恐れがある。**修正には設計判断(死亡検知フレームでの rot 再解釈をどう挟むか)が要るため、ここでは指摘のみに留め、コードは変更していない。**

### 3. 確認した範囲で規約違反は見つからなかった項目(参考)
- 候補集合の一元性: `MapPicker.pickables` が単一の配列として focus 解決 (`camera-system.ts` 経由の `overviewCamera.update`)・右クリック・ダブルクリック・`ObjectListPanel`・`FrameControls` すべてから同一参照で読まれている(`game.ts:556-557`, `703-727` 他)。slice して独自リストを持つ消費者は見当たらなかった。
- near/far クランプ式: `overview-camera.ts` の `near`/`far` getter は CLAUDE.md の式(`CELESTIAL_SHELL_RADIUS × cos(対角半FOV) × OVERVIEW_CAMERA_NEAR_SHELL_MARGIN` / `dist × OVERVIEW_CAMERA_FAR_RATIO` を `[FAR_MIN, FAR_MAX]` にクランプ)と一致し、`window.innerWidth/innerHeight` を毎フレーム(呼び出しごと)に読み直すため、リサイズ時の aspect/対角FOV再計算も正しく効く。
- `FocusTarget`: `'object'` の2フレーム欠落→原点(Earth 相当)フォールバック、`'point'` の毎フレーム `frameTransformAt` による焼き直し(回転フレーム追随)、`clearFocusIf` が `kind === 'object'` のみを対象にする実装、いずれも CLAUDE.md の記述どおり。
- マーカー規約: `syncMarker` のような分離公開の復活は見つからず。`hide`(固定キー: `FocusMarkers`・`NavTarget`・`EquatorNodeMarkers` の遮蔽時)と `remove`(増減キー: `GroupedMarkers`・`LeadMarkers`・`EquatorNodeMarkers` の対象消滅時)の使い分けも一貫している。`markerManager.resolveCollisions()` は `game.ts:760` で `sync()` の最後に一度だけ呼ばれている。
- `headingRotationDeg`: 全呼び出し側(`grouped-markers.ts`, `plan-display.ts`, `logistics.ts`, `creative-stage.ts`, `player-markers.ts`)が戻り値をそのまま `set`/`setPosition` の `rotationDeg` へ渡しており、`marker-manager.ts` 側で `undefined` のときに前回の回転を保持する実装(83行目)と整合している。
- Input のエッジケース: macOS Command キーの `keyup` 未配送問題への対応(`META_CODES` による `releaseAll`)、`blur`/`pagehide`/`visibilitychange` での `releaseAll`、`take*` の first-come-first-served 消費(`takeKeys`/`takeClicks`/`takeDoubleClicks`/`takeMiddleClicks`/`takeRightClicks` すべて `[...queue]` のコピーを回して `indexOf` で個別に取り除く実装)はいずれも問題なし。ダブルクリックは `dblclick` ネイティブイベント由来の独立キューであり、構成する2回の単クリック(`pointerup` 経由)とは別集計されるため、`MapPicker.handleLeftClick`(選択)と `handleDoubleClick`(フォーカス移動)が両方効くという CLAUDE.md の記述と一致する実装になっている。

## 修正について
上記2件はいずれも「ドキュメントとコードのどちらを正とするか」「死亡検知時の姿勢再解釈をどう扱うか」という設計判断を伴うため、**Edit による自動修正は行っていません**。指摘のみです。
