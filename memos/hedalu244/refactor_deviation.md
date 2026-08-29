# CODING-RULE の転記漏れ候補と、その違反箇所

対象コミット: `2c754466` (workspace6) 時点のスナップショット。

## 0. この文書の位置づけと、規則が消えた経路

ユーザーの見立て(「CODING-RULE.md へ一本化したときに転記し損ねた」)を git log で追ったところ、
実際の経路は少し違った。**報告だけしておく。判断は覆さない。**

1. `7c31e973` — `DEVELOP/CODING-RULE.md` を新設。このとき
   `.claude/skills/refactor-fixed/SKILL.md` は削除ではなく **`memos/hedalu244/naming.md` へ退避**
   された(rename R061)。commit message に「どれを昇格させるかは1件ずつ判断する」とある。
2. `c8f5ea6a` — 退避した35項目を1件ずつ判断し、10項目ほどを CODING-RULE / SPEC へ昇格、
   **「残りは破棄」として `naming.md` を削除。**

つまり `Ctx`/`Params`/`Snapshot` 禁止(旧 refactor-fixed §6 / naming.md A-6)は、
7c31e973 で落ちたのではなく **c8f5ea6a の一括判断で破棄された側に入っていた。** 以下に挙げる
候補も同じ経路で消えている — つまり「一度は目を通した上で捨てられている」可能性がある。
それでも挙げるのは、**どれも個別モジュールの話ではない一般則**だからで、
「/refactor-fixed の細かすぎるルール」とは性質が違うと判断した。

---

## 1. 撤廃作業(依頼2)で見つけた逸脱

`OrbitLineSyncContext` と `BasePanelContext` は撤廃済み。その過程で見つけたものを挙げる。

### 1-1. `FutureCelestialBodyProvider` が「クラスの契約」なのに関数型の `type`

`src/game/dynamic/arc-celestial-bodies.ts:18-22`

```ts
export type FutureCelestialBodyProvider = {
  readonly candidates: () => readonly FutureBodyCandidate[];
  readonly celestialBodyAt: (id: CelestialBodyId, t: number) => CelestialBody;
};
```

実装しているのは `FutureCelestialBodies` というクラス1つだけ
(`src/game/simulation/future-celestial-bodies.ts:6` で `implements` している)。

**既存の CODING-RULE 1.11 に既に違反している** — 「オブジェクトの公開契約と、クラスが実装できる
契約には `interface` を使う。union、intersection、mapped type、関数型には `type` を使う。」
メソッドを持つ `interface` にすれば、下の 2-1 の「クロージャではなく参照を渡す」とも揃う。
なお `Ctx` 型ほどの害はない — 寄せ集めではなく、実装が1つに定まった契約なので。

### 1-2. `BasePanel` のタブへ渡していたのは実質「転送クロージャ8本」

撤廃前の `BasePanelContext` は値の寄せ集めですらなく、`base()` / `refresh()` /
`notifyLaunch()` といった **`BasePanel` 自身のメソッドへ転送するだけのクロージャ8本**だった。
`Ctx` 禁止だけでは説明しきれず、下の 2-1(旧 refactor-fixed §7)がもう一方の根拠になる。
今回は `BasePanel` の参照そのものを渡す形へ直した。

---

## 2. 転記漏れ候補(ルール本文と違反箇所)

### 2-1. 渡すのはクロージャではなくオブジェクトの参照 【違反あり】

出典: 旧 `refactor-fixed` §7 / `naming.md` A-7。現在の CODING-RULE 1.11 には
**弱められた1行だけ**が残っている:

> - **不要なクロージャ注入は行わない。** 特定のオブジェクトに影響を及ぼしたいなら、その mutable な
>   オブジェクトを直接渡す。(現行 1.11)

落ちているのは、この規則の**判定基準と例外**にあたる部分:

> 他モジュールのデータや処理へ届かせたいとき、`(t) => other.sample(t)` のような**転送クロージャを
> 作って渡さない。** そのオブジェクトの参照そのものを渡す。クロージャ注入は「誰が誰を呼んで
> いるか」を型からも呼び出し元からも隠し、配線が増えるほど実行順序が読めなくなる。
>
> - **いつ渡すかは、使うタイミングで決める。** 毎フレームの呼び出しの中だけで使うなら引数で渡す。
>   DOM の pointer イベントなど**フレームの流れの外**で使うなら、コンストラクタで受けて保持する。
> - **`ProjectFn` だけは関数で渡す。** これは処理の委譲ではなく「その瞬間の視点」という値で、
>   `CameraSystem.activeCameraProjection` は呼んだ時点のアクティブカメラのスナップショットを返す。
>   したがって**受け取った側が保持してはいけない** — 毎フレーム渡し直し、受け手は per-frame の
>   表示文脈として上書きする。

**`Ctx` 禁止と対になる規則である。** `Ctx` が「値の寄せ集め」を禁じ、こちらが「処理の寄せ集め」を
禁じる。片方だけ復元しても、`BasePanelContext` と同じものは「関数の袋」として再発しうる。

**違反箇所**

- `src/game/plan/plan-editor.ts:107-111` — `AxisDragGizmo` へ転送クロージャ3本:
  ```ts
  this.axisDrag = new AxisDragGizmo(
    (state) => this.bodyState(state),
    (r, t) => this.planDisplay.path.projectPoint(r, t),
    (axis, sign, amount) => this.applyDv(axis, sign, amount),
  );
  ```
  `(r, t) => this.planDisplay.path.projectPoint(r, t)` は旧規則が名指しした
  `(t) => other.sample(t)` そのもの。受け側は `src/game/plan/plan-axis-drag.ts:19-23`。
- `src/game/dynamic/arc-celestial-bodies.ts:18-22` — 上の 1-1 と同じ箇所。実装が1クラスに定まっている
  契約を、関数プロパティ2本の袋にしている。

> **注記**: `ProjectFn` 例外は現行コードにも生きている(`CameraSystem.activeCameraProjection`)。
> 2-1 を復元するなら、この例外も一緒に書かないと `ProjectFn` が違反に見える。

### 2-2. 重なり順はレイヤと DOM 順だけで決める 【違反あり】

出典: 旧 `refactor-fixed` §12 / `naming.md` A-12 / `CODING_RULE_v2` I-12。

> **個々の GUI が自分で z-index を持ってはいけない。** 固定レイヤの並びが唯一の正本で、z-index を
> 割り当てるのはそのモジュールだけ。GUI の所有者が決めるのは自分がどのレイヤの子になるかだけで、
> 同じレイヤ内の前後は DOM 順、最前面化は `bringToFront()` の呼び出しだけが動かす。
>
> (前段) **GUI は、その GUI が書き換える状態の所有者が持つ。所有者が1つに定まらない GUI は、GUI の
> 方を分割する。** 表示・非表示も所有者が自分の `sync` で押し出す。**GUI の見た目を維持することを
> 制約にしない。**

規則そのものは `src/game/hud/overlay-layer.ts:1-2` のコメントとして**コード側に生き残っている**
(「z-index を持つのはこのモジュールだけであり」)。正本が CODING-RULE ではなく1モジュールの
先頭コメントにあるので、他のモジュールを書くときに目に入らない。

**違反箇所**

- `src/game/hud/windows/resource-transfer-dialog.ts:16` — `z-index: 100`。この要素は
  `src/game/docking.ts:79` で `hud.layers.view` の子として構築される。**レイヤの中で自前の
  z-index を持っている。** 現状は `position: fixed; inset: 0` で単独なので実害は出ていない。
- `src/game/hud/style/hud-layout-style.ts:104` — `#hud .rail-toggle { z-index: 20; }`。
  レイヤの割り当て(`overlay-layer.ts` は `10 + i`、つまり 10..17)と**同じ数直線の上に、
  レイヤ機構の外から値を置いている。**
- `src/game/input/touch.ts:13-17` — `z-index: 9`。コメントに
  「システムウィンドウ(ESC メニュー・終了画面・ヘルプ)より下に置く」とあり、
  **`overlay-layer.ts` の表を読まないと妥当性を検算できない値**が別ファイルに置かれている。

**違反でないもの(確認済み)**

- `src/game/hud/style/marker-style.ts:11-30` — `--z-mk-*` を同ファイル冒頭の表1箇所で定義し、
  各マーカーはそれを参照するだけ。「相対的にしか意味を持たない値は、1箇所の表で割り当てる」に
  従っている。
- `src/game/stage-select.ts` / `src/loading-overlay.ts` / `src/fatal-error.ts` /
  `src/game/plan/node-gizmo.ts` — `#hud` の外。旧規則の適用範囲外。

### 2-3. `_` 接頭辞の二重定義 【違反あり】

出典: 旧 `CODING_STYLE` §2(公開依存とアクセサ)と §8(未使用引数)/ `naming.md` B-2・B-8。
`CODING_RULE_v2` は III-3 で**この二重定義自体を未解決の論点として挙げていた**。現在の
CODING-RULE.md には `_` 接頭辞の規約が**どちらの意味でも1行も無い。**

落ちている §8 側:

> - `_name` は、interface・継承・コールバックなど**固定されたシグネチャにより宣言が必要**だが、
>   その実装では意図的に使わない引数にだけ使う。自分でシグネチャを変更できる関数では未使用引数を
>   削除する。
> - `_` 単独ではなく、`_event`、`_dt`、`_player` のように引数の意味を残す。
> - 未実装、実装途中、将来使う予定という理由で `_name` を使わない。使うようになった時点で
>   `name` に改名する。

落ちている §2 側は「private の正本フィールドを `_x`、public getter を `x` にする」形。
コードには両方の慣習が同居していて、**`_` を見ただけではどちらか分からない。**

**違反箇所**(どちらの定義にも当てはまらない `_`)

- `src/game/camera/combat-camera-system.ts:48` — `constructor(_hud: Hud, ...)` の `_hud` は
  **次の行 :49 で使われている**(`new ChaseCamera(_hud, saved)`)。未使用引数ではない。
  `src/game/camera/camera-system.ts:156-157` も同じ形。
- `src/game/camera/chase-camera.ts:36` — `private readonly _hud: Hud`。:77 で使うが、
  対になる public getter `hud` は無い。**getter の裏当てでもない。**
- `src/game/dynamic/dynamic-entity/bullet.ts:39` — `private readonly _worldSfx: WorldSfx`。同上(:106 で使用、
  getter 無し)。

これは規則を復元するだけでは決まらない — **`_` にどちらの意味を割り当てるか(あるいは両方やめるか)
を先に決める必要がある。**

### 2-4. 複数の入力元が書きうる量は、正本フィールドを読む 【違反は未調査】

出典: 旧 `refactor-fixed` §18 の一般則 / `CODING_RULE_v2` I-9。

> **ある量を複数の入力元(手動操作・自動制御など)が書きうるとき、その量を消費する側(演出・音・
> 表示)は、対象自身が持つ正本フィールドを直接読み、特定の入力元が持つ表示専用の派生状態には
> 依存しない。** 派生状態を読む形にすると、その入力元経由でしか書かれない値を消費側が前提にして
> しまい、別の入力元が同じ量を動かしても何も現れない、という食い違いが起きる。
>
> 段階的なプリセットを持つ入力元と、段階を持たない連続出力の入力元が同居しうるなら、消費側が読むのは
> **両方を同じ式で表せる連続値**(「何段目か」ではなく「全開に対する比」)にする。

現行 1.6 の「正データが複数箇所に分散、重複しているデータ」と近いが、こちらは
**「正本はあるが、消費側が派生状態のほうを読んでしまう」**という別の失敗を名指ししている。
違反箇所は未調査(横断的な走査が要るため、必要なら別途)。

### 2-5. 排他選択の走査範囲に DOM の親子関係を流用しない 【違反なし】

出典: 旧 `refactor-fixed` §12 / `naming.md` A-12。

> 「同じ列の中で1つだけ選択状態にする」実装で、`parent.querySelectorAll('button')` のような DOM 検索を
> 排他の範囲にしない。同じ親に**独立した状態を持つ別のボタン**が同居した瞬間、それも一緒に解除されて
> しまう。排他の範囲は、そのグループのボタンだけを入れた配列として明示的に持つ。

`src/game/hud/widgets/segmented-control.ts:9` と `src/game/hud/widgets/tab-bar.ts:7` は
どちらも `Map<T, Button>` を持っていて、**現行コードはこの規則に従っている。**
規則だけが文書から消えた状態なので、次に排他選択を書く人が踏み直しうる。

---

## 3. 意図的な破棄と判断して挙げなかったもの

`naming.md` から破棄されたうち、以下は「細かすぎる/個別すぎる」側と判断して挙げていない。
判断が違うなら言ってほしい。

- B-4 基本動詞の一覧、B-5 boolean の命名、B-6 単位と座標系の接尾辞、B-7 コレクションと派生状態、
  B-10 クラスの役割名の定義表 — c8f5ea6a の commit message が名指しで「破棄」に入れている命名細目。
- A-1 `Game` はロジックを持たない / A-2 `update` と `sync` を混ぜない / A-5 優先順位 /
  A-13 二段初期化 / A-20 キャッシュキー / A-21 `T | null` — **これらは既に CODING-RULE へ入っている。**
- A-14 焼き込みアセット、A-16〜A-19、A-22、A-23 — 個別モジュール・個別機能の確定判断。
- A-12 のうち ESC / `OverlayManager` / 入力欄の `keydown` — `SPEC/UI-DESIGN.md` が
  「どう振舞うべきか」として持っている。
