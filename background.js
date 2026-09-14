/* Kliknięcie ikonki wtyczki na pasku Chrome otwiera panel na aktywnej karcie.
 *
 * Content script biegnie w świecie MAIN (żeby zapis do API działał), a tam nie
 * ma `chrome.runtime` — więc zamiast wiadomości wstrzykujemy jednorazowe
 * wywołanie do tego samego świata i wołamy funkcję, którą skrypt tam zostawił.
 */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id || !/^https:\/\/[^/]+\.user\.com\//.test(tab.url || '')) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => (typeof window.__ucdToggle === 'function' ? window.__ucdToggle() : 'not-loaded')
    });
  } catch (e) {
    // strona poza zakresem wtyczki albo jeszcze się ładuje — nic nie robimy
  }
});
