# 自機・カメラ・ステージの初期化順序の是正

**病巣は2つあった。どちらも解消済み。**

- **病巣 I — 操作対象艦の種付け**(Step 5-6)。操作対象艦の正本を持つ
  `ActivePlayerController` が初期値を自分で解決するようにし、`EntityManager.initialActivePlayer`
  という一方通行の口を消した。
- **病巣 II — 初期世界の作者が `Game` と `Stage` に割れている**(Step 7-10)。
  新規開始の世界を組むのは `Stage.init` だけになり、`EntityManager` は復元専任になった。

## 是正案 I (Step 1-6 すべて実施済み)

## 是正案 II (Step 7-10 すべて実施済み)

到達した形:

- 初期弾薬は `PlayerInit.ammo` として艦の構築引数に載る。`initAmmo` は無い。
- 新規開始の自機は `Stage.init(entities)` が `protected addPlayer(init?)` で置く
  (`CreativeStage.placeObject` と同じ経路)。隻数の静的宣言は無く、何隻をどこへ置くかは
  `init` の中身。`EntityManager` は復元だけを担う。
- `init` は `void`。機数を出すステージは `scoreCounter.totalEnemiesSpawned` を読む。
- `ViewManager` の構築は `new stageClass(...)` の後ろ。初期ビューは世界が組み上がった後に決まる。
- `StageStatusPanel` の入口は `sync(player: Player | null, ...)` 一本。`#hud-stagestatus` /
  `#hud-status` / `#hud-orbit` の表示を書くのは各パネルの所有者だけで、`CameraSystem` は触らない。
  どこにも効果を持っていなかった `showsStatusInOverview` は宣言ごと削除し、ステータスパネルは
  戦闘ビュー専用と言い切った(マップの同じ画面下端中央は PREDICT バーが占める)。

## 未決の論点

### △ `recordPlayerLost` の既定を一般形(決着しない)側へ倒すか

`/refactor-fixed` 21 は「基底の既定実装は一般形の側に寄せる」と言っており、現状はその反転
(基底が決着させ、`CreativeStage` だけが `hud.hint` へ override している)。

ただし実数は **7対1**(stage0/00/1/2/debug/debug-alt/debug-load が基底の挙動を使う)。倒すと
override が7個に増え、規則が守ろうとしている「どちらが一般形か読める」がかえって損なわれる。
能力フラグ化(`readonly endsOnPlayerLoss`)も、既定をどちらに置いても同じ数の宣言が要る。

**現状維持を推奨するが、規則との緊張は実在するのでユーザーの判断を仰ぐ。**

## 範囲外(気付いたが触っていない)

- `Game.advanceSimulation` がアクティブ艦だけ `behave` の特別扱いをし、残りを
  `entities.updatePassivePlayers` へ回す形。per-frame の呼び出し順の話であって初期化順ではない。
- `mapPicker.setDocking`・`Game.setPerfMeter`・`ViewManager.setTouchControls` の遅延注入。
  `/refactor-fixed` 13 が「1メソッド1回」の注入として認めている形なので現状可。
- **行数**: `creative-stage.ts` 351 / `stage00.ts` 303 / `stage.ts` 277 行。
  200行基準を超えるが、分割は初期化順とは別の作業。
