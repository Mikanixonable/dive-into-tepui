# Linter違反の段階的な修正計画

## スナップショット

- 対象コミット: `081743ce8` (`chore: introduce lint checks`)
- 対象: `src/`、`tests/`、`tools/` のTypeScript/JavaScript
- 既存の未コミット作業: 本計画の対象外。変更しない
- 現在の検証状態: `npm run lint`、`npm run check:architecture`、`npm run typecheck`、`npm run test`、`npm ci --dry-run`、`git diff --check` が成功

## 結論

現在の抑制ファイルに含まれる違反を、すべてコード違反として機械的に修正してはいけない。`DEVELOP/CODING-RULE.md` と照合すると、次の三種類が混在している。

1. 既存のコード規範に直接違反しているもの
2. linterがコード規範より強く制限しているもの
3. コード規範にはない、linter由来の補助的な品質チェック

したがって、最初にlinter設定を規範へ寄せ、その後にコード側の実違反だけを段階的に修正する。特に、`!`を全廃すること、`console`を全廃すること、すべての引数型を追加することは、現行規範からは導けないため実施しない。

## 現在の分類

| ルール | 抑制件数 | 判定 | 扱い |
| --- | ---: | --- | --- |
| `@typescript-eslint/no-non-null-assertion` | 1118 | linterが過剰 | 一括修正しない。設定から外し、外部保証でない`!`だけを後で監査する |
| `@typescript-eslint/consistent-type-imports` | 623 | コード規範違反 | import規則に合わせて段階的に機械修正する |
| `@typescript-eslint/explicit-member-accessibility` | 581 | コード規範違反 | `public`固定にせず、クラスごとに公開範囲を判断して修正する |
| `@typescript-eslint/no-unused-vars` / `no-unused-vars` | 76 | 補助チェック。設定も要確認 | `_`付きの未使用引数を既存の慣習として許容するか確認し、残りだけ修正する |
| `@typescript-eslint/explicit-module-boundary-types` | 24 | 一部が過剰 | 現行規範は戻り値型を要求するが、すべての引数型までは要求しない。正確なルールへ置換する |
| `no-console` | 10 | linterが過剰 | 現行規範は`console`全般を禁止していない。エラー診断を含むため一括削除しない |
| `no-restricted-syntax`（default export） | 7 | コード規範違反 | named exportへ変換し、利用側を更新する |
| `@typescript-eslint/prefer-for-of` | 3 | コード規範違反 | iteratorを使える単純ループだけ修正する |
| `prefer-const` | 1 | コード規範違反 | `const`へ修正する |
| `no-irregular-whitespace` | 4 | 補助チェック | 意図しない空白だけ除去する |
| `no-useless-assignment` | 4 | 補助チェック | 代入の意味を確認してから削除する |
| `preserve-caught-error` | 3 | 補助チェック | エラー原因を失わない形へ修正する |
| `@typescript-eslint/no-explicit-any` | 0 | 現行規範にない追加制約 | 規範へ追加する合意がない限り、強制ルールから外す |
| `@typescript-eslint/prefer-for-of`以外のrecommended規則 | — | 補助チェック | 規範違反と呼ばず、採用するなら「linter固有の安全検査」として扱う |

補足:

- `no-non-null-assertion`は、現行規範が「型以外の仕組みによって保証できる場合は`!`を許可」しているため、全件違反ではない。
- `explicit-module-boundary-types`は、戻り値型だけを求める現行規範に対して、引数型まで要求するため過剰である。
- `no-console`は、現行コードに保存処理やwatchdog等の診断ログがあり、現行規範にも全般禁止の記述がない。
- `tools/`は`DEVELOP/CODING-RULE.md`の主対象である`src/**/*.ts`、`tests/**/*.ts`、HUDのCSSとはスコープが異なる。`tools/`へ`src/`と同じ厳格さを適用し続けるかは分離して決める。
- アーキテクチャ検査は、現在違反のない方向だけを強制している。`render -> game`は既存コードに違反が残るため、現段階では検査対象にしていない。

## 段階計画

### 0. linter設定を現行規範へ合わせる

最初の変更単位。コードを直す前に実施する。

- `src/`・`tests/`を現行コード規範の主対象として扱い、`tools/`は別の軽量設定へ分離する。
- `no-non-null-assertion`を強制エラーから外す。代替となる「外部保証でないassertion」の検出方法は、実コードを確認してから別途決める。
- `explicit-module-boundary-types`をそのまま使わず、 exported function と public/protected method の戻り値型だけを検査できる設定またはカスタムルールへ置き換える。
- `no-explicit-any`と`no-console`は、現行規範を変更しない限り強制しない。将来禁止するなら、先に`DEVELOP/CODING-RULE.md`へ規範として追加する。
- `_`付き未使用引数が意図的なプレースホルダーなら、`no-unused-vars`で引数を除外する設定にする。意図しない未使用変数は残す。
- `@eslint/js` / `typescript-eslint`のrecommended規則は、コード規範の違反とは呼ばず、採用する補助的な安全検査として一覧化する。
- 設定変更後に抑制ファイルを再生成し、不要な抑制をpruneする。件数の減少を確認し、抑制件数の変化をこの計画の実績として記録する。

受入条件:

- 現行規範と衝突する一括禁止が設定からなくなっている。
- `npm run lint`、`npm run typecheck`が成功する。
- 設定由来の違反とコード由来の違反が、抑制ファイル上で再分類できる。

### 1. 低リスクの明白な実違反を修正する

小さな独立コミットに分け、差分をレビューしやすくする。

- `prefer-const`: 1件
- `prefer-for-of`: 3件
- default export: 7件。export名と利用側のimportを同時に更新する
- `no-irregular-whitespace`: 4件
- `no-useless-assignment`: 4件。値の破棄が本当に不要か確認する
- `preserve-caught-error`: 3件。元エラーをcause等で保持する
- import規則: 623件。`eslint --fix`をサブディレクトリ単位で実行し、型検査後に差分を確認する

`lint:fix:all`をリポジトリ全体へ一度に適用しない。import修正のように意味が機械的に確定するものと、export変更のように利用側の確認が必要なものを分離する。

受入条件:

- 各コミット後に`npm run lint`、`npm run typecheck`を実行する。
- `src/`を変更した場合は、変更層に応じて`npm run test:math`、`npm run test:physics`、`npm run test:game`、`npm run test:render`を実行する。

### 2. クラスメンバーのアクセス修飾子を修正する

581件をサブシステム単位で分割する。自動修正で全件を`public`にしない。

- 外部利用されないメンバーは`private`
- 継承先の契約として必要なメンバーだけ`protected`
- 外部契約として必要なものだけ`public`
- constructorもクラスの生成経路と可視性を確認して付与する

各サブシステムの修正後に型検査と該当層の回帰テストを実行する。公開範囲の変更が呼び出し側を壊す場合は、修飾子を緩めるのではなく、既存の生成・呼び出し関係を確認して設計を調整する。

### 3. 戻り値型の規範を正確に適用する

段階0で設定を修正した後、残った「exportされた関数」および「public/protected method」の戻り値型だけを対象にする。

- argument annotationの追加を目的にしない
- 推論で十分な内部関数は対象外とする
- public APIの戻り値が`Promise`、union、ドメイン型のどれであるかを実装から確認する
- 追加した型が実装の意図を変えないことを型検査で確認する

### 4. non-null assertionを意味単位で監査する

1118件を一括削除しない。現行規範に従い、次の順で判断する。

1. DOMや固定テーブルなど、型以外の仕組みで存在が保証されるか
2. 実際には保証されず、未定義状態を表現すべきか
3. control-flow narrowing、lookup API、guard、明示的なエラー処理で置き換えられるか
4. assertionを残す場合、規範上の保証根拠がコードから読めるか

この段階では、意味を変えない機械的置換を優先せず、ゲーム・描画・物理などの責務単位で修正する。変更層の回帰テストを必須にする。

### 5. 未使用変数を整理する

段階0で意図的な`_`引数を除外した後に残る件数だけを対象にする。

- 不要なローカル変数・代入は削除
- 将来の引数のためだけに残した変数は、既存規範に沿う明確な理由がなければ削除
- テストのfixtureやcallback引数は、意味のある名前を保ちつつ設定で許容するか判断

### 6. アーキテクチャ境界を完成させる

現行の`check:architecture`は一部の方向を検査できているが、`render -> game`は既存違反があるため未検査である。先に依存を解消し、その後に検査を追加する。

- renderが必要とするmarker識別子・スロット・描画向け定数を、renderまたはより下位の共有契約へ移す
- gameの実装詳細をrenderが直接importしない構造へ変更する
- `render: ['game']`をアーキテクチャ検査へ追加する
- settingsの特別な依存関係は、現行規範に記載された例外を維持し、一般的なDAG制約へ単純化しない

この段階は設計変更を含むため、`src/render/`の回帰テストを中心に実行する。必要な共有契約の置き場所が決まらない場合は、コード編集前に既存の責務境界を再確認する。

### 7. 将来ルールとフォーマッタを別判断する

現行規範にあるが現在のlinterで未検査のものを、ノイズ量を測ってから追加する。

- `readonly`は、まず入力データ型・固定フィールドを対象に限定して検討する。全体一括導入はしない
- `no-floating-promises`など型情報を使う検査は、実行時間と既存違反数を測ってから導入する
- コメントの日本語、設計意図、magic number、`plan/predict`等のドメイン命名は、汎用linterで無理に検査しない
- line length、コメント位置、CSSの意味的な規約は、既存の`verify:ui-style`やレビュー手順との役割分担を決める
- Biome等のフォーマッタ導入は、linterの違反修正とは別コミットにする。既存コード全体の整形差分を、意味修正と混ぜない

## 進捗判定と停止条件

各段階で次を記録する。

- linterのルール別抑制件数
- `npm run lint`と`npm run typecheck`の結果
- 変更層に対応する回帰テストの結果
- コード規範違反を修正したのか、linter設定を修正したのか

抑制件数を0にすること自体を目的にしない。現行規範で許容される`!`、診断ログ、intentionalな未使用引数などを無理に消す必要はない。規範を変更して禁止したい項目が出た場合は、先に`DEVELOP/CODING-RULE.md`を更新してからコード修正計画を立て直す。
