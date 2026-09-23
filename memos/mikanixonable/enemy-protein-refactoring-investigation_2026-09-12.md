# 敵・Protein リファクタリング調査

初回調査: 2026-09-12  
再監査・Stage 1–3 実装: 2026-09-23

このメモは、敵コードの現状と残課題を記録する。仕様の正本は実装および `DEVELOP/SPEC/COMBAT.md` /
`DEVELOP/SPEC/PROTEIN.md` であり、両者が食い違う場合は実装を確認したうえで仕様書を更新する。

## 2026-09-23 時点で解消済み

初回調査で高優先度だった次の項目は、現在の実装ですでに解消されている。

- 攻撃グループは表示色 `accent` から分離され、`attackGroupId` を正本にする。
- Protein 陣形は `formationId` と役割を保存し、エネルギー供給判定も同じ陣形単位で行う。
- Protein の掃引衝突は前後の位置だけでなく前後の姿勢も受け取り、回転を含む。
- Protein の HP・機能部位・修飾・攻撃部位巡回は `ProteinCombatState` が所有する。
- Enemy の射撃判断は `EnemyFireController`、被弾・死亡反応は `EnemyReactions`、
  表示検査は `EnemyInspection` へ分離されている。
- ProteinEnemy は部品式 Ship の継承契約から切り離され、`Enemy -> CombatShipEntity` 系統にある。

## Stage 1 — 実装を正本にした仕様整理

今回、コードを仕様へ無理に合わせるのではなく、現在のゲーム挙動を正本としてコメントと仕様書を整理した。

### MetalEnemy の HP

`createShipDefaultParts(6)` の 6 は総 HP ではなく、パーツ HP の配分基準値である。各パーツを整数かつ
最低 1 HP へ丸めるため、既定の MetalEnemy は実際には 11 HP を持つ。機体の最大 HP の正本は
`PartDamageModel.maxHp`、すなわち生成済みパーツの `maxHp` 合計である。

従来の `ENEMY_MAX_HP = 6 // 敵機の総 HP` は実装と矛盾するため削除した。配分アルゴリズムやゲーム
バランスは変更していない。

### MetalEnemy の weapon パーツ

既定パーツには Gatling Gun の `weapon` が含まれるが、MetalEnemy の AI 射撃は独立したプラズマ射撃で、
`canFire()` は weapon パーツの健全性を参照しない。この挙動を維持し、weapon は現状「被弾モデル上の
パーツ」であることをコメントと COMBAT に明記した。

### 射撃バーストの停止条件

- 交戦距離外、近すぎる距離、またはステージ側の `mayFire=false` ではバーストを一時停止する。
- Protein のエネルギー喪失など、個体固有の `canFire=false` では進行中バーストを破棄する。

以前の「射程外ならバーストをキャンセルする」案は採用しない。

### Protein の座標

戦闘上の部位位置は静止構造の座標を正本とする。構造揺らぎは表示専用で、銃口位置、被弾部位選択、
衝突球列を変形させない。表示マーカー自体を静的戦闘アンカーへ揃える作業は Stage 4 の残課題とする。

### Spawn と撃破表現

Protein 陣形は3体を原子的に出現させず、各個体の asset gate が準備できた順に実体化する。この現在挙動を
仕様化した。Protein 撃破も現状は金属敵と同じ `shipExploded` と汎用 `enemyDestroyFragments` を使う。

## Stage 2 — 実装バグ修正

### バースト連射の時間刻み依存

旧 `EnemyFireController` は1回の update で最大1発しか進めず、`burstDelay <= 0` になった際に
`0.08` 秒へリセットして超過時間を捨てていた。そのため低 FPS・大きな simulation step で連射速度が落ちた。

`EnemyFireState` が残時間を所有し、射撃可能な時間だけを差し引く。1フレームで複数の発射間隔を跨いだ場合は、
残時間へ間隔を加算しながら必要な発数まで追いつく。射程外や `mayFire=false` の時間は消費しない。

### EnemyInspection の表示時刻

敵と viewer の位置・速度を同じ `displayTime` で評価するようにした。
`relativeInfo` も渡された時刻の双方の状態から距離・接近速度・相対速度・相対傾斜を求める。
軌道要素一覧は `InspectedObject` の契約どおり、天体位置を厳密に引く `simTime` のままとする。

小数 HP は切り捨てず、整数なら整数、小数なら小数1桁で表示する。

### Protein セーブ復元

`ProteinCombatState.deserialize` で次を検証する。

- integrity / site HP: 有限値だけ採用し、0〜最大 HP へ clamp。不正値は無傷の既定値。
- modification: 現在の slot が定義する state だけ採用し、不正値は `defaultState`。
- attack site cursor: 0 以上の有限整数へ正規化し、不正値は 0。

## Stage 3 — 挙動を変えない構造整理

### 射撃状態の所有者

`burstLeft` / `burstDelay` / `lastFireSim` / `lastBehaviorSim` の4値を継承階層の位置引数で運ぶのをやめ、
`EnemyFireState` へ集約した。保存形式の `fireController` フィールドは互換性のため維持し、
具象 Enemy の `deserialize` が `EnemyFireState.deserialize()` で復元してからコンストラクタへ渡す。

### Pending spawn

`EntityLifecycle` に並存していた `SpawnRecord[]` と、外部利用のない
`PendingEntitySpawn[] / queuePendingSpawn()` の二重経路を解消した。待機 spawn は保存可能な
`SpawnRecord` 系のみを正本とする。

### EnemyMotion の物性

全敵が共有している質量 10,000 kg と最大温度 500 K を `ENEMY_MOTION_PROFILE` にまとめた。
値と挙動は変更していない。空力・輻射圧など、既存の `shipMotionProperties` 由来の共通値も変更していない。

## 今回追加した回帰テスト

- 粗い update と細かい update で、同じ経過時間ならバーストの発射数が一致する。
- `mayFire=false` と交戦距離外では、進行中バーストの待ち時間を消費しない。
- 個体固有の `canFire=false` は進行中バーストを破棄する。
- MetalEnemy の最大 HP は生成済みパーツの最大 HP 合計であり、既定構成では 11。
- Protein の破損した保存値を復元しても、HP・修飾状態・攻撃部位 cursor が有効範囲へ戻る。

## 残課題

今回の Stage 1–3 には含めない。

1. Protein の表示マーカーを静的な Combat Site Anchor と一致させ、表示揺らぎと戦闘アンカーの差を
   HUD 上でも明確にする（Stage 4）。
2. Protein asset load の失敗・キャンセルを `SpawnRecord` の待機状態として表現する。今回削除したのは
   未使用の第二 pending 経路であり、現行 asset gate 自体は boolean ready/not-ready のままである。
3. Protein 専用の撃破 VFX / 破片を導入するかは、ゲーム表現の仕様として別途決める。
4. MetalEnemy の weapon パーツを将来 AI 射撃能力へ接続するかは、現在のプラズマ射撃仕様を変更するときに
   判断する。
5. 敵の回避、隊列維持、プログレード追従などの操舵 AI は未実装で、COMBAT の「未確定の案」に置く。
