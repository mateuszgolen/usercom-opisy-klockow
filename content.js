/* Positive User — opisy klocków
 *
 * Edytuje `attrs.description.html` bloków na kanwie automatyzacji i zapisuje
 * PATCH-em wyłącznie pole `graph`, żeby nie ruszyć statusu włączenia ani timingu.
 *
 * Skrypt biegnie w świecie MAIN (patrz manifest). Z izolowanego świata to samo
 * `fetch` idzie jako żądanie cross-origin z nagłówkiem `Origin: chrome-extension://…`
 * i serwer je odrzuca — mimo że identyczne wywołanie ze strony zwraca 200.
 */
(() => {
  'use strict';
  if (window.__ucdLoaded) return;
  window.__ucdLoaded = true;

  const API = '/automations/api/v3/automations/';
  const idFromPath = () => (location.pathname.match(/\/automation\/create\/(\d+)/) || [])[1] || null;
  const csrf = () => (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';

  /* Bloki, dla których pole `description` NIE jest tym, co widać na kanwie.
   * Edytowanie ich tutaj nie dałoby żadnego efektu, więc blokujemy je
   * i mówimy wprost, gdzie iść zamiast tego. */
  const SPECIAL = {
    email:
      'Ten blok odtwarza swój opis z ustawień przy każdym wczytaniu kanwy — wpisany tekst by nie przetrwał. ' +
      'Podpisz zamiast tego blok stojący bezpośrednio przed nim (opóźnienie albo sprawdzenie cappingu).',
    features_html:
      'To notatka „Własny opis”. Tekst, który widać na kanwie, siedzi we własnej treści bloku, nie w tym polu — ' +
      'kliknij ten blok na kanwie i edytuj go w panelu po prawej.'
  };

  const TYPE_PL = {
    event: 'Wyzwalacz zdarzenia',
    tag_added: 'Dodano tag',
    tag_removed: 'Usunięto tag',
    new_user: 'Nowy kontakt',
    visit: 'Odwiedziny strony',
    product_event: 'Zdarzenie produktu',
    email_action_trigger: 'Akcja e-mail (wyzwalacz)',
    client_attribute_changed: 'Zmiana atrybutu kontaktu',
    timeout: 'Data i godzina',
    deal_stage_change: 'Zmiana etapu szansy',
    filters: 'Filtry',
    segment: 'Segment',
    time: 'Czas',
    ab: 'Podział A/B',
    emailaction: 'Akcja e-mail (warunek)',
    delay: 'Opóźnienie',
    email: 'Wyślij kampanię e-mail',
    sms_campaign: 'Wyślij kampanię SMS',
    tags: 'Dodaj tag',
    tags_remove: 'Usuń tag',
    create_event: 'Utwórz zdarzenie',
    change_integer_attribute: 'Zmień atrybut liczbowy',
    field: 'Zaktualizuj atrybut',
    json_payload: 'Wywołanie API',
    activity: 'Aktywność',
    block: 'Blok',
    update_company: 'Atrybut firmy',
    features_html: 'Własny opis (notatka)'
  };

  const state = { id: null, name: '', graph: null, cells: null, mods: [], dirty: new Set() };

  /* ---------------- graf ---------------- */

  const descHtml = (cell) => cell.attrs && cell.attrs.description && cell.attrs.description.html;

  const readDesc = (cell) => {
    const html = descHtml(cell);
    if (!html) return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return (doc.body.innerText || '').replace(/\s+/g, ' ').trim();
  };

  const writeDesc = (cell, text) => {
    const html = descHtml(cell);
    if (!html) return false;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const div = doc.body.firstElementChild;
    if (!div) return false;
    div.textContent = text;           // zachowujemy wrapper (style + xmlns), zmieniamy tylko tekst
    cell.attrs.description.html = div.outerHTML;
    return true;
  };

  /* ---------------- pobieranie z wyprzedzeniem ----------------
   *
   * GET automatyzacji trwa ~0,5 s. Gdyby startował dopiero po kliknięciu,
   * panel zawsze otwierałby się z zauważalnym opóźnieniem — więc startuje
   * w momencie wejścia na kanwę i do kliknięcia jest już po wszystkim.
   */

  const cache = { id: null, promise: null, data: null };

  function fetchAutomation(id, attempt) {
    attempt = attempt || 0;
    return fetch(API + id + '/', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error('Serwer odpowiedział HTTP ' + res.status);
        return res.json();
      })
      .catch((err) => {
        if (attempt >= 2) throw err;   // dwie ciche ponowne próby — SPA bywa zajęta przy starcie
        return new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
          .then(() => fetchAutomation(id, attempt + 1));
      });
  }

  function prepare(id, force) {
    if (!force && cache.id === id && cache.promise) return cache.promise;
    cache.id = id;
    cache.data = null;
    cache.promise = fetchAutomation(id).then((j) => {
      const graph = typeof j.graph === 'string' ? JSON.parse(j.graph) : j.graph;
      if (!graph || !Array.isArray(graph.cells)) throw new Error('Serwer nie oddał grafu tej automatyzacji.');
      const data = {
        id: id,
        name: j.name || ('#' + id),
        graph: graph,
        cells: graph.cells,
        mods: graph.cells
          .filter((c) => c.type !== 'link')
          .sort((a, b) => (a.position.x - b.position.x) || (a.position.y - b.position.y))
      };
      cache.data = data;
      return data;
    });
    cache.promise.catch(() => { /* obsłużone tam, gdzie się czeka */ });
    return cache.promise;
  }

  function adopt(data) {
    state.id = data.id;
    state.name = data.name;
    state.graph = data.graph;
    state.cells = data.cells;
    state.mods = data.mods;
    state.dirty.clear();
  }

  /* ---------------- zapis ----------------
   *
   * Ustalone doświadczalnie na żywym API, na jednorazowej automatyzacji:
   *   PATCH {graph: "<JSON jako STRING>"}  -> 200, zmiana się utrwala
   *   PATCH {graph: {...obiekt...}}        -> 400 {"graph":["Not a valid string."]}
   *   PUT   <pełny rekord + graph string>  -> 200, też działa
   * `graph` bywa pokazywany w OPTIONS jako read_only — to mylące, zapis działa.
   *
   * Wysyłamy CAŁY obiekt grafu (z kluczem `z`), a nie same `cells`, żeby nie
   * zgubić pól, których nie rozumiemy. is_enabled i schedule zostają nietknięte.
   */
  async function save() {
    if (!state.dirty.size) return;
    if (!state.id || !state.graph) throw new Error('Nic nie jest wczytane — kliknij „Wczytaj ponownie”.');

    const probeId = [...state.dirty][0];
    const expected = readDesc(state.cells.find((c) => c.id === probeId));
    const graphStr = JSON.stringify(Object.assign({}, state.graph, { cells: state.cells }));
    const url = API + state.id + '/';
    const headers = { 'Content-Type': 'application/json', 'X-CSRFToken': csrf() };

    const verify = async () => {
      const j = await (await fetch(url, { credentials: 'include' })).json();
      const g = typeof j.graph === 'string' ? JSON.parse(j.graph) : j.graph;
      const back = (g.cells || []).find((c) => c.id === probeId);
      return !!back && readDesc(back) === expected;
    };

    const log = [];
    const attempt = async (label, method, buildBody) => {
      let res;
      try {
        res = await fetch(url, { method, credentials: 'include', headers, body: await buildBody() });
      } catch (e) {
        log.push(label + ': nie udało się wysłać żądania (' + e.message + ')');
        return false;
      }
      if (!res.ok) {
        // najważniejsze: pokazujemy, CO serwer odrzucił, zamiast samego kodu
        let txt = '';
        try { txt = (await res.text()).slice(0, 400); } catch (e) { /* ignore */ }
        log.push(label + ': HTTP ' + res.status + (txt ? ' — ' + txt : ''));
        return false;
      }
      let ok = false;
      try { ok = await verify(); } catch (e) { /* ok zostaje false */ }
      log.push(label + ': HTTP ' + res.status + (ok ? ' ✓' : ' — serwer przyjął, ale opis nie wrócił zmieniony'));
      return ok;
    };

    if (await attempt('PATCH graph', 'PATCH', async () => JSON.stringify({ graph: graphStr })))
      return { variant: 'PATCH graph', log };

    // Zapas: pełny PUT. Pobieramy świeży rekord, żeby nie nadpisać cudzych zmian
    // w polach, których nie dotykamy.
    const ok = await attempt('PUT pełny rekord', 'PUT', async () => {
      const cur = await (await fetch(url, { credentials: 'include' })).json();
      delete cur.id;
      return JSON.stringify(Object.assign(cur, { graph: graphStr }));
    });
    if (ok) return { variant: 'PUT pełny rekord', log };

    const err = new Error('Nie udało się zapisać.\n' + log.join('\n'));
    err.log = log;
    throw err;
  }

  /* ---------------- podświetlanie na kanwie ---------------- */

  function highlight(cellId) {
    document.querySelectorAll('.ucd-hi').forEach((e) => e.classList.remove('ucd-hi'));
    let node = null;
    try { node = document.querySelector('[model-id="' + CSS.escape(cellId) + '"]'); } catch (e) { /* ignore */ }
    if (!node) return false;
    node.classList.add('ucd-hi');
    node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    return true;
  }

  /* ---------------- UI ---------------- */

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  let panel, listEl, statusEl, saveBtn, launcher;

  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'ucd-status' + (kind ? ' ucd-' + kind : '');
  }

  function markDirty() {
    saveBtn.disabled = state.dirty.size === 0;
    saveBtn.textContent = state.dirty.size
      ? 'Zapisz zmiany (' + state.dirty.size + ')'
      : 'Zapisz zmiany';
  }

  function setHeader(name, sub) {
    panel.querySelector('.ucd-name').textContent = name;
    panel.querySelector('.ucd-sub').textContent = sub;
  }

  function renderPlaceholder(text) {
    listEl.textContent = '';
    listEl.append(el('div', 'ucd-empty', text));
  }

  function describeLoaded() {
    return '#' + state.id + ' · ' + state.mods.length + ' bloków · kolejność jak na kanwie, od lewej';
  }

  function renderList() {
    listEl.textContent = '';
    state.mods.forEach((cell, i) => {
      const row = el('div', 'ucd-row');

      const head = el('div', 'ucd-rowhead');
      const idx = el('span', 'ucd-idx', String(i + 1));
      const type = el('span', 'ucd-type', TYPE_PL[cell.itemType] || cell.itemType);
      const show = el('button', 'ucd-show', 'pokaż');
      show.title = 'Podświetl ten blok na kanwie';
      show.addEventListener('click', () => {
        if (!highlight(cell.id)) setStatus('Nie znalazłem tego bloku w DOM — przewiń kanwę i spróbuj ponownie.', 'warn');
        else setStatus('');
      });
      head.append(idx, type, show);

      const hasField = !!descHtml(cell);
      const special = SPECIAL[cell.itemType];

      if (!hasField) {
        head.append(el('span', 'ucd-chip ucd-chip-mute', 'brak pola opisu'));
        row.append(head);
      } else if (special) {
        head.append(el('span', 'ucd-chip ucd-chip-warn', 'nie tutaj'));
        const ta = el('textarea', 'ucd-ta');
        ta.value = readDesc(cell) || '';
        ta.disabled = true;
        row.append(head, ta, el('p', 'ucd-note', special));
      } else {
        const ta = el('textarea', 'ucd-ta');
        ta.value = readDesc(cell) || '';
        ta.rows = 2;
        ta.spellcheck = false;
        ta.addEventListener('input', () => {
          if (writeDesc(cell, ta.value)) {
            state.dirty.add(cell.id);
            row.classList.add('ucd-changed');
            markDirty();
          }
        });
        ta.addEventListener('focus', () => highlight(cell.id));
        row.append(head, ta);
      }

      listEl.append(row);
    });
  }

  /* Pokazuje zawartość panelu. Gdy dane są już pobrane — a zwykle są, bo
   * pobieranie rusza przy wejściu na kanwę — dzieje się to w tej samej klatce. */
  function show(force) {
    const id = idFromPath();
    if (!id) { renderPlaceholder('To nie jest widok automatyzacji.'); setStatus(''); return; }
    if (!force && state.cells && state.id === id) return;              // już wyrenderowane
    if (!force && state.dirty.size) return;                            // nie depczemy niezapisanych zmian

    if (cache.data && cache.data.id === id) {                          // gotowe — bez migania
      adopt(cache.data);
      setHeader(state.name, describeLoaded());
      renderList();
      markDirty();
      setStatus('');
      return;
    }

    setHeader('Opisy klocków', 'wczytuję automatyzację #' + id + '…');
    renderPlaceholder('Wczytuję…');
    prepare(id, force).then((data) => {
      if (idFromPath() !== data.id) return;                            // trasa zmieniła się w międzyczasie
      adopt(data);
      setHeader(state.name, describeLoaded());
      renderList();
      markDirty();
      setStatus('');
    }).catch((e) => {
      renderPlaceholder('Nie udało się wczytać.');
      setStatus(e.message, 'err');
    });
  }

  function buildPanel() {
    panel = el('div', 'ucd-panel ucd-hidden');
    panel.id = 'ucd-panel';

    const hd = el('div', 'ucd-head');
    const titles = el('div', 'ucd-titles');
    titles.append(el('div', 'ucd-name', 'Opisy klocków'), el('div', 'ucd-sub', 'nie wczytano'));
    const close = el('button', 'ucd-x', '×');
    close.title = 'Zamknij';
    close.addEventListener('click', () => toggle(false));
    hd.append(titles, close);

    const warn = el('p', 'ucd-warnbar',
      'Zapis nadpisuje graf tej automatyzacji. Zamknij ją w innych zakładkach — kliknięcie tam „Save” cofnęłoby te zmiany.');

    listEl = el('div', 'ucd-list');

    const foot = el('div', 'ucd-foot');
    saveBtn = el('button', 'ucd-btn ucd-btn-primary', 'Zapisz zmiany');
    saveBtn.disabled = true;
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      setStatus('Zapisuję…');
      try {
        const out = await save();
        state.dirty.clear();
        markDirty();
        setStatus('Zapisano i zweryfikowano (' + out.variant + '). Przeładuj stronę, żeby zobaczyć opisy na kanwie.', 'ok');
        panel.querySelectorAll('.ucd-changed').forEach((r) => r.classList.remove('ucd-changed'));
      } catch (e) {
        setStatus(e.message + '\nJeśli ta automatyzacja jest otwarta w innej zakładce — zamknij ją i spróbuj ponownie.', 'err');
        markDirty();
      }
    });

    const reloadBtn = el('button', 'ucd-btn', 'Wczytaj ponownie');
    reloadBtn.addEventListener('click', () => {
      if (state.dirty.size && !confirm('Masz niezapisane zmiany. Wczytać od nowa i je porzucić?')) return;
      state.dirty.clear();
      show(true);
    });

    const backupBtn = el('button', 'ucd-btn', 'Kopiuj backup');
    backupBtn.title = 'Kopiuje aktualny graf do schowka';
    backupBtn.addEventListener('click', async () => {
      if (!state.graph) { setStatus('Najpierw wczytaj automatyzację.', 'warn'); return; }
      try {
        await navigator.clipboard.writeText(JSON.stringify(state.graph));
        setStatus('Graf skopiowany do schowka.', 'ok');
      } catch (e) {
        setStatus('Schowek niedostępny — kliknij najpierw gdziekolwiek na stronie.', 'warn');
      }
    });

    const pageBtn = el('button', 'ucd-btn', 'Przeładuj stronę');
    pageBtn.addEventListener('click', () => location.reload());

    statusEl = el('div', 'ucd-status');

    foot.append(saveBtn, reloadBtn, backupBtn, pageBtn);
    panel.append(hd, warn, listEl, foot, statusEl);
  }

  function buildLauncher() {
    launcher = el('button', 'ucd-launcher');
    launcher.title = 'Edytuj opisy bloków tej automatyzacji';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('aria-hidden', 'true');
    [[2.5, 3, 19, 9, 2.5, 1], [2.5, 15, 13, 2.4, 1.2, 0.55], [2.5, 19.4, 8.5, 2.4, 1.2, 0.55]]
      .forEach(([x, y, w, h, r, o]) => {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', x); rect.setAttribute('y', y);
        rect.setAttribute('width', w); rect.setAttribute('height', h);
        rect.setAttribute('rx', r); rect.setAttribute('fill', 'currentColor');
        rect.setAttribute('opacity', o);
        svg.append(rect);
      });

    launcher.append(svg, el('span', null, 'Opisy klocków'));
    // kanwa łapie zdarzenia myszy — nie pozwalamy jej zjeść kliknięcia
    launcher.addEventListener('mousedown', (e) => e.stopPropagation());
    launcher.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  }

  function toggle(want) {
    const willShow = want != null ? want : panel.classList.contains('ucd-hidden');
    panel.classList.toggle('ucd-hidden', !willShow);
    launcher.classList.toggle('ucd-active', willShow);
    if (willShow) show(false);
  }

  /* Panel da się otworzyć też ikonką wtyczki na pasku Chrome. */
  window.__ucdToggle = () => {
    mount();
    if (!idFromPath()) return 'not-automation';
    toggle(true);
    return 'ok';
  };

  /* ---------------- montowanie i trasy ----------------
   *
   * Aplikacja jest SPA i potrafi przebudować DOM pod sobą, a przy przejściu
   * między widokami Chrome nie wstrzykuje skryptu ponownie. Dlatego skrypt
   * ładuje się na całym /v3/*, sam pilnuje swojego przycisku i sam zauważa
   * zmianę trasy.
   */

  function mount() {
    if (!document.body) return;
    launcher.classList.toggle('ucd-off', !idFromPath());
    if (!launcher.isConnected) document.body.append(launcher);
    if (!panel.isConnected) document.body.append(panel);
  }

  let lastId = null;
  function onRoute() {
    const id = idFromPath();
    mount();
    if (id === lastId) return;
    lastId = id;
    state.dirty.clear();
    state.cells = null;
    state.graph = null;
    state.id = null;
    if (!id) { toggle(false); return; }
    prepare(id, true);                                   // pobieramy z wyprzedzeniem
    if (!panel.classList.contains('ucd-hidden')) show(true);
  }

  // SPA zmienia trasę przez history API — podpinamy się pod nie zamiast odpytywać w pętli
  ['pushState', 'replaceState'].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function () {
      const r = orig.apply(this, arguments);
      queueMicrotask(onRoute);
      return r;
    };
  });
  window.addEventListener('popstate', onRoute);

  buildLauncher();
  buildPanel();
  onRoute();

  // Doklejamy przycisk z powrotem, jeśli aplikacja wyczyści <body>.
  // Obserwujemy TYLKO bezpośrednie dzieci <body> — nasze węzły tam siedzą,
  // a nasłuch na całym drzewie kosztowałby przy każdym odrysowaniu kanwy.
  if (document.body) {
    new MutationObserver(() => {
      if (!launcher.isConnected || !panel.isConnected) mount();
    }).observe(document.body, { childList: true });
  }
})();
