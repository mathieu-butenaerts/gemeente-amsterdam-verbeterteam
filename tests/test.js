"use strict";
// Browser tests for docs/camt.js against the files in samples/.
// Open tests/test.html via a local web server; CI runs it in headless Chrome.

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}\n     ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function eq(actual, expected, what) {
  assert(actual === expected, `${what}: expected ${String(expected)}, got ${String(actual)}`);
}

async function rejects(fn, pattern) {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof Camt.CamtError, `expected CamtError, got ${err.name}: ${err.message}`);
    assert(pattern.test(err.message), `error "${err.message}" does not match ${pattern}`);
    return;
  }
  throw new Error(`expected the file to be rejected (${pattern})`);
}

const fetchBytes = async name => {
  const res = await fetch(`../samples/${name}`);
  assert(res.ok, `could not load samples/${name}`);
  return res.arrayBuffer();
};
const fetchText = async name => new TextDecoder().decode(await fetchBytes(name));
const bytes = s => new TextEncoder().encode(s).buffer;
const read = async name => Camt.readFile(name, await fetchBytes(name));
const readText = (name, s) => Camt.readFile(name, bytes(s));
const eur = s => Camt.parseAmount(s, "test");
const makePdf = dd => new Promise((resolve, reject) => {
  try { pdfMake.createPdf(dd).getBlob(resolve); } catch (err) { reject(err); }
});

// sha256sum of the sample files as stored in git (see .gitattributes)
const SAMPLE_SHA256 = {
  "example_v02.xml": "f160062f4a5c41947d1b9a541349287583fdbc0b390df1ca3011d8d6e8cbfb77",
  "example_v08_mismatch.xml": "68f5a1415acee8445b6859329e4aed9c871143aa60191e0e0df256d30b5513df",
};

async function run() {
  // --- parsing and balance check -----------------------------------------

  await test("v02: parses and balance check passes", async () => {
    const { source, statements } = await read("example_v02.xml");
    eq(source.sha256, SAMPLE_SHA256["example_v02.xml"], "sha256");
    eq(statements.length, 1, "statements");
    const s = statements[0];
    eq(s.iban, "NL91ABNA0417164300", "iban");
    eq(s.bic, "ABNANL2A", "bic");
    eq(s.entries.length, 3, "entries");
    eq(s.entries[0].counterpartyName, "Klant & Zonen", "counterparty of a credit is the debtor");
    eq(s.entries[1].counterpartyName, "Verhuurder Amsterdam", "counterparty of a debit is the creditor");
    eq(s.entries[1].description, "1234567890123456", "structured reference");
    const r = Camt.reconcile(s);
    eq(r.status, "ok", "status");
    eq(r.credits, eur("2450.00"), "credits");
    eq(r.debits, eur("1245.49"), "debits");
  });

  await test("v08: <Pty> and <BICFI> are read, mismatch is reported", async () => {
    const { source, statements } = await read("example_v08_mismatch.xml");
    eq(source.sha256, SAMPLE_SHA256["example_v08_mismatch.xml"], "sha256");
    const s = statements[0];
    eq(s.bic, "ABNANL2A", "bic");
    eq(s.entries[0].counterpartyName, "Klant & Zonen", "counterparty");
    const r = Camt.reconcile(s);
    eq(r.status, "mismatch", "status");
    eq(r.calc, eur("13704.51"), "calculated closing");
    eq(r.closing, eur("13704.00"), "closing");
  });

  await test("only BOOK entries count in the balance check", async () => {
    const s = (await read("example_pending.xml")).statements[0];
    eq(s.entries.length, 4, "entries listed");
    eq(s.entries[0].status, "PDNG", "pending status");
    const r = Camt.reconcile(s);
    eq(r.status, "ok", "status");
    eq(r.excluded, 1, "excluded");
    eq(r.nCredit, 1, "booked credits");
    eq(r.credits, eur("2450.00"), "credits exclude the pending entry");
  });

  await test("missing balances: check is explicitly not performed", async () => {
    const r = Camt.reconcile((await read("example_no_balances.xml")).statements[0]);
    eq(r.status, "unchecked", "status");
    eq(r.reason, "missing_balance", "reason");
  });

  await test("different currencies: check is explicitly not performed", async () => {
    const xml = (await fetchText("example_v02.xml")).replace('<Amt Ccy="EUR">45.49', '<Amt Ccy="USD">45.49');
    const r = Camt.reconcile((await readText("x.xml", xml)).statements[0]);
    eq(r.status, "unchecked", "status");
    eq(r.reason, "currency", "reason");
  });

  await test("two closing balances: check is explicitly not performed", async () => {
    const xml = await fetchText("example_v02.xml");
    const clbd = xml.match(/<Bal><Tp><CdOrPrtry><Cd>CLBD<\/Cd>.*<\/Bal>/)[0];
    const r = Camt.reconcile((await readText("x.xml", xml.replace(clbd, clbd + clbd))).statements[0]);
    eq(r.reason, "multiple_balances", "reason");
  });

  await test("ISO-8859-1 file is decoded with its declared encoding", async () => {
    eq((await read("example_latin1.xml")).statements[0].owner, "Café Één B.V.", "owner");
  });

  // --- hard failures -------------------------------------------------------

  await test("sample with amount 1200,00 is rejected", async () => {
    await rejects(() => read("invalid_amount.xml"), /transactie 2: ongeldig bedrag "1200,00"/);
  });

  for (const bad of ["abc", "", "-5.00", "1e3", "1.123456", "1234567890123456789", " 12.00x", "NaN"]) {
    await test(`entry amount "${bad}" is rejected`, async () => {
      const xml = (await fetchText("example_v02.xml")).replace(">45.49<", `>${bad}<`);
      await rejects(() => readText("x.xml", xml), /transactie 3: ongeldig bedrag/);
    });
  }

  await test("balance with invalid amount is rejected", async () => {
    const xml = (await fetchText("example_v02.xml")).replace(">12500.00<", ">12.500,00<");
    await rejects(() => readText("x.xml", xml), /saldo 1 \(OPBD\): ongeldig bedrag/);
  });

  await test("missing amount is rejected", async () => {
    const xml = (await fetchText("example_v02.xml")).replace('<Amt Ccy="EUR">45.49</Amt>', "");
    await rejects(() => readText("x.xml", xml), /transactie 3: bedrag \(Amt\) ontbreekt/);
  });

  await test("missing or invalid currency is rejected", async () => {
    const xml = (await fetchText("example_v02.xml")).replace('<Amt Ccy="EUR">45.49', "<Amt>45.49");
    await rejects(() => readText("x.xml", xml), /transactie 3: ongeldige of ontbrekende valuta/);
    const xml2 = (await fetchText("example_v02.xml")).replace('<Amt Ccy="EUR">45.49', '<Amt Ccy="eur">45.49');
    await rejects(() => readText("x.xml", xml2), /ongeldige of ontbrekende valuta "eur"/);
  });

  await test("invalid credit/debit indicator is rejected", async () => {
    const src = await fetchText("example_v02.xml");
    const i = src.lastIndexOf("<CdtDbtInd>DBIT"); // entry 3
    const xml = src.slice(0, i) + "<CdtDbtInd>DEBIT" + src.slice(i + "<CdtDbtInd>DBIT".length);
    await rejects(() => readText("x.xml", xml), /transactie 3: ongeldige of ontbrekende CdtDbtInd "DEBIT"/);
  });

  await test("balance without a type is rejected", async () => {
    const xml = (await fetchText("example_v02.xml")).replace("<Cd>OPBD</Cd>", "<Cd></Cd>");
    await rejects(() => readText("x.xml", xml), /saldo 1: saldotype ontbreekt/);
  });

  await test("invalid UTF-8 is rejected", async () => {
    const buf = new Uint8Array(await fetchBytes("example_v02.xml"));
    buf[buf.indexOf(0x56)] = 0xFF; // corrupt the "V" of "Voorbeeld"
    await rejects(() => Camt.readFile("x.xml", buf.buffer), /tekens die niet geldig zijn in tekenset utf-8/i);
  });

  await test("unknown encoding is rejected", async () => {
    await rejects(() => readText("x.xml", '<?xml version="1.0" encoding="EBCDIC-XYZ"?><a/>'), /Onbekende tekenset/);
  });

  await test("non-XML and non-camt files are rejected", async () => {
    await rejects(() => readText("x.xml", "<<kapot"), /Geen geldig XML-bestand/);
    await rejects(() => readText("x.xml", "<foo>niet camt</foo>"), /Geen <Stmt> gevonden/);
  });

  // --- amounts -------------------------------------------------------------

  await test("amounts are exact and rounded half up", async () => {
    eq(eur("0.00001"), 1n, "smallest unit");
    eq(Camt.fmtAmount(eur("1234567.125"), "nl"), "1.234.567,13", "nl format");
    eq(Camt.fmtAmount(eur("1234567.125"), "en"), "1,234,567.13", "en format");
    eq(Camt.fmtAmount(-eur("0.10"), "nl"), "-0,10", "negative");
  });

  // --- PDF -----------------------------------------------------------------

  await test("every page carries the disclaimer, file name and SHA-256", async () => {
    const { source, statements } = await read("example_v02.xml");
    for (const [lang, phrase] of [["nl", "Geen officieel bankdocument – gegenereerd uit bestand example_v02.xml"],
                                  ["en", "Not an official bank document – generated from file example_v02.xml"]]) {
      const dd = Camt.docDefinition(statements, source, lang, "portrait");
      for (const page of [1, 2]) {
        const footer = JSON.stringify(dd.footer(page, 2));
        assert(footer.includes(phrase), `${lang} footer page ${page} lacks disclaimer`);
        assert(footer.includes(`SHA-256 ${source.sha256}`), `${lang} footer page ${page} lacks hash`);
      }
      assert(dd.info.keywords.includes(source.sha256), "hash in PDF metadata");
    }
  });

  await test("balance check outcome is printed in the PDF", async () => {
    const texts = async name => {
      const { source, statements } = await read(name);
      return JSON.stringify(Camt.docDefinition(statements, source, "nl", "portrait").content);
    };
    assert((await texts("example_v02.xml")).includes("Saldocontrole geslaagd"), "ok message");
    assert((await texts("example_v08_mismatch.xml")).includes("saldocontrole mislukt"), "mismatch message");
    assert((await texts("example_no_balances.xml")).includes("Saldocontrole niet uitgevoerd: begin- of eindsaldo ontbreekt"), "unchecked message");
    const pending = await texts("example_pending.xml");
    assert(pending.includes("status PDNG – niet meegeteld"), "pending entry marked");
    assert(pending.includes("tellen niet mee"), "excluded count note");
  });

  for (const name of ["example_v02.xml", "example_v08_mismatch.xml", "example_pending.xml",
                      "example_no_balances.xml", "example_latin1.xml"]) {
    await test(`PDF is generated for ${name} (nl/en, portrait/landscape)`, async () => {
      const { source, statements } = await read(name);
      for (const [lang, orientation] of [["nl", "portrait"], ["en", "landscape"]]) {
        const blob = await makePdf(Camt.docDefinition(statements, source, lang, orientation));
        const head = new TextDecoder().decode(await blob.slice(0, 5).arrayBuffer());
        eq(head, "%PDF-", `${lang}/${orientation} header`);
        assert(blob.size > 10000, `${lang}/${orientation} PDF suspiciously small (${blob.size} bytes)`);
      }
    });
  }

  await test("long statement spans several pages", async () => {
    const xml = await fetchText("example_v02.xml");
    const ntries = xml.match(/<Ntry>[\s\S]*?<\/Ntry>/g).join("\n");
    const big = xml.replace(/<Ntry>[\s\S]*<\/Ntry>/, Array(20).fill(ntries).join("\n"));
    const { source, statements } = await readText("big.xml", big);
    let pages = 0;
    const dd = Camt.docDefinition(statements, source, "nl", "portrait");
    const footer = dd.footer;
    dd.footer = (page, count) => { pages = count; return footer(page, count); };
    await makePdf(dd);
    assert(pages >= 3, `expected at least 3 pages, got ${pages}`);
  });

  const failed = results.filter(r => r.startsWith("FAIL")).length;
  const out = document.getElementById("result");
  out.textContent = `${results.join("\n")}\n\n${results.length - failed} passed, ${failed} failed`;
  out.dataset.status = failed ? "fail" : "pass";
  document.title = failed ? `FAIL (${failed})` : `PASS (${results.length})`;
}

run().catch(err => {
  const out = document.getElementById("result");
  out.textContent = `test runner crashed: ${err.stack || err}`;
  out.dataset.status = "fail";
});
