# ドッキング実装調査：指摘・修正方針

調査日: 2026-09-20  
基準コミット: `96c50b266`
対象: `/Users/pandeaconica/lab/dive-into-tepui`

## 調査範囲

`ShipAssembly` の接続グラフ、`ModularShip` の統合・切り離し、ドッキング可否判定、建造ドラフト、保存復元、入力境界、モジュール UI、関連仕様を確認した。

現在の主経路は次のとおり。

```text
ModuleWindows.dockNearest
  -> dockingEligibility
  -> ModularShip.dock
  -> ShipAssembly.mergedAtDock
  -> assembly / motion / selection の更新

ModuleWindows.undockModule
  -> ModularShip.undock
  -> separateConnection
  -> ShipAssembly.splitAt
  -> 分離船の生成・registry 登録
```

確認済みの検証は `npm run typecheck`、`npm run test:game`。後者は 296/296 通過したが、entity 単位の `dock/undock` 統合テストは不足している。

## P0: 修正対象のバグ

### P0-1. 重い側固定と運動状態の統合が仕様と違う

`ModularShip.dock()` は常に呼び出し元の `this` を残し、相手をその assembly へ統合している。また速度を両船の質量平均にしている。

- 実装: `src/game/ship/modular-ship.ts:412-442`
- 仕様: `DEVELOP/SPEC/GAME.md:155-161`、`CONTEXT.md:63-65`

仕様は次のとおり。

- 現在質量が大きい側を固定する。
- 小さい側を接続面・接続軸へ完全にスナップする。
- 同質量ならドッキング操作を開始した側を固定する。
- 接続後は相対運動を残さない。
- 大きい側の操作基準 cockpit を採用し、健全でなければ反対側の選択を使う。

修正方針:

- 操作開始側を引数上の initiator として扱い、質量比較で anchor を決める。
- anchor の world pose を維持し、反対側の assembly を anchor のポートへスナップする。
- anchor の cockpit 選択を優先し、必要なら相手側の cockpit ID を remap して採用する。
- 操作対象が軽い側だった場合は、重い側へ ControlSelection を移してから軽い側を registry から除去する。
- 速度・角速度の確定方法は、重い側の運動を連続させ、接続後の一体剛体に相対運動を残さない。

### P0-2. 建造中に操縦入力が漏れる

`gameInputMode()` は建造中に world input を止めるが、`handleInput()` はその後 `pilotPorts` を無条件で処理する。`pilotInput.actionPort` にも建造中の有効条件がない。

- 実装: `src/game/game-presentation.ts:297-324`
- 実装: `src/game/input/game-input-ports.ts:89-98`
- 実装: `src/game/input/pilot-input.ts:98-105`
- 仕様: `DEVELOP/SPEC/CONTROLS.md`「キー入力の優先順位」

建造中に許可するのは、カメラ回転・ズーム、建造 UI、ESC だけとする。推進、姿勢、射撃、時間加速、ターゲット、ビュー変更、通常 HUD 操作は遮断する。

### P0-3. ドッキング対象側の状態を無言で失う

統合時に移管されるのは `dockedVessels` の identity だけで、相手側の建造ドラフト、操作基準 cockpit、その他の entity 状態が移管されない。切り離し時も新しい船は assembly だけで生成され、`dockState` と `operatingCockpitId` が初期化される。

- 実装: `src/game/ship/modular-ship.ts:436-440`
- 実装: `src/game/ship/modular-ship.ts:488-499`
- 保存仕様: `DEVELOP/SPEC/SAVE.md:58-62`

修正方針:

- docking merge で、相手側の draft を module/connection ID 対応表に従って移管する。
- connection split / decoupler split では、各 draft を所属 assembly へ分配する。
- 分離船の `operatingCockpitId` を remap して復元する。
- 既存の module 状態（HP、燃料、点火、展開、温度）は assembly の移管で保持する。
- entity にしか存在しない一時操作状態（押下、ラッチ、射撃継続など）は統合時に継続させず、安全に解除する。弾薬・熱・電力などを複数 entity から一つへ統合する細則は追加仕様候補として残す。

## P1: 修正対象のバグ・実装漏れ

### P1-1. undock に分離速度がない

`separateConnection()` は重心変更と角速度由来の速度だけを計算し、分離インパルスを与えていない。仕様は分離速度を質量比で配り、並進運動量を保存する。

- 実装: `src/game/ship/modular-ship.ts:464-519`
- 仕様: `DEVELOP/SPEC/ORBIT.md:151-155`
- 再利用候補: `src/game/ship/ship-decoupling.ts:44-57`

ドッキング切り離しにも同じ分離速度モデルを使い、既存の衝突猶予と一体で扱う。

### P1-2. `dock` と `docking_port` の能力境界が不一致

仕様上、`dock` は `docking_port` の上位互換で、建造・修理可能。`docking_port` は接続専用である。

- 用語仕様: `CONTEXT.md:35-41`
- 両方を受け入れる実装: `src/game/ship/ship-dock-state.ts:27-38`
- 両方を修理可能にする実装: `src/game/ship/ship-repair.ts:4-20`
- 保存復元は `dock` のみ: `src/game/ship/ship-save.ts:175-188`

開始、再開、修理、保存復元、UI、テストを `dock` 限定へ統一する。ポートを建造・修理可能にするなら、先に仕様を反転させる必要がある。

### P1-3. 建造枝を不正な docking edge に昇格できる

`promoteConnectionToDocking()` は親側が dock/port であることしか検証しない。子側が tank や cockpit でも docking edge にできる。一方、仕様上の docking edge は port/dock 同士である。

- 実装: `src/game/ship/ship-assembly.ts:206-219`
- 不足している検証: `src/game/ship/ship-assembly.ts:510-543`
- 仕様: `CONTEXT.md:97-98`

建造枝の根元を切り離せる仕様を維持するなら、`docking` とは別の detachable construction edge を設ける。既存 edge を docking として扱うなら、両端を dock/port に限定する。

### P1-4. 保存ドラフト検証が浅い

`restoreConstructionDrafts()` は ID の存在を確認するだけで、`addedIds` の重複、ドラフト間の共有、dock から伸びる同一枝か、`firstConnectionId` と `axialTailId` の関係、dock/side/docking 境界を検証しない。

- 実装: `src/game/ship/ship-save.ts:170-188`

`restoreDockedVessels()` も「docking edge と identity が一対一」とコメントしているが、全 edge に record があることを要求していない。

- 実装: `src/game/ship/ship-save.ts:191-205`

不正な保存データは部分的に公開せず決定的に拒否し、正常な建造途中と接続 identity は round-trip できるようにする。

### P1-5. 最寄りポートを自動選択して即接続する

`dockNearest()` は条件を満たす候補のうち最短を自動選択し、直ちに `dock()` を呼ぶ。

- 実装: `src/game/pickable/module-windows.ts:194-220`
- 仕様: `DEVELOP/SPEC/GAME.md:155-157`
- UI 仕様: `DEVELOP/SPEC/UI-DESIGN.md:424-427`

候補船体・ポート、距離、正対角、相対速度、拒否理由を表示し、ユーザーが接続先を選択してから確定する UI へ変更する。確定直前には eligibility を再評価する。

### P1-6. 確認 UI がブラウザ標準ダイアログ

建造終了、建造枝破棄、デカプラー作動、物資分離で `globalThis.confirm()` を使っている。

- 実装: `src/game/ship/ship-construction.ts:230-253`
- 実装: `src/game/pickable/module-windows.ts:98-104`
- 仕様: `DEVELOP/SPEC/UI-DESIGN.md:473-475`

共通 `OverlayManager` の確認オーバーレイへ移行する。ESC はキャンセル、背景のゲーム入力は遮断する。

### P1-7. 建造開始元のモジュールウィンドウが残る

建造開始時に `closeOtherWindows()` は object window しか閉じず、開始元の module window が残る。建造中の通常 HUD 入力遮断と合わせて、開始元を閉じるか操作不能にする。

- 実装: `src/game/pickable/module-windows.ts:107-112`
- 呼び出し配線: `src/game/game-presentation.ts:169-177`

### P1-8. 未使用の `launchConstruction()`

現在外部呼び出しがなく、建造終了後は通常の `undock()` を使う設計と重複する。

- 実装: `src/game/ship/modular-ship.ts:453-462`

将来の別仕様がなければ削除する。残す場合は建造 edge の種別と UI を明示する。

## リファクタリング候補

- dock/port の判定をドメイン述語へ集約し、UI・可否判定・建造・修理・保存で同じ回答を返す。
- `ShipAssembly.mergedAtDock()` を構造統合・ID remap に限定し、entity の姿勢・速度・状態移管を別の docking transaction へ分ける。
- merge 結果に module ID、connection ID、cockpit ID、draft の remap を含める。
- `ShipAssembly.validate()` に docking edge の端点、占有、健全性、構造 edge の整合性を追加する。
- `worldTransformOf()` の再帰探索、merge の `pending.shift()`、ID衝突探索の計算量を見直す。
- `dockingPortPose()` の未使用 `rotation` を削除またはスナップ計算・診断に利用する。
- entity 単位の docking / undocking / save round-trip テストを新設する。現状の assembly 単体テストだけでは registry、selection、motion、draft 移管の回帰を検出できない。

## 仕様追加・修正案

次の事項は実装の作り方ではなく、ゲームがどう振る舞うかとして仕様へ固定する候補。

1. docking 時の anchor、同質量の tie-break、姿勢・COM・線速度・角速度の決定方法。
2. docking と undock の運動量・運動エネルギーの扱い、分離速度と衝突猶予。
3. cockpit、建造ドラフト、docked identity、弾薬、熱、電力、ラジエーター、計画、スロット状態の merge/split 方針。
4. 建造枝の根元を `docking` edge とするのか、専用の detachable edge とするのか。
5. `dock` / `docking_port` の接続、建造、修理の能力表。
6. 接舷候補の明示選択と、接続確定前の再判定。
7. 保存された docking edge と detached identity の完全な対応関係、および不正記録の拒否方針。

## 今回の P0/P1 修正で採る判断

- anchor は現在質量の大きい側。同質量なら `dock()` を開始した側。
- anchor の pose と運動を基準に統合し、軽い側の相対運動は残さない。
- undock は decoupler と同じ分離速度モデルを使い、並進運動量を保存する。
- 建造開始・再開・修理は `dock` のみ。`docking_port` は接続・切り離し専用。
- 建造枝はポート同士の docking edge と混同しない detachable construction edge として扱うか、少なくとも不正な端点の昇格を拒否する。
- entity の一時操作状態は統合時に解除する。assembly に属する状態、operating cockpit、dock draft、docked identity は失わない。

## 実装後のレビュー観点

- 重い側・軽い側・同質量の三経路で、anchor pose、接続点一致、cockpit、selection が正しい。
- docking/undock で module、connection、draft、identity の参照が失われない。
- 分離後の各モジュールの位置・角速度由来速度が連続し、分離速度と運動量保存が成立する。
- 建造中に操縦、射撃、時間加速、ターゲット、ビュー、通常 HUD が動かない。
- `dock` / `docking_port` の全入口が同じ能力判定を使う。
- 保存の不正入力を部分適用せず、正常状態は round-trip する。
- 既存の未コミット変更を統合へ巻き込まない。
