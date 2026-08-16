/** Pending-edit review UI dictionaries. */

export const NS = 'diff-approval'

/** Simplified Chinese pending-edit review messages. */
export const zh = {
  'panel.title': '待处理改动',
  'panel.empty': '没有待处理的改动',
  'panel.loading': '读取中…',
  'panel.readFailed': '读取待处理改动失败：{message}',
  'panel.group.current': '当前会话',
  'panel.group.others': '其他会话',
  'panel.aria': '待处理改动',
  'panel.stats': '+{added} -{removed}',
  'panel.selectHint': '点击每项查看整个文件的差异，拖动选择代码行可复制引用',
  'panel.missing': '文件已不存在',
  'panel.missingHint': '该文件已不存在，回退会恢复该文件。',
  'panel.createHint': '回退会删除该新建的文件。',
  'row.create': '新增文件',
  'row.added': '+{added}',
  'row.removed': '-{removed}',
  'action.keep': '保留',
  'action.revert': '回退',
  'action.openFile': '打开文件',
  'action.revealFile': '打开所在目录',
  'action.busy': '处理中…',
  'action.prevDiff': '上一处差异',
  'action.nextDiff': '下一处差异',
  'action.copyRange': '复制引用',
  'action.copied': '已复制',
  'status.kept': '已保留',
  'status.reverted': '已回退',
  'status.missing': '该改动已不存在',
} satisfies Record<string, string>

/** Translation keys owned by the pending-edit review namespace. */
export type DiffApprovalKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Pending-edit review UI copy. */
    'diff-approval': DiffApprovalKey
  }
}

/** English pending-edit review messages. */
export const en = {
  'panel.title': 'Pending changes',
  'panel.empty': 'No pending changes',
  'panel.loading': 'Reading…',
  'panel.readFailed': 'Reading pending changes failed: {message}',
  'panel.group.current': 'This session',
  'panel.group.others': 'Other sessions',
  'panel.aria': 'Pending changes',
  'panel.stats': '+{added} -{removed}',
  'panel.selectHint': 'Select an item to review its whole-file diff; drag lines to copy a reference',
  'panel.missing': 'File is gone',
  'panel.missingHint': 'This file no longer exists; reverting restores it.',
  'panel.createHint': 'Reverting removes this created file.',
  'row.create': 'New file',
  'row.added': '+{added}',
  'row.removed': '-{removed}',
  'action.keep': 'Keep',
  'action.revert': 'Revert',
  'action.openFile': 'Open file',
  'action.revealFile': 'Reveal in folder',
  'action.busy': 'Working…',
  'action.prevDiff': 'Previous diff',
  'action.nextDiff': 'Next diff',
  'action.copyRange': 'Copy reference',
  'action.copied': 'Copied',
  'status.kept': 'Kept',
  'status.reverted': 'Reverted',
  'status.missing': 'This change no longer exists',
} satisfies Record<DiffApprovalKey, string>
