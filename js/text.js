/** Clean common OCR border noise and typography while preserving English spaces. */
export function cleanText(text) {
  const cjk = '[\\u3400-\\u9fff\\uf900-\\ufaff]';
  const punctuation = { ',': '，', '.': '。', ':': '：', ';': '；', '!': '！', '?': '？', '(': '（', ')': '）' };
  return text.replace(/\r\n?/g, '\n')
    .split('\n').map(line => /^[|¦lI_—.\s]*$/u.test(line) ? '' : line.replace(/^\s*\|\s+/, ''))
    .join('\n')
    .replace(new RegExp(`(${cjk})[ \\t]+(?=${cjk})`, 'gu'), '$1')
    .replace(new RegExp(`(${cjk})([,.:;!?()])|([,.:;!?()])(?=${cjk})`, 'gu'), (_, before, after, preceding) => before ? before + punctuation[after] : punctuation[preceding])
    .replace(/\n(?:[ \t]*\n){3,}/g, '\n\n\n');
}
