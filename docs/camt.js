"use strict";
// camt.053 decoding, parsing, validation, balance check and PDF layout.
// No UI code here: the page (app.js) and the tests (tests/test.js) both use this file.

const Camt = (() => {

// ------------------------------------------------------------------------- //
// Labels
// ------------------------------------------------------------------------- //

const LABELS = {
  nl: {
    title: "Rekeningafschrift", statement_id: "Afschrift-ID", sequence: "Volgnummer",
    created: "Aangemaakt", period: "Periode", account: "Rekening", currency: "Valuta",
    owner: "Rekeninghouder", bank: "Bank (BIC)", balances: "Saldi", balance_type: "Type",
    date: "Datum", amount: "Bedrag", entries: "Transacties", booking_date: "Boekdatum",
    value_date: "Valutadatum", counterparty: "Tegenpartij", description: "Omschrijving",
    debit: "Af", credit: "Bij", summary: "Samenvatting",
    n_credit: "Geboekte bijschrijvingen", n_debit: "Geboekte afschrijvingen",
    sum_credit: "Totaal bij (geboekt)", sum_debit: "Totaal af (geboekt)",
    no_entries: "Geen transacties in deze periode.",
    reconcile_ok: "Saldocontrole geslaagd: beginsaldo + geboekte mutaties = eindsaldo.",
    reconcile_fail: "LET OP – saldocontrole mislukt: beginsaldo + geboekte mutaties ({calc}) wijkt af van eindsaldo ({closing}).",
    reconcile_unchecked: "Saldocontrole niet uitgevoerd: {reason}.",
    reasons: {
      missing_balance: "begin- of eindsaldo ontbreekt in het bestand",
      multiple_balances: "het bestand bevat meer dan één begin- of eindsaldo",
      currency: "saldi en transacties hebben verschillende valuta's",
    },
    excluded: "{n} transactie(s) met een andere status dan BOOK staan in de lijst, maar tellen niet mee.",
    status: "status", not_counted: "niet meegeteld", reversal: "storno",
    page: "Pagina", not_official: "Geen officieel bankdocument", generated_from: "gegenereerd uit bestand",
    bal: {
      OPBD: "Beginsaldo", CLBD: "Eindsaldo", CLAV: "Beschikbaar saldo", PRCD: "Vorig eindsaldo",
      ITBD: "Tussentijds saldo", FWAV: "Toekomstig beschikbaar", OPAV: "Beschikbaar beginsaldo",
      ITAV: "Tussentijds beschikbaar", XPCD: "Verwacht saldo", INFO: "Informatief saldo",
    },
  },
  en: {
    title: "Bank statement", statement_id: "Statement ID", sequence: "Sequence no.",
    created: "Created", period: "Period", account: "Account", currency: "Currency",
    owner: "Account holder", bank: "Bank (BIC)", balances: "Balances", balance_type: "Type",
    date: "Date", amount: "Amount", entries: "Entries", booking_date: "Booking date",
    value_date: "Value date", counterparty: "Counterparty", description: "Description",
    debit: "Debit", credit: "Credit", summary: "Summary",
    n_credit: "Booked credits", n_debit: "Booked debits",
    sum_credit: "Total credits (booked)", sum_debit: "Total debits (booked)",
    no_entries: "No entries in this period.",
    reconcile_ok: "Balance check passed: opening balance + booked entries = closing balance.",
    reconcile_fail: "WARNING – balance check failed: opening balance + booked entries ({calc}) differs from closing balance ({closing}).",
    reconcile_unchecked: "Balance check not performed: {reason}.",
    reasons: {
      missing_balance: "the file has no opening or closing balance",
      multiple_balances: "the file has more than one opening or closing balance",
      currency: "balances and entries use different currencies",
    },
    excluded: "Entries with a status other than BOOK are listed but not counted: {n}.",
    status: "status", not_counted: "not counted", reversal: "reversal",
    page: "Page", not_official: "Not an official bank document", generated_from: "generated from file",
    bal: {
      OPBD: "Opening booked", CLBD: "Closing booked", CLAV: "Closing available", PRCD: "Previously closed",
      ITBD: "Interim booked", FWAV: "Forward available", OPAV: "Opening available",
      ITAV: "Interim available", XPCD: "Expected", INFO: "Information",
    },
  },
};

// Any problem in the input file is a CamtError: the file is rejected, no PDF is made.
class CamtError extends Error {}

// ------------------------------------------------------------------------- //
// Bytes -> text, and the file fingerprint
// ------------------------------------------------------------------------- //

function decodeXml(buf) {
  const bytes = new Uint8Array(buf);
  let label = "utf-8";
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) label = "utf-16le";
  else if (bytes[0] === 0xFE && bytes[1] === 0xFF) label = "utf-16be";
  else {
    const start = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0;
    const head = new TextDecoder("latin1").decode(bytes.subarray(start, start + 200));
    const m = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head);
    if (m) label = m[1];
  }
  let decoder;
  try {
    decoder = new TextDecoder(label, { fatal: true });
  } catch {
    throw new CamtError(`Onbekende tekenset "${label}" in de XML-declaratie.`);
  }
  try {
    return decoder.decode(bytes);
  } catch {
    throw new CamtError(`Het bestand bevat tekens die niet geldig zijn in tekenset ${label}.`);
  }
}

async function sha256Hex(buf) {
  if (!globalThis.crypto || !crypto.subtle) {
    throw new CamtError("SHA-256 is niet beschikbaar: open de pagina via https.");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------------- //
// Exact amounts: BigInt scaled by 10^5 (ISO 20022 allows up to 5 decimals)
// ------------------------------------------------------------------------- //

const SCALE = 100000n;
// ISO 20022 amounts: at most 18 digits, of which at most 5 after the decimal point.
const AMOUNT_RE = /^\d{1,18}(\.\d{1,5})?$/;

function parseAmount(s, where) {
  if (!AMOUNT_RE.test(s) || s.replace(".", "").length > 18) {
    throw new CamtError(`${where}: ongeldig bedrag "${s}".`);
  }
  const [int, frac = ""] = s.split(".");
  return BigInt(int) * SCALE + BigInt(frac.padEnd(5, "0"));
}

function fmtAmount(v, lang) {
  const neg = v < 0n;
  const cents = ((neg ? -v : v) + 500n) / 1000n; // round half up to 2 decimals
  const int = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, lang === "nl" ? "." : ",");
  const frac = (cents % 100n).toString().padStart(2, "0");
  return (neg ? "-" : "") + int + (lang === "nl" ? "," : ".") + frac;
}

function fmtDate(s, lang) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  if (!m) return s || "";
  return lang === "nl" ? `${m[3]}-${m[2]}-${m[1]}` : `${m[1]}-${m[2]}-${m[3]}`;
}

function fmtDateTime(s, lang) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(s || "");
  return m ? `${fmtDate(m[1], lang)} ${m[2]}` : (s || "");
}

// ------------------------------------------------------------------------- //
// Parsing (namespace-agnostic: match on local element names)
// ------------------------------------------------------------------------- //

function children(el, name) {
  return el ? Array.from(el.children).filter(c => c.localName === name) : [];
}

function findAll(el, path) {
  let nodes = el ? [el] : [];
  for (const part of path.split("/")) nodes = nodes.flatMap(n => children(n, part));
  return nodes;
}

function find(el, path) {
  return findAll(el, path)[0] || null;
}

function text(el, ...paths) {
  if (!el) return "";
  for (const p of paths) {
    const n = p ? find(el, p) : el;
    const t = n && n.textContent.trim();
    if (t) return t;
  }
  return "";
}

function requireAmount(el, where) {
  const amt = find(el, "Amt");
  if (!amt) throw new CamtError(`${where}: bedrag (Amt) ontbreekt.`);
  const ccy = amt.getAttribute("Ccy") || "";
  if (!/^[A-Z]{3}$/.test(ccy)) throw new CamtError(`${where}: ongeldige of ontbrekende valuta "${ccy}".`);
  return { value: parseAmount(amt.textContent.trim(), where), currency: ccy };
}

function requireIsCredit(el, where) {
  const v = text(el, "CdtDbtInd");
  if (v !== "CRDT" && v !== "DBIT") throw new CamtError(`${where}: ongeldige of ontbrekende CdtDbtInd "${v}".`);
  return v === "CRDT";
}

const parseDate = el => text(el, "Dt", "DtTm").slice(0, 10);
const parseParty = el => text(el, "Pty/Nm", "Nm"); // v08+ wraps the party in <Pty>
const parseAccount = el => text(el, "Id/IBAN", "Id/Othr/Id");

function parseEntry(ntry, where) {
  const { value, currency } = requireAmount(ntry, where);
  const isCredit = requireIsCredit(ntry, where);
  const e = {
    amount: value,
    currency,
    isCredit,
    reversal: text(ntry, "RvslInd").toLowerCase() === "true",
    // v02-v05: <Sts>BOOK</Sts>; v06+: <Sts><Cd>BOOK</Cd></Sts>
    status: text(ntry, "Sts/Cd", "Sts/Prtry", "Sts"),
    bookingDate: parseDate(find(ntry, "BookgDt")),
    valueDate: parseDate(find(ntry, "ValDt")),
  };

  const codes = ["BkTxCd/Domn/Cd", "BkTxCd/Domn/Fmly/Cd", "BkTxCd/Domn/Fmly/SubFmlyCd"]
    .map(p => text(ntry, p)).filter(Boolean);
  e.bankTxCode = codes.join("-") || text(ntry, "BkTxCd/Prtry/Cd");

  const descriptions = [], refs = [], names = [], accounts = [];
  const acctRef = text(ntry, "AcctSvcrRef");
  if (acctRef) refs.push(acctRef);

  // The counterparty is the debtor on a credit and the creditor on a debit.
  const other = isCredit ? "Dbtr" : "Cdtr";
  for (const tx of findAll(ntry, "NtryDtls/TxDtls")) {
    const name = parseParty(find(tx, `RltdPties/${other}`)) || parseParty(find(tx, `RltdPties/Ultmt${other}`));
    const acct = parseAccount(find(tx, `RltdPties/${other}Acct`));
    if (name && !names.includes(name)) names.push(name);
    if (acct && !accounts.includes(acct)) accounts.push(acct);

    for (const u of findAll(tx, "RmtInf/Ustrd")) if (u.textContent.trim()) descriptions.push(u.textContent.trim());
    for (const s of findAll(tx, "RmtInf/Strd")) {
      const cref = text(s, "CdtrRefInf/Ref");
      if (cref) descriptions.push(cref);
      for (const a of children(s, "AddtlRmtInf")) if (a.textContent.trim()) descriptions.push(a.textContent.trim());
    }
    const addtl = text(tx, "AddtlTxInf");
    if (addtl) descriptions.push(addtl);

    const e2e = text(tx, "Refs/EndToEndId");
    if (e2e && e2e.toUpperCase() !== "NOTPROVIDED") refs.push(`E2E ${e2e}`);
  }
  const addtlNtry = text(ntry, "AddtlNtryInf");
  if (addtlNtry && !descriptions.includes(addtlNtry)) descriptions.push(addtlNtry);

  e.counterpartyName = names.join("; ");
  e.counterpartyAccount = accounts.join("; ");
  e.description = [...new Set(descriptions)].join(" / ");
  e.references = refs;
  return e;
}

function parseStatement(stmt, index) {
  const id = text(stmt, "Id");
  const label = `Afschrift ${id || index + 1}`;
  const acct = find(stmt, "Acct");

  const balances = findAll(stmt, "Bal").map((bal, i) => {
    const code = text(bal, "Tp/CdOrPrtry/Cd", "Tp/CdOrPrtry/Prtry");
    const where = `${label}, saldo ${i + 1}${code ? ` (${code})` : ""}`;
    if (!code) throw new CamtError(`${where}: saldotype ontbreekt.`);
    const { value, currency } = requireAmount(bal, where);
    return {
      code,
      amount: requireIsCredit(bal, where) ? value : -value,
      currency,
      date: parseDate(find(bal, "Dt")),
    };
  });

  return {
    id,
    sequence: text(stmt, "ElctrncSeqNb", "LglSeqNb"),
    created: text(stmt, "CreDtTm"),
    periodFrom: text(stmt, "FrToDt/FrDtTm").slice(0, 10),
    periodTo: text(stmt, "FrToDt/ToDtTm").slice(0, 10),
    iban: parseAccount(acct),
    currency: text(acct, "Ccy"),
    owner: text(acct, "Ownr/Nm"),
    bic: text(acct, "Svcr/FinInstnId/BICFI", "Svcr/FinInstnId/BIC"),
    balances,
    entries: findAll(stmt, "Ntry").map((n, i) => parseEntry(n, `${label}, transactie ${i + 1}`)),
  };
}

function parseXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new CamtError("Geen geldig XML-bestand.");
  const stmts = Array.from(doc.getElementsByTagNameNS("*", "Stmt"));
  if (!stmts.length) throw new CamtError("Geen <Stmt> gevonden – is dit een camt.053-bestand?");
  return stmts.map(parseStatement);
}

// ------------------------------------------------------------------------- //
// Balance check: opening + booked credits - booked debits must equal closing.
// Result status is "ok", "mismatch" or "unchecked" (with a reason).
// ------------------------------------------------------------------------- //

function reconcile(s) {
  const booked = s.entries.filter(e => e.status === "BOOK");
  const total = list => list.reduce((a, e) => a + e.amount, 0n);
  const r = {
    status: "unchecked", reason: null,
    credits: total(booked.filter(e => e.isCredit)), nCredit: booked.filter(e => e.isCredit).length,
    debits: total(booked.filter(e => !e.isCredit)), nDebit: booked.filter(e => !e.isCredit).length,
    excluded: s.entries.length - booked.length, calc: null, closing: null,
  };
  const byCode = code => s.balances.filter(b => b.code === code);
  const openings = byCode("OPBD").length ? byCode("OPBD") : byCode("PRCD");
  const closings = byCode("CLBD");
  if (!openings.length || !closings.length) return { ...r, reason: "missing_balance" };
  if (openings.length > 1 || closings.length > 1) return { ...r, reason: "multiple_balances" };
  const currencies = new Set([openings[0].currency, closings[0].currency, ...booked.map(e => e.currency)]);
  if (currencies.size > 1) return { ...r, reason: "currency" };
  r.calc = openings[0].amount + r.credits - r.debits;
  r.closing = closings[0].amount;
  r.status = r.calc === r.closing ? "ok" : "mismatch";
  return r;
}

// ------------------------------------------------------------------------- //
// PDF layout (pdfmake document definition)
// ------------------------------------------------------------------------- //

const BRAND = "#1F3A5F", LIGHT = "#EEF2F7", GRID = "#C9D2DE", GREY = "#555555";
const GREEN = "#1B7F3B", RED = "#B00020", AMBER = "#9A5B00";

function gridLayout(zebra) {
  return {
    hLineWidth: () => 0.25,
    vLineWidth: (i, node) => (i === 0 || i === node.table.widths.length ? 0.5 : 0),
    hLineColor: () => GRID,
    vLineColor: () => GRID,
    fillColor: row => (row === 0 ? BRAND : zebra && row % 2 === 0 ? LIGHT : null),
    paddingLeft: () => 4, paddingRight: () => 4, paddingTop: () => 3, paddingBottom: () => 3,
  };
}

const hdr = (t, right) => ({ text: t, bold: true, color: "white", alignment: right ? "right" : "left" });
const num = t => ({ text: t, alignment: "right" });

function kvTable(rows, widths) {
  return {
    table: {
      widths,
      body: rows.filter(([, v]) => v).map(([k, v]) => [
        { text: k, bold: true, color: GREY, fontSize: 7.5 },
        { text: v, fontSize: 8.5 },
      ]),
    },
    layout: { defaultBorder: false, paddingLeft: () => 0, paddingTop: () => 1, paddingBottom: () => 1 },
  };
}

function statementContent(s, L, lang) {
  const ccy = s.currency || (s.balances[0] && s.balances[0].currency) || "";
  const out = [];

  out.push({ text: L.title, style: "title" });
  const period = [fmtDate(s.periodFrom, lang), fmtDate(s.periodTo, lang)].filter(Boolean).join(" – ");
  out.push({
    columns: [
      kvTable([[L.account, s.iban], [L.currency, ccy], [L.owner, s.owner], [L.bank, s.bic]], [90, "*"]),
      kvTable([[L.statement_id, s.id], [L.sequence, s.sequence], [L.period, period],
               [L.created, fmtDateTime(s.created, lang)]], [80, "*"]),
    ],
    margin: [0, 0, 0, 10],
  });

  if (s.balances.length) {
    out.push({ text: L.balances, style: "h2" });
    out.push({
      table: {
        widths: [200, 85, 113],
        body: [
          [hdr(L.balance_type), hdr(L.date), hdr(`${L.amount} (${ccy})`, true)],
          ...s.balances.map(b => [`${L.bal[b.code] || b.code} (${b.code})`, fmtDate(b.date, lang),
                                  num(fmtAmount(b.amount, lang))]),
        ],
      },
      layout: gridLayout(false),
    });
  }

  out.push({ text: `${L.entries} (${s.entries.length})`, style: "h2" });
  if (!s.entries.length) {
    out.push({ text: L.no_entries, fontSize: 8.5 });
  } else {
    const body = [[hdr(L.booking_date), hdr(L.value_date), hdr(L.counterparty), hdr(L.description),
                   hdr(L.debit, true), hdr(L.credit, true)]];
    for (const e of s.entries) {
      const booked = e.status === "BOOK";
      const cp = [{ text: e.counterpartyName }];
      if (e.counterpartyAccount) cp.push({ text: e.counterpartyAccount, style: "small" });
      const meta = [...e.references];
      if (e.bankTxCode) meta.push(e.bankTxCode);
      if (e.reversal) meta.push(L.reversal);
      const desc = [{ text: e.description }];
      if (meta.length) desc.push({ text: meta.join(" · "), style: "small" });
      if (!booked) {
        desc.push({ text: `${L.status} ${e.status || "?"} – ${L.not_counted}`, style: "small", color: AMBER, bold: true });
      }
      const amt = fmtAmount(e.amount, lang);
      const amtCell = t => ({ ...num(t), color: booked ? undefined : AMBER });
      body.push([fmtDate(e.bookingDate, lang), fmtDate(e.valueDate, lang), { stack: cp }, { stack: desc },
                 amtCell(e.isCredit ? "" : amt), amtCell(e.isCredit ? amt : "")]);
    }
    out.push({
      table: { headerRows: 1, dontBreakRows: true, widths: [58, 60, 125, "*", 60, 60], body },
      layout: gridLayout(true),
    });
  }

  const r = reconcile(s);
  const summary = [
    { text: L.summary, style: "h2" },
    kvTable([
      [L.n_credit, String(r.nCredit)],
      [L.sum_credit, `${ccy} ${fmtAmount(r.credits, lang)}`],
      [L.n_debit, String(r.nDebit)],
      [L.sum_debit, `${ccy} ${fmtAmount(r.debits, lang)}`],
    ], [130, 170]),
  ];
  const note = (t, color, bold) => ({ text: t, color, bold: !!bold, fontSize: 8, margin: [0, 6, 0, 0] });
  if (r.status === "ok") {
    summary.push(note(L.reconcile_ok, GREEN));
  } else if (r.status === "mismatch") {
    summary.push(note(L.reconcile_fail.replace("{calc}", fmtAmount(r.calc, lang))
                                       .replace("{closing}", fmtAmount(r.closing, lang)), RED, true));
  } else {
    summary.push(note(L.reconcile_unchecked.replace("{reason}", L.reasons[r.reason]), AMBER, true));
  }
  if (r.excluded) summary.push(note(L.excluded.replace("{n}", r.excluded), AMBER));
  out.push({ stack: summary, unbreakable: true });
  return out;
}

// source = { name, sha256 } of the original XML file; both go on every page.
function docDefinition(statements, source, lang, orientation) {
  const L = LABELS[lang];
  const content = [];
  statements.forEach((s, i) => {
    const part = statementContent(s, L, lang);
    if (i) part[0].pageBreak = "before";
    content.push(...part);
  });
  return {
    pageSize: "A4",
    pageOrientation: orientation,
    pageMargins: [40, 40, 40, 54],
    info: {
      title: `${L.title} ${statements[0].iban}`.trim(),
      subject: `${L.not_official} – ${L.generated_from} ${source.name}, SHA-256 ${source.sha256}`,
      keywords: `sha256:${source.sha256}`,
      creator: "camt.053 naar PDF",
    },
    defaultStyle: { fontSize: 7.5, lineHeight: 1.1 },
    styles: {
      title: { fontSize: 16, bold: true, color: BRAND, margin: [0, 0, 0, 6] },
      h2: { fontSize: 11, bold: true, color: BRAND, margin: [0, 10, 0, 4] },
      small: { fontSize: 6.5, color: GREY, margin: [0, 2, 0, 0] },
    },
    footer: (page, pages) => ({
      stack: [
        {
          columns: [
            { text: `${L.not_official} – ${L.generated_from} ${source.name}`, bold: true },
            { text: `${L.page} ${page} / ${pages}`, alignment: "right", width: "auto" },
          ],
        },
        { text: `SHA-256 ${source.sha256}` },
      ],
      fontSize: 6.5, color: "#666666", margin: [40, 14, 40, 0],
    }),
    content,
  };
}

// Full pipeline for one file: bytes in, parsed statements + fingerprint out.
async function readFile(name, buf) {
  const sha256 = await sha256Hex(buf);
  const statements = parseXml(decodeXml(buf));
  return { source: { name, sha256 }, statements };
}

return { LABELS, CamtError, decodeXml, sha256Hex, parseAmount, fmtAmount, parseXml, reconcile, docDefinition, readFile };
})();
