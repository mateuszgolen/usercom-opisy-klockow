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

  const state = { id: null, name: '', graph: null, original: null, cells: null, mods: [], dirty: new Set(), view: 'opisy' };

  /* ---------------- graf ---------------- */

  const descHtml = (cell) => cell.attrs && cell.attrs.description && cell.attrs.description.html;

  // DOMParser na kilkudziesięciu blokach kosztuje zauważalnie, a ten sam opis
  // czytamy przy każdym przerysowaniu — trzymamy wynik obok źródła, z którego
  // powstał, żeby unieważnił się sam po edycji.
  const descCache = new WeakMap();

  const readDesc = (cell) => {
    const html = descHtml(cell);
    if (!html) return null;
    const hit = descCache.get(cell);
    if (hit && hit.html === html) return hit.text;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const text = (doc.body.innerText || '').replace(/\s+/g, ' ').trim();
    descCache.set(cell, { html: html, text: text });
    return text;
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
        original: JSON.stringify(graph),   // odcisk stanu z chwili wczytania
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
    state.original = data.original;
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

    // Zapisujemy CAŁY graf, więc gdyby ktoś zmienił tę automatyzację od czasu
    // wczytania, jego zmiana zniknęłaby bez śladu. Sprawdzamy to przed zapisem.
    const fresh = await (await fetch(url, { credentials: 'include' })).json();
    const freshGraph = typeof fresh.graph === 'string' ? JSON.parse(fresh.graph) : fresh.graph;
    if (state.original && JSON.stringify(freshGraph) !== state.original) {
      throw new Error(
        'Ta automatyzacja zmieniła się na serwerze od czasu wczytania — ktoś ją edytuje ' +
        'albo zapisała ją druga zakładka. Nic nie zapisałem, żeby nie skasować tamtych zmian.\n' +
        'Skopiuj swoje opisy, kliknij „Wczytaj ponownie” i wprowadź je jeszcze raz.');
    }

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

    if (await attempt('PATCH graph', 'PATCH', async () => JSON.stringify({ graph: graphStr }))) {
      state.original = graphStr;
      return { variant: 'PATCH graph', log };
    }

    // Zapas: pełny PUT. Pobieramy świeży rekord, żeby nie nadpisać cudzych zmian
    // w polach, których nie dotykamy.
    const ok = await attempt('PUT pełny rekord', 'PUT', async () => {
      const cur = await (await fetch(url, { credentials: 'include' })).json();
      delete cur.id;
      return JSON.stringify(Object.assign(cur, { graph: graphStr }));
    });
    if (ok) {
      state.original = graphStr;
      return { variant: 'PUT pełny rekord', log };
    }

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

  /* ---------------- schemat przebiegu ----------------
   *
   * Kanwa rozkłada bloki w przestrzeni, więc przy kilkunastu gałęziach linie
   * plączą się i nie widać, co po czym następuje. Tu ten sam graf jest
   * rozwinięty w drzewo: prosty ciąg leci płasko jedna pozycja pod drugą,
   * a wcięcie pojawia się dopiero tam, gdzie ścieżka faktycznie się rozdziela.
   */

  const PORT_PL = {
    yes: 'TAK', no: 'NIE', a: 'A', b: 'B',
    'on sent': 'wysłany', 'on open': 'otwarty', 'on click': 'kliknięty',
    unsubscribe: 'wypisał się', time: 'po czasie'
  };
  const portLabel = (p) => (!p || p === 'out' || p === 'in') ? '' : (PORT_PL[p] || p);

  const PORT_ORDER = ['out', 'yes', 'a', 'on sent', 'on open', 'on click', 'time', 'no', 'b', 'unsubscribe'];
  const portRank = (p) => { const i = PORT_ORDER.indexOf(p); return i < 0 ? 50 : i; };

  function delayDays(cell) {
    const t = cell.settings && cell.settings.timeout;
    return typeof t === 'number' && isFinite(t) ? t / 86400 : 0;
  }

  function dayLabel(days) {
    if (days <= 0) return 'D+0';
    if (days < 1) return '+' + Math.round(days * 24) + ' godz.';
    const d = Math.round(days * 10) / 10;
    return 'D+' + (Number.isInteger(d) ? d : d.toFixed(1));
  }

  /* Krótka podpowiedź z ustawień, gdy blok nie ma własnego opisu. */
  function hint(cell) {
    const st = cell.settings || {};
    switch (cell.itemType) {
      case 'delay': {
        const days = delayDays(cell);
        if (!days) return '';
        return days < 1 ? Math.round(days * 24) + ' godz.' : Math.round(days * 10) / 10 + ' dni';
      }
      case 'tags': case 'tags_remove': return st.tags || '';
      case 'segment': return st.segment ? 'segment #' + st.segment : '';
      case 'email': return 'kampania niepodpięta';
      default: return '';
    }
  }

  function flowModel() {
    const mods = state.cells.filter((c) => c.type !== 'link');
    const byId = new Map(mods.map((c) => [c.id, c]));
    const edges = new Map();
    const hasIncoming = new Set();
    state.cells.filter((c) => c.type === 'link').forEach((l) => {
      const from = l.source && l.source.id;
      const to = l.target && l.target.id;
      if (!from || !to || !byId.has(from) || !byId.has(to)) return;
      if (!edges.has(from)) edges.set(from, []);
      edges.get(from).push({ port: (l.source.port || 'out'), to: to });
      hasIncoming.add(to);
    });
    edges.forEach((list) => list.sort((a, b) => portRank(a.port) - portRank(b.port)));
    return { mods, byId, edges, hasIncoming };
  }

  function renderFlow() {
    listEl.textContent = '';
    if (!state.cells) { renderPlaceholder('Wczytuję…'); return; }

    const { mods, byId, edges, hasIncoming } = flowModel();
    const stepOf = new Map();
    let counter = 0;
    let maxDays = 0;

    const nodeRow = (cell, num, days, showDay) => {
      const row = el('div', 'ucd-fnode');
      row.dataset.group = cell.itemGroup || '';
      const line = el('div', 'ucd-fline');
      line.append(el('span', 'ucd-fnum', String(num)));
      line.append(el('span', 'ucd-ftype', TYPE_PL[cell.itemType] || cell.itemType));
      if (showDay) line.append(el('span', 'ucd-fday', dayLabel(days)));
      row.append(line);
      const text = readDesc(cell) || hint(cell);
      if (text) row.append(el('div', 'ucd-fdesc', text));
      row.title = 'Pokaż ten blok na kanwie';
      row.addEventListener('click', () => { highlight(cell.id); });
      return row;
    };

    /* Odległości od danego węzła — wszerz, po całym osiągalnym fragmencie. */
    const distFrom = (startId) => {
      const dist = new Map([[startId, 0]]);
      const queue = [startId];
      while (queue.length) {
        const id = queue.shift();
        (edges.get(id) || []).forEach((e) => {
          if (dist.has(e.to) || !byId.has(e.to)) return;
          dist.set(e.to, dist.get(id) + 1);
          queue.push(e.to);
        });
      }
      return dist;
    };

    /* Punkt, w którym gałęzie znów się schodzą.
     *
     * To jest sedno czytelności. Przy bramce cappingu obie odnogi — „wyślij od
     * razu" i „poczekaj dzień, potem wyślij" — kończą na TYM SAMYM mailu. Bez
     * tego każda taka bramka spychała resztę scenariusza o wcięcie w prawo.
     * Wcinamy więc tylko to, co jest naprawdę osobne, a od miejsca zejścia
     * wracamy na główny poziom. */
    /* Czy KAŻDA ścieżka wychodząca z tej bramki musi przejść przez `j`.
     * Sama wspólna osiągalność nie wystarcza: w Torze B wszystkie bramki
     * „czy już zamówił" prowadzą do jednej, współdzielonej pary bloków
     * z tagami, więc ta para jest osiągalna zewsząd, a mimo to nie jest
     * miejscem, w którym gałęzie się schodzą. */
    const allPathsThrough = (outs, j) => {
      const seen = new Set();
      const stack = outs.map((o) => o.to);
      while (stack.length) {
        const id = stack.pop();
        if (id === j || seen.has(id)) continue;
        seen.add(id);
        if (stepOf.has(id)) return false;                 // nawrót do już pokazanego kroku
        const next = edges.get(id) || [];
        if (!next.length) return false;                   // ścieżka kończy się z pominięciem j
        next.forEach((e) => stack.push(e.to));
      }
      return true;
    };

    /* Ile NOWYCH kroków przyniesie gałąź; już ponumerowane liczą się jako zero,
     * bo wyrenderują się jako odnośnik. Używane tylko wtedy, gdy gałęzie się
     * nie schodzą — wtedy najgrubsza z nich jest główną ścieżką. */
    const subtreeSize = (startId) => {
      const seen = new Set();
      const stack = [startId];
      let n = 0;
      while (stack.length) {
        const id = stack.pop();
        if (seen.has(id) || stepOf.has(id) || !byId.has(id)) continue;
        seen.add(id);
        n += 1;
        (edges.get(id) || []).forEach((e) => stack.push(e.to));
      }
      return n;
    };

    const joinPoint = (outs) => {
      const dists = outs.map((o) => distFrom(o.to));
      const cands = [];
      dists[0].forEach((_, id) => {
        if (stepOf.has(id)) return;                       // już pokazany — to nawrót, nie zejście
        if (!dists.every((d) => d.has(id))) return;
        cands.push({ id: id, score: Math.max.apply(null, dists.map((d) => d.get(id))) });
      });
      cands.sort((a, b) => a.score - b.score);            // najbliższe zejście wygrywa
      for (const c of cands) if (allPathsThrough(outs, c.id)) return c.id;
      return null;
    };

    const walk = (startId, startDays, container, stopAt) => {
      let cur = startId;
      let days = startDays;
      for (;;) {
        if (stopAt && cur === stopAt) return;              // dalej ciągnie poziom wyżej
        if (stepOf.has(cur)) {
          container.append(el('div', 'ucd-fref', '↩ dalej jak w kroku ' + stepOf.get(cur)));
          return;
        }
        const cell = byId.get(cur);
        if (!cell) return;
        counter += 1;
        stepOf.set(cur, counter);

        const isDelay = cell.itemType === 'delay';
        if (isDelay) days += delayDays(cell);
        if (days > maxDays) maxDays = days;
        const sends = cell.itemType === 'email' || cell.itemType === 'sms_campaign';
        container.append(nodeRow(cell, counter, days, isDelay || sends));

        const outs = edges.get(cur) || [];
        if (!outs.length) {
          container.append(el('div', 'ucd-fend', 'koniec ścieżki'));
          return;
        }
        const portChip = (port) =>
          el('span', 'ucd-fport' + (port === 'no' || port === 'b' ? ' ucd-fport-alt' : ''), portLabel(port) || '→');

        // Jedno wyjście to nie rozgałęzienie, choćby port miał nazwę. Wcinanie
        // takich kroków spychało cały scenariusz w prawo przy każdej bramce,
        // której druga odnoga jest niepodłączona.
        if (outs.length === 1) {
          const lab = portLabel(outs[0].port);
          if (lab) {
            const line = el('div', 'ucd-fcont');
            line.append(portChip(outs[0].port));
            container.append(line);
          }
          cur = outs[0].to;
          continue;
        }

        const join = joinPoint(outs);

        // Gdy gałęzie się nie schodzą (np. bramka „czy już zamówił": jedna
        // odnoga przerzuca na inny tor i kończy), najgrubsza z nich zostaje
        // główną ścieżką i idzie płasko, a reszta na bok.
        let mainAt = -1;
        if (!join) {
          const sizes = outs.map((o) => subtreeSize(o.to));
          mainAt = 0;
          for (let k = 1; k < outs.length; k += 1) if (sizes[k] > sizes[mainAt]) mainAt = k;
        }

        const box = el('div', 'ucd-fbranches');
        outs.forEach((o, k) => {
          if (k === mainAt) return;
          const br = el('div', 'ucd-fbranch');
          br.append(portChip(o.port));
          if (join && o.to === join) {
            br.append(el('span', 'ucd-fskip', 'prosto dalej'));
          } else {
            const inner = el('div', 'ucd-fbin');
            walk(o.to, days, inner, join || stopAt);
            br.append(inner);
          }
          box.append(br);
        });
        if (box.children.length) container.append(box);

        // Dni liczymy ścieżką bez objazdu — pętelka cappingu ma opóźniać,
        // a nie przesuwać całego harmonogramu.
        if (join) { cur = join; continue; }

        const main = outs[mainAt];
        if (portLabel(main.port)) {
          const line = el('div', 'ucd-fcont');
          line.append(portChip(main.port));
          container.append(line);
        }
        cur = main.to;
        continue;
      }
    };

    // Notatki „Własny opis" nie są krokiem scenariusza — wisiały w drzewie jako
    // osobny START i tylko zaciemniały obraz.
    const isNote = (m) => m.itemType === 'features_html';
    const notes = mods.filter(isNote);
    const steps = mods.filter((m) => !isNote(m));

    const triggers = steps.filter((m) => !hasIncoming.has(m.id) && m.itemGroup === 'trigger');
    const starts = triggers.length
      ? triggers
      : steps.filter((m) => !hasIncoming.has(m.id));

    starts.forEach((t) => {
      const sec = el('div', 'ucd-fsection');
      sec.append(el('div', 'ucd-fhead', 'START'));
      walk(t.id, 0, sec);
      listEl.append(sec);
    });

    const orphans = steps.filter((m) => !stepOf.has(m.id));
    if (orphans.length) {
      const sec = el('div', 'ucd-fsection ucd-forphans');
      sec.append(el('div', 'ucd-fhead', 'NIE PODŁĄCZONE — te bloki nigdy się nie wykonają'));
      orphans.forEach((m) => walk(m.id, 0, sec));
      listEl.append(sec);
    }

    if (notes.length) {
      const sec = el('div', 'ucd-fsection');
      sec.append(el('div', 'ucd-fhead', 'NOTATKI NA KANWIE — poza przebiegiem'));
      notes.forEach((m) => {
        const row = el('div', 'ucd-fnode');
        row.append(el('div', 'ucd-fdesc', readDesc(m) || '(pusta notatka)'));
        row.addEventListener('click', () => { highlight(m.id); });
        sec.append(row);
      });
      listEl.append(sec);
    }

    const mails = steps.filter((m) => m.itemType === 'email').length;
    const parts = [steps.length + ' kroków'];
    if (mails) parts.push(mails + (mails === 1 ? ' mail' : ' maili'));
    if (maxDays > 0) parts.push('ścieżka do ' + dayLabel(maxDays));
    if (orphans.length) parts.push(orphans.length + ' nie podłączonych');
    if (notes.length) parts.push(notes.length + (notes.length === 1 ? ' notatka' : ' notatki'));
    panel.querySelector('.ucd-sub').textContent = '#' + state.id + ' · ' + parts.join(' · ');
  }

  function renderCurrent() {
    if (state.view === 'schemat') renderFlow();
    else { renderList(); panel.querySelector('.ucd-sub').textContent = describeLoaded(); }
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
      renderCurrent();
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
      renderCurrent();
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

    const tabs = el('div', 'ucd-tabs');
    const mkTab = (key, label, title) => {
      const b = el('button', 'ucd-tab' + (state.view === key ? ' ucd-tab-on' : ''), label);
      b.title = title;
      b.dataset.view = key;
      b.addEventListener('click', () => {
        if (state.view === key) return;
        state.view = key;
        tabs.querySelectorAll('.ucd-tab').forEach((t) => t.classList.toggle('ucd-tab-on', t.dataset.view === key));
        panel.classList.toggle('ucd-reading', key === 'schemat');
        if (state.cells) renderCurrent();
      });
      return b;
    };
    tabs.append(
      mkTab('opisy', 'Opisy', 'Edytuj podpisy bloków'),
      mkTab('schemat', 'Schemat', 'Ten sam scenariusz rozwinięty w drzewo przebiegu')
    );

    listEl = el('div', 'ucd-list');

    const foot = el('div', 'ucd-foot');
    saveBtn = el('button', 'ucd-btn ucd-btn-primary', 'Zapisz zmiany');
    saveBtn.disabled = true;
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      setStatus('Zapisuję…');
      try {
        const out = await save();
        if (!out) { markDirty(); setStatus('Nie ma czego zapisywać.', 'warn'); return; }
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
    panel.append(hd, warn, tabs, listEl, foot, statusEl);
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
    state.original = null;
    state.id = null;
    markDirty();                                         // bez tego licznik zostawał z poprzedniej automatyzacji
    setStatus('');
    if (!id) { toggle(false); return; }
    prepare(id, true);                                   // pobieramy z wyprzedzeniem
    // show(false), nie show(true) — stan jest już wyczyszczony, więc panel
    // podepnie się pod TO żądanie zamiast wywoływać drugie takie samo
    if (!panel.classList.contains('ucd-hidden')) show(false);
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

  // Niezapisane opisy żyją tylko w pamięci karty — ostrzegamy przed ich utratą.
  window.addEventListener('beforeunload', (e) => {
    if (!state.dirty.size) return;
    e.preventDefault();
    e.returnValue = '';
  });

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
