# stock-ai-site

株AI（Stock_AI_log）の確認用サイト。ビルド不要の静的サイト（index.html / app.js / style.css）。

- データはこのリポジトリには置かない。非公開の `Stock_AI_log` を GitHub API で読む
- 読むもの: `predictions.jsonl` `results.jsonl` `notes.md` `prices.json` `trades.jsonl`
- 書くもの: `trades.jsonl`（追記のみ。sha を付けて更新し、競合したら読み直して再試行）
- GitHub の鍵は初回に画面で入力し、ブラウザの localStorage にだけ保存する

## 任意のデータ形式

- `prices.json`: `{"updated_at":"2026-11-20","prices":{"7203":2910,"3397":{"price":3500,"date":"2026-11-20"}}}`
  （`{"7203": 2910}` だけでも可。`.T` 付きのコードも可）
- 予想に `"probs":{"buy":60,"hold":25,"sell":15}` があれば、帯はその3色で出す。無ければ 2択の確信度から出す
- `notes.md` の「展望」を含む見出し（例 `## 今後の展望`）の下が「今後の展望」に出る
- `trades.jsonl` の1行: `{"id":"...","at":"ISO日時","side":"buy|sell","ticker":"7203","name":"トヨタ","shares":100,"price":2900,"memo":""}`
