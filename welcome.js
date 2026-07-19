document.title = chrome.i18n.getMessage('welcomeTitle') || document.title;
document.querySelectorAll('[data-i18n]').forEach((el) => {
  const msg = chrome.i18n.getMessage(el.dataset.i18n);
  if (msg) el.textContent = msg;
});
// step2–step4 carry a static, developer-authored <strong> tag (no user input),
// so innerHTML here is safe — same trust boundary as the HTML this replaces.
document.querySelectorAll('[data-i18n-html]').forEach((el) => {
  const msg = chrome.i18n.getMessage(el.dataset.i18nHtml);
  if (msg) el.innerHTML = msg;
});
