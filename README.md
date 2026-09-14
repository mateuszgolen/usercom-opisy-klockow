# Positive User — opisy klocków

Wtyczka do Chrome, która pozwala edytować **opisy bloków** na kanwie automatyzacji
w user.com / Positive User — te małe podpisy pod tytułem klocka, dzięki którym
scenariusz da się czytać bez otwierania każdego bloku po kolei.

Kanwa nie ma na to własnego pola. Opis siedzi w grafie automatyzacji, w
`attrs.description.html` każdej komórki, i normalnie da się go ustawić tylko
przez API. Wtyczka robi z tego zwykły formularz.

## Instalacja

1. `chrome://extensions` → włącz **Tryb dewelopera**
2. **Załaduj rozpakowane** → wskaż ten katalog
3. Wejdź na dowolną automatyzację — przycisk „Opisy klocków" pojawi się w prawym
   dolnym rogu. Panel otwiera też ikonka wtyczki na pasku Chrome.

Panel ma dwie zakładki: **Opisy** (edycja podpisów) i **Schemat** (ten sam
scenariusz rozwinięty w czytelne drzewo przebiegu).

## Opisy

- listuje bloki **w kolejności jak na kanwie, od lewej** — numeracja w panelu
  odpowiada temu, co widać
- „pokaż" podświetla blok na kanwie i do niego przewija
- „Kopiuj backup" zrzuca cały graf do schowka przed zmianami
- zapisuje `PATCH`-em wyłącznie pole `graph`, więc **nie rusza** statusu
  włączenia automatyzacji ani jej ustawień czasowych
- po zapisie **czyta z serwera i sprawdza**, czy zmiana faktycznie weszła
- przed zapisem porównuje graf z serwerem i **odmawia**, jeśli ktoś zmienił
  automatyzację od czasu wczytania — zamiast po cichu nadpisać cudzą pracę

## Schemat

Kanwa rozkłada bloki w przestrzeni, więc przy kilkunastu gałęziach linie plączą
się i nie widać, co po czym następuje. Zakładka „Schemat" pokazuje ten sam graf
jako listę kroków:

- prosty ciąg leci płasko, jedna pozycja pod drugą, z numeracją zgodną
  z kolejnością wykonania
- wcięcie pojawia się **tylko tam, gdzie ścieżka naprawdę się rozdziela** —
  jeśli gałęzie schodzą się z powrotem (jak przy bramce cappingu: „wyślij od
  razu" kontra „poczekaj dzień, potem wyślij"), od punktu zejścia wracamy na
  główny poziom
- przy opóźnieniach i wysyłkach widać narastający czas (`D+3`, `D+14`…),
  liczony ścieżką bez objazdów
- nawroty pokazują się jako „dalej jak w kroku N" zamiast powielać całe gałęzie
- bloki, do których nic nie prowadzi, lądują w osobnej sekcji **„nie podłączone
  — nigdy się nie wykonają"**; na kanwie to jest niewidoczne, a taki blok po
  prostu milczy
- kliknięcie kroku podświetla go na kanwie

Nagłówek podsumowuje: ile kroków, ile maili, jak długa jest ścieżka.

Dwa typy bloków są celowo zablokowane, bo ich opis nie jest tym, co widać na
kanwie: kampanie e-mail (odtwarzają opis z ustawień przy każdym wczytaniu) oraz
notatki „Własny opis" (tekst siedzi we własnej treści bloku).

## Uwagi

Zmiany idą na serwer, do wspólnego grafu automatyzacji — **widzi je każdy, kto
ma dostęp do tego workspace'u**. To nie jest prywatna nakładka na widok.

Jeśli ta sama automatyzacja jest otwarta w innej zakładce, kliknięcie tam „Save"
nadpisze graf tym, co ta zakładka ma w pamięci, i cofnie zmiany. Zamknij duplikaty
przed zapisem.

## Jak to działa od środka

Skrypt biegnie w świecie **MAIN** (`"world": "MAIN"` w manifeście). Z domyślnego
izolowanego świata to samo `fetch` idzie jako żądanie cross-origin z nagłówkiem
`Origin: chrome-extension://…` i serwer je odrzuca — mimo że identyczne
wywołanie z kontekstu strony zwraca 200.

Kontrakt API, ustalony doświadczalnie na jednorazowej automatyzacji:

| Żądanie | Wynik |
|---|---|
| `PATCH {graph: "<JSON jako string>"}` | 200, zapisuje się |
| `PATCH {graph: {…obiekt…}}` | 400 `{"graph":["Not a valid string."]}` |
| `PUT` pełnego rekordu + graf jako string | 200, zapisuje się |

Dwie pułapki: `OPTIONS` raportuje `graph` jako read-only (nieprawda, zapis
działa), a `GET` oddaje `graph` jako **obiekt**, podczas gdy `POST`/`PATCH`
odsyłają go jako **string** — kod normalizuje to w obie strony.

Aplikacja jest SPA i przy przejściu między widokami Chrome nie wstrzykuje
skryptu ponownie, dlatego wtyczka ładuje się na całym `/v3/*`, sama pilnuje
swojego przycisku i sama zauważa zmianę trasy. Graf pobiera z wyprzedzeniem,
w momencie wejścia na kanwę — dzięki temu panel otwiera się od razu, a nie po
sekundzie oczekiwania na API.

## Licencja

MIT
