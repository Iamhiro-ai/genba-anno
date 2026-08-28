// =============================================================================
// パス単位の直列化ロック（純ロジック・fs / electron 非依存）
//
// 自動保存（30秒デバウンス）と手動保存（Ctrl+S）・画像切替時の保存が重なると、
// 「退避 → バックアップ → tmp 書込 → rename」が交錯して
//   - 古い内容が後から rename されて勝つ
//   - バックアップ世代が実際の直前世代とずれる
// という事故が起きる。同じファイルへの書込は必ず 1 本の鎖に並べる。
//
// 異なるパスは並行実行される（画像ごとのサイドカーは独立）。
// =============================================================================

/** key → 実行中タスクの末尾（エラーは飲み込んだもの） */
const chains = new Map<string, Promise<void>>();

/**
 * 同一 key のタスクを直列に実行する。
 * 前のタスクが失敗しても後続は実行される（成否は呼び出し側へそのまま伝わる）。
 */
export function withFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  // 前段の成否にかかわらず自分を実行する
  const run = previous.then(task, task);
  // 鎖として繋ぐのはエラーを飲み込んだ側（reject が伝播すると後続が走らなくなる）
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  void tail.then(() => {
    // 自分が最後尾なら Map から外す（長時間実行でのキー蓄積を防ぐ）
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** 実行待ち・実行中の鎖が残っている key の数（テスト・診断用） */
export function pendingLockCount(): number {
  return chains.size;
}
