export interface NotesCopy {
  title: string;
  inputPlaceholder: string;
  quickPlaceholder: string;
  todo: string;
  completed: string;
  clear: string;
  handoff: string;
  edit: string;
  save: string;
  cancel: string;
  delete: string;
  viewAll: string;
  empty: string;
  privateHint: string;
  enter: string;
  escape: string;
  completeNote: string;
  reopenNote: string;
}

export const NOTES_COPY: { en: NotesCopy; zh: NotesCopy } = {
  en: {
    title: 'Notes',
    inputPlaceholder: 'Note something to do…',
    quickPlaceholder: 'Quick note…',
    todo: 'TO DO',
    completed: 'Completed',
    clear: 'Clear',
    handoff: 'Hand to agent',
    edit: 'Edit',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    viewAll: 'View all',
    empty: 'No open notes',
    privateHint: 'Private notes · not read by agents',
    enter: '↵',
    escape: 'esc',
    completeNote: 'complete note',
    reopenNote: 'reopen note',
  },
  zh: {
    title: '笔记',
    inputPlaceholder: '记一条要干什么…',
    quickPlaceholder: '快速记一条…',
    todo: '待办',
    completed: '已完成',
    clear: '清除',
    handoff: '交给 agent',
    edit: '编辑',
    save: '保存',
    cancel: '取消',
    delete: '删除',
    viewAll: '查看全部',
    empty: '没有未完成笔记',
    privateHint: '私人备忘 · agent 不读取',
    enter: '↵',
    escape: 'esc',
    completeNote: '完成笔记',
    reopenNote: '重新打开笔记',
  },
};
