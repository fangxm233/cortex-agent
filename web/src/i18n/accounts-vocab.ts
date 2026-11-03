// Named accounts beside a provider's default login (Settings → Accounts on desktop and mobile), and
// the account name used wherever a row, a login dialog or a status names one.
export const accountsEn = {
  accountsAccountName: '{provider} ({account})',
  accountsAddAccount: 'Add account',
  accountsAccountLabel: 'Account name',
  accountsAccountLabelPlaceholder: 'Name, e.g. School',
  accountsSignedOut: 'Logged out',
  accountsRemove: 'Delete',
  accountsRemoveConfirm: 'Delete this account? Sessions using it switch to the default account.',
  accountsRemoveDone: 'Deleted {account}',
  accountsRemoveFailed: 'Delete failed',
  accountsAccountLogoutConfirm: 'Sessions using it switch to the default account until you log in again.',
};

export const accountsZh: Record<keyof typeof accountsEn, string> = {
  accountsAccountName: '{provider}（{account}）',
  accountsAddAccount: '添加账号',
  accountsAccountLabel: '账号名称',
  accountsAccountLabelPlaceholder: '名称，例如 学校',
  accountsSignedOut: '已登出',
  accountsRemove: '删除',
  accountsRemoveConfirm: '删除这个账号？使用它的会话会改用默认账号。',
  accountsRemoveDone: '已删除 {account}',
  accountsRemoveFailed: '删除失败',
  accountsAccountLogoutConfirm: '重新登录之前，使用它的会话会改用默认账号。',
};
