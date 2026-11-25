# camt.053 naar PDF

Een webpagina die camt.053-bankafschriften (XML, versie 02 t/m 13) omzet naar leesbare PDF-rekeningafschriften.
De omzetting gebeurt volledig in de browser. Er gaat geen bestand naar een server.

**Pagina:** https://mathieu-butenaerts.github.io/gemeente-amsterdam-verbeterteam/

## Werkafspraken

Deze afspraken staan ook op de pagina, onder "Werkafspraken".

1. **Opslaan:** sla de PDF's op in een versleutelde werkmap die niet synchroniseert (geen OneDrive of Teams), of
   direct in de juiste dossiermap. Zet in de browser *Vragen waar elk bestand moet worden opgeslagen* aan
   (Edge: Instellingen → Downloads), dan kies je de map bij elke download.
2. **Opruimen:** ruim daarna de map Downloads op.
3. **Browser:** gebruik een browserprofiel zonder extensies. Extensies kunnen alles lezen wat op een pagina staat,
   en de beveiliging van de pagina (zie hieronder) geldt niet voor hen.
4. **Status van de PDF:** de PDF is geen officieel bankdocument. Het officiële stuk blijft het camt.053-bestand.

## Wat de pagina controleert

- **Hard falen.** Een bestand wordt afgekeurd, en er komt geen PDF, bij:
  - een ongeldig bedrag (bijvoorbeeld `1200,00`, `-5`, `1e3`, meer dan 5 decimalen of meer dan 18 cijfers);
  - een ontbrekend bedrag of een ontbrekende of ongeldige valuta;
  - een ongeldige `CdtDbtInd` of een saldo zonder type;
  - ongeldige tekens voor de opgegeven tekenset, of een bestand dat geen (camt.053-)XML is.

  De foutmelding noemt het afschrift en het transactie- of saldonummer.
- **Saldocontrole:** beginsaldo (`OPBD`, anders `PRCD`) + geboekte bijschrijvingen − geboekte afschrijvingen moet
  gelijk zijn aan het eindsaldo (`CLBD`).
  - Alleen transacties met status **BOOK** tellen mee. Andere transacties (bijv. `PDNG`) staan wel in de PDF,
    gemarkeerd als "niet meegeteld".
  - Er zijn drie uitkomsten, en die staan zowel in de PDF als op de pagina: **geslaagd**, **mislukt** (met beide
    bedragen) of **niet uitgevoerd**, met de reden: saldo ontbreekt, meerdere begin- of eindsaldi, of verschillende
    valuta's.

## Herleidbaarheid van een PDF

Onderaan elke pagina van de PDF staat:

> Geen officieel bankdocument – gegenereerd uit bestand `<naam>` · SHA-256 `<hash>`

Dezelfde hash staat ook in de documenteigenschappen van de PDF. Zo controleer je of een PDF uit een bepaald
bestand komt:

```powershell
Get-FileHash .\afschrift.xml -Algorithm SHA256
```

Is de uitkomst gelijk aan de hash op de PDF, dan is de PDF gemaakt uit precies dat bestand.

## Beveiliging

- **Content-Security-Policy** (in `docs/index.html`): `connect-src 'none'`, `form-action 'none'`,
  `default-src 'none'` en alleen scripts en stijlen van de eigen site. De browser blokkeert daarmee
  `fetch`/XHR/WebSockets/beacons, het laden van afbeeldingen of scripts van andere sites, formulieren, frames en
  `eval`. Dat geldt ook als een van de bibliotheken gecompromitteerd zou zijn. De tests controleren dat een
  uitgaande verbinding echt wordt geblokkeerd.
- **Wat een CSP níet tegenhoudt:** browserextensies, en het wegnavigeren van de hele pagina naar een andere site.
  Tegen het eerste helpt werkafspraak 3. Tegen het tweede helpen de vastgepinde bibliotheken hieronder: de
  browser voert alleen exact de gecontroleerde bestanden uit.
- **Subresource Integrity:** elke bibliotheek wordt geladen met een `integrity`-hash. Een gewijzigd bestand weigert
  de browser.

## Bibliotheken van derden

Gedownload van het npm-register (de officiële distributie). De tarball is gecontroleerd tegen de
integriteitshash van het register; de bestanden zijn ongewijzigd overgenomen. De pins staan in
[`docs/vendor/manifest.json`](docs/vendor/manifest.json).

| Bestand | Pakket | Bron in pakket | SHA-256 |
|---|---|---|---|
| `pdfmake.min.js` | [pdfmake 0.2.23](https://www.npmjs.com/package/pdfmake/v/0.2.23) (MIT) | `build/pdfmake.min.js` | `4410187c36ed6dd8cbfbaeea5b6fab6244238b3479c6de1cfe125d2c61fc2ba0` |
| `vfs_fonts.js` | [pdfmake 0.2.23](https://www.npmjs.com/package/pdfmake/v/0.2.23) (MIT) | `build/vfs_fonts.js` | `23e7c970fa9e75d296ea565939502a69ab2184cf40756c7d4670b6dabf470b58` |
| `jszip.min.js` | [jszip 3.10.2](https://www.npmjs.com/package/jszip/v/3.10.2) (MIT/GPLv3) | `dist/jszip.min.js` | `7f839b2d4688b845c105ebf5d2f9803075f91ea0fe72bdaac176c3a04dd3d2c1` |

**Kwetsbaarheden** (gecontroleerd op 25-11-2026 in [OSV](https://osv.dev), dat ook GitHub-advisories en CVE's
bevat): geen bekende kwetsbaarheden voor deze versies.

| Bekende advisory | Geldt voor | Hier van toepassing? |
|---|---|---|
| CVE-2025-11362, CVE-2026-26801 (pdfmake) | pdfmake 0.3.x | nee: wij gebruiken 0.2.23, en geen URL-inbedding |
| CVE-2022-48285, CVE-2021-23413 (jszip) | jszip < 3.8.0 | nee: 3.10.2, en we lezen geen zip-bestanden in |

CI controleert bij elke wijziging, en elke maandag, of de bestanden nog gelijk zijn aan de pins en aan het
npm-pakket, of de SRI-hashes kloppen, en of er nieuwe kwetsbaarheden zijn gemeld. Bij een melding faalt de
workflow en wordt er niet gepubliceerd.

**Een bibliotheek bijwerken:**
1. Haal de nieuwe versie uit het npm-register, controleer de integriteit en kopieer het bestand naar `docs/vendor/`.
2. Pas versie, bron en SHA-256 aan in `manifest.json` en in de tabel hierboven.
3. Draai `python tests/check_vendor.py`: de foutmelding geeft de nieuwe `integrity`-waarde voor `index.html`.
4. Draai de tests (hieronder).

## Ontwikkelen en testen

```
docs/          de website (wordt gepubliceerd)
  index.html   pagina + Content-Security-Policy + SRI
  camt.js      inlezen, controleren, saldocontrole, PDF-opmaak
  app.js       bediening van de pagina
  vendor/      bibliotheken van derden + manifest.json
samples/       voorbeeldbestanden (fictieve gegevens)
tests/         browsertests en controles
```

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r tests/requirements.txt
.venv/Scripts/python tests/check_vendor.py --source --osv
.venv/Scripts/python tests/run_tests.py --channel msedge
```

`run_tests.py` gebruikt een geïnstalleerde browser (Edge lokaal, Chrome in CI). Het draait de unittests in
`tests/test.html` en test de echte pagina: voorbeeldbestanden uploaden, de resultaten controleren, nagaan dat er
geen CSP-overtredingen zijn en dat uitgaande verzoeken geblokkeerd worden. Publiceren gebeurt alleen als alles
slaagt.

`.gitattributes` houdt `docs/vendor/` en `samples/` byte voor byte gelijk (geen CRLF-conversie op Windows), anders
kloppen de hashes niet meer.
