# モジュール構成の見直し — 決定事項

## 何のための文書か

モジュール構成の全体調査(2026-08-28)で決めたことのうち、**この先も効き続けるもの**を残す。
個別の是正はすべて実施済みなので、実施リストはここには無い。天体まわりの再編(見た目カタログ・
レジストリ構造・solar-system.ts の分割・参照線・FutureCelestialBodies)は判断待ちの大きな検討
として `refactor_celestial_structure.md` が持つ。

## 決定事項(ユーザー判断、2026-08-28)

- **汎用データ構造は `src/math/` を新設して移す。** `util` / `lib` は意味が限定されず将来
  濫用されるため採らない。math は最も基本的なフォルダであり、
  **math が他フォルダ(physics / game / render)を import することは禁止。**
  vec3 も math へ移す(math 内モジュールが physics を import する事態を避けるため)。
- **定数は利用箇所と同居させる。** フォルダ集約ファイルではなく、使うモジュールの側へ。
- **テストは減らしてよい。** 今はとにかく多い。
- **見送り(今回はやらない)と決めたこと**:
  - nan-watchdog の責務を DynamicSystem へ回収する案(検査の価値はフレーム位相の記録に
    あり、呼び出しは orchestrator に残るため。将来のさらなる構造化の時に再考)
  - simulation facade の新設(simulator / predictor / dynamic-system は既に
    `game/dynamic/` に同居済み。facade はたらい回し層になる)
  - `export-models.mjs` の複製解消(three / three/webgpu 非互換という実制約。
    コメントに意図が明記されており、実害が出るまで触らない)

上の3点は `DEVELOP/CODING-RULE.md` 1.3(フォルダの境界)・1.6(定数は概念の所有者が持つ)・
4.1(テストを書く判断)へ落としてある。規則としてはそちらが正本。

## 残っている宿題

- `const.ts` は解体して削除した(`refactor_modules.md` 論点4)。104 定数はすべて所有者モジュールへ
  移り、`guideKindDefaultColors` とその補助は `hud/panels/guide-kind-def.ts` に居る。
