// =============================================================================
// project:open が返す warnings / lossy の組み立て（純ロジック・fs / electron 非依存）
//
// 契約（src/shared/ipc.ts）:
//   warnings … ユーザーに見せる日本語の警告
//   lossy    … このまま保存操作を進めると元ファイルの情報が失われ得るか
//              = jsonToProject の lossy ∨ 原本退避が発生 ∨ corruptSidecars > 0
//
// lossy の主用途は「project === null で renderer がデフォルト project.json を
// 自動保存する直前の確認ゲート」。壊れた原本を退避した直後の自動保存は、
// クラス定義（= 学習 ID）を無言で置き換えるため。
// =============================================================================

export interface ProjectOpenSummaryInput {
  /** jsonToProject が返した警告（parse できた場合のみ） */
  projectWarnings: readonly string[];
  /** jsonToProject が「情報が失われる」と判定したか */
  projectLossy: boolean;
  /** project.json は存在したが JSON として読めなかった */
  projectUnreadable: boolean;
  /** 原本を退避した場合の通知文（退避しなかったら null） */
  preservedMessage: string | null;
  /** 読み込めなかったサイドカーの件数 */
  corruptSidecarCount: number;
}

export interface ProjectOpenSummary {
  warnings: string[];
  lossy: boolean;
}

/** 壊れたサイドカーがあるときの警告文 */
export function corruptSidecarWarning(count: number): string {
  return `${count}件のアノテーションファイルを読み込めませんでした（保存時に原本を退避します）。`;
}

/** project.json が JSON として読めなかったときの警告文 */
export const UNREADABLE_PROJECT_WARNING =
  'project.json を読み込めませんでした。設定を作り直します。';

/**
 * warnings を連結し、lossy を OR で決める。
 *
 * 注意: projectLossy が false でも、退避が起きていれば / 壊れたサイドカーがあれば
 * 全体としては lossy=true になる（jsonToProject の値の素通しではない）。
 */
export function summarizeProjectOpen(input: ProjectOpenSummaryInput): ProjectOpenSummary {
  const warnings: string[] = [];

  if (input.projectUnreadable) {
    warnings.push(UNREADABLE_PROJECT_WARNING);
  }
  // クラス id の振り直し等は学習 ID に影響するので必ずユーザーへ見せる
  warnings.push(...input.projectWarnings);
  if (input.preservedMessage) {
    warnings.push(input.preservedMessage);
  }
  if (input.corruptSidecarCount > 0) {
    warnings.push(corruptSidecarWarning(input.corruptSidecarCount));
  }

  const lossy =
    input.projectLossy ||
    // 退避が起きた = 上書きで失われる情報が実在した（.corrupt- / .newer- のいずれも）
    input.preservedMessage !== null ||
    // 壊れたサイドカーは注釈0件で開くため、そのまま保存すると原本が失われる
    input.corruptSidecarCount > 0;

  return { warnings, lossy };
}
