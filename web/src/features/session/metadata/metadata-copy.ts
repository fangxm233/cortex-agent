import type { Lang } from '@/i18n';

const COPY = {
  en: {
    star: 'Star', unstar: 'Unstar', rename: 'Rename', title: 'Session title',
    save: 'Save', saving: 'Saving…', cancel: 'Cancel', close: 'Close',
    invalidTitle: 'Enter a title of 1–60 characters.',
    failed: 'Could not update the session.',
  },
  zh: {
    star: '添加星标', unstar: '取消星标', rename: '重命名', title: '会话标题',
    save: '保存', saving: '保存中…', cancel: '取消', close: '关闭',
    invalidTitle: '请输入 1–60 个字符的标题。',
    failed: '无法更新会话。',
  },
};

export const metadataCopy = (lang: Lang) => COPY[lang];
