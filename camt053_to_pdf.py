#!/usr/bin/env python3
"""Convert ISO 20022 camt.053 bank statements (XML) into readable PDF statements.

Works with any camt.053.001.xx version (02 through 13): elements are matched on
their local name, so the namespace version does not matter.

Usage:
    python camt053_to_pdf.py statement.xml                 # -> statement.pdf
    python camt053_to_pdf.py *.xml -o out/                 # batch, into a folder
    python camt053_to_pdf.py statement.xml --lang en       # English labels
    python camt053_to_pdf.py statement.xml --split         # one PDF per <Stmt>
"""

from __future__ import annotations

import argparse
import glob
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

# --------------------------------------------------------------------------- #
# Labels
# --------------------------------------------------------------------------- #

LABELS = {
    "nl": {
        "title": "Rekeningafschrift",
        "statement_id": "Afschrift-ID",
        "sequence": "Volgnummer",
        "created": "Aangemaakt",
        "period": "Periode",
        "account": "Rekening",
        "currency": "Valuta",
        "owner": "Rekeninghouder",
        "bank": "Bank (BIC)",
        "balances": "Saldi",
        "balance_type": "Type",
        "date": "Datum",
        "amount": "Bedrag",
        "entries": "Transacties",
        "booking_date": "Boekdatum",
        "value_date": "Valutadatum",
        "counterparty": "Tegenpartij",
        "description": "Omschrijving",
        "debit": "Af",
        "credit": "Bij",
        "summary": "Samenvatting",
        "n_credit": "Aantal bijschrijvingen",
        "n_debit": "Aantal afschrijvingen",
        "sum_credit": "Totaal bij",
        "sum_debit": "Totaal af",
        "no_entries": "Geen transacties in deze periode.",
        "reconcile_ok": "Beginsaldo + mutaties = eindsaldo (gecontroleerd).",
        "reconcile_fail": "LET OP: beginsaldo + mutaties ({calc}) wijkt af van eindsaldo ({closing}).",
        "page": "Pagina",
        "generated": "Gegenereerd uit",
        "reversal": "storno",
        "ref": "Ref",
        "e2e": "E2E",
        "bal": {
            "OPBD": "Beginsaldo",
            "CLBD": "Eindsaldo",
            "CLAV": "Beschikbaar saldo",
            "PRCD": "Vorig eindsaldo",
            "ITBD": "Tussentijds saldo",
            "FWAV": "Toekomstig beschikbaar",
            "OPAV": "Beschikbaar beginsaldo",
            "ITAV": "Tussentijds beschikbaar",
            "XPCD": "Verwacht saldo",
            "INFO": "Informatief saldo",
        },
    },
    "en": {
        "title": "Bank statement",
        "statement_id": "Statement ID",
        "sequence": "Sequence no.",
        "created": "Created",
        "period": "Period",
        "account": "Account",
        "currency": "Currency",
        "owner": "Account holder",
        "bank": "Bank (BIC)",
        "balances": "Balances",
        "balance_type": "Type",
        "date": "Date",
        "amount": "Amount",
        "entries": "Entries",
        "booking_date": "Booking date",
        "value_date": "Value date",
        "counterparty": "Counterparty",
        "description": "Description",
        "debit": "Debit",
        "credit": "Credit",
        "summary": "Summary",
        "n_credit": "Number of credits",
        "n_debit": "Number of debits",
        "sum_credit": "Total credits",
        "sum_debit": "Total debits",
        "no_entries": "No entries in this period.",
        "reconcile_ok": "Opening balance + entries = closing balance (verified).",
        "reconcile_fail": "WARNING: opening balance + entries ({calc}) differs from closing balance ({closing}).",
        "page": "Page",
        "generated": "Generated from",
        "reversal": "reversal",
        "ref": "Ref",
        "e2e": "E2E",
        "bal": {
            "OPBD": "Opening booked",
            "CLBD": "Closing booked",
            "CLAV": "Closing available",
            "PRCD": "Previously closed",
            "ITBD": "Interim booked",
            "FWAV": "Forward available",
            "OPAV": "Opening available",
            "ITAV": "Interim available",
            "XPCD": "Expected",
            "INFO": "Information",
        },
    },
}

# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #


@dataclass
class Balance:
    code: str
    amount: Decimal  # signed: negative when DBIT
    currency: str
    date: str


@dataclass
class Entry:
    amount: Decimal  # always positive; see `is_credit`
    currency: str
    is_credit: bool
    reversal: bool
    status: str
    booking_date: str
    value_date: str
    counterparty_name: str = ""
    counterparty_account: str = ""
    description: str = ""
    references: list[str] = field(default_factory=list)
    bank_tx_code: str = ""


@dataclass
class Statement:
    id: str
    sequence: str
    created: str
    period_from: str
    period_to: str
    iban: str
    currency: str
    owner: str
    bic: str
    balances: list[Balance]
    entries: list[Entry]
    n_credit: str = ""
    sum_credit: Decimal | None = None
    n_debit: str = ""
    sum_debit: Decimal | None = None


# --------------------------------------------------------------------------- #
# Parsing (namespace-agnostic)
# --------------------------------------------------------------------------- #


def _path(p: str) -> str:
    """'A/B/C' -> '{*}A/{*}B/{*}C' so any namespace matches."""
    return "/".join(f"{{*}}{part}" for part in p.split("/"))


def find(el: ET.Element | None, p: str) -> ET.Element | None:
    return None if el is None else el.find(_path(p))


def findall(el: ET.Element | None, p: str) -> list[ET.Element]:
    return [] if el is None else el.findall(_path(p))


def text(el: ET.Element | None, *paths: str) -> str:
    """Return the stripped text of the first path that exists and is non-empty."""
    if el is None:
        return ""
    for p in paths:
        node = find(el, p) if p else el
        if node is not None and node.text and node.text.strip():
            return node.text.strip()
    return ""


def to_decimal(s: str) -> Decimal:
    try:
        return Decimal(s)
    except (InvalidOperation, TypeError):
        return Decimal(0)


def parse_date(el: ET.Element | None) -> str:
    """camt dates are either <Dt>YYYY-MM-DD</Dt> or <DtTm>...</DtTm>."""
    return text(el, "Dt", "DtTm")[:10]


def parse_party(el: ET.Element | None) -> str:
    # camt.053.001.08+ wraps the party in <Pty>; older versions don't.
    return text(el, "Pty/Nm", "Nm")


def parse_account(el: ET.Element | None) -> str:
    return text(el, "Id/IBAN", "Id/Othr/Id")


def parse_entry(ntry: ET.Element) -> Entry:
    amt = find(ntry, "Amt")
    is_credit = text(ntry, "CdtDbtInd") == "CRDT"
    reversal = text(ntry, "RvslInd").lower() == "true"

    entry = Entry(
        amount=to_decimal(amt.text if amt is not None else "0"),
        currency=amt.get("Ccy", "") if amt is not None else "",
        is_credit=is_credit,
        reversal=reversal,
        # v02-v05: <Sts>BOOK</Sts>; v06+: <Sts><Cd>BOOK</Cd></Sts>
        status=text(ntry, "Sts/Cd", "Sts/Prtry", "Sts"),
        booking_date=parse_date(find(ntry, "BookgDt")),
        value_date=parse_date(find(ntry, "ValDt")),
    )

    domain = text(ntry, "BkTxCd/Domn/Cd")
    family = text(ntry, "BkTxCd/Domn/Fmly/Cd")
    sub = text(ntry, "BkTxCd/Domn/Fmly/SubFmlyCd")
    entry.bank_tx_code = "-".join(x for x in (domain, family, sub) if x) or text(
        ntry, "BkTxCd/Prtry/Cd"
    )

    descriptions: list[str] = []
    refs: list[str] = []
    names: list[str] = []
    accounts: list[str] = []

    acct_ref = text(ntry, "AcctSvcrRef")
    if acct_ref:
        refs.append(acct_ref)

    # The counterparty is the debtor on a credit and the creditor on a debit.
    other = "Dbtr" if is_credit else "Cdtr"
    for tx in findall(ntry, "NtryDtls/TxDtls"):
        name = parse_party(find(tx, f"RltdPties/{other}")) or parse_party(
            find(tx, f"RltdPties/Ultmt{other}")
        )
        acct = parse_account(find(tx, f"RltdPties/{other}Acct"))
        if name and name not in names:
            names.append(name)
        if acct and acct not in accounts:
            accounts.append(acct)

        for ustrd in findall(tx, "RmtInf/Ustrd"):
            if ustrd.text and ustrd.text.strip():
                descriptions.append(ustrd.text.strip())
        for strd in findall(tx, "RmtInf/Strd"):
            cref = text(strd, "CdtrRefInf/Ref")
            if cref:
                descriptions.append(cref)
            descriptions.extend(
                n.text.strip() for n in findall(strd, "AddtlRmtInf") if n.text and n.text.strip()
            )
        addtl = text(tx, "AddtlTxInf")
        if addtl:
            descriptions.append(addtl)

        e2e = text(tx, "Refs/EndToEndId")
        if e2e and e2e.upper() != "NOTPROVIDED":
            refs.append(f"E2E {e2e}")

    addtl_ntry = text(ntry, "AddtlNtryInf")
    if addtl_ntry and addtl_ntry not in descriptions:
        descriptions.append(addtl_ntry)

    entry.counterparty_name = "; ".join(names)
    entry.counterparty_account = "; ".join(accounts)
    entry.description = " / ".join(dict.fromkeys(descriptions))  # dedupe, keep order
    entry.references = refs
    return entry


def parse_statement(stmt: ET.Element) -> Statement:
    acct = find(stmt, "Acct")
    balances = []
    for bal in findall(stmt, "Bal"):
        amt = find(bal, "Amt")
        value = to_decimal(amt.text if amt is not None else "0")
        if text(bal, "CdtDbtInd") == "DBIT":
            value = -value
        balances.append(
            Balance(
                code=text(bal, "Tp/CdOrPrtry/Cd", "Tp/CdOrPrtry/Prtry"),
                amount=value,
                currency=amt.get("Ccy", "") if amt is not None else "",
                date=parse_date(find(bal, "Dt")),
            )
        )

    s = Statement(
        id=text(stmt, "Id"),
        sequence=text(stmt, "ElctrncSeqNb", "LglSeqNb"),
        created=text(stmt, "CreDtTm"),
        period_from=text(stmt, "FrToDt/FrDtTm")[:10],
        period_to=text(stmt, "FrToDt/ToDtTm")[:10],
        iban=parse_account(acct),
        currency=text(acct, "Ccy"),
        owner=text(acct, "Ownr/Nm"),
        bic=text(acct, "Svcr/FinInstnId/BICFI", "Svcr/FinInstnId/BIC"),
        balances=balances,
        entries=[parse_entry(n) for n in findall(stmt, "Ntry")],
    )

    summary = find(stmt, "TxsSummry")
    if summary is not None:
        s.n_credit = text(summary, "TtlCdtNtries/NbOfNtries")
        s.n_debit = text(summary, "TtlDbtNtries/NbOfNtries")
        if text(summary, "TtlCdtNtries/Sum"):
            s.sum_credit = to_decimal(text(summary, "TtlCdtNtries/Sum"))
        if text(summary, "TtlDbtNtries/Sum"):
            s.sum_debit = to_decimal(text(summary, "TtlDbtNtries/Sum"))
    return s


def parse_file(path: Path) -> list[Statement]:
    root = ET.parse(path).getroot()
    stmts = root.findall(f".//{_path('Stmt')}")
    if not stmts:
        raise ValueError(f"{path}: no <Stmt> elements found - is this a camt.053 file?")
    return [parse_statement(s) for s in stmts]


# --------------------------------------------------------------------------- #
# Formatting helpers
# --------------------------------------------------------------------------- #


def fmt_amount(value: Decimal | None, lang: str) -> str:
    if value is None:
        return ""
    s = f"{value:,.2f}"  # 1,234.56
    if lang == "nl":
        s = s.replace(",", "_").replace(".", ",").replace("_", ".")  # 1.234,56
    return s


def fmt_date(s: str, lang: str) -> str:
    if not s:
        return ""
    try:
        d = datetime.fromisoformat(s[:10])
    except ValueError:
        return s
    return d.strftime("%d-%m-%Y" if lang == "nl" else "%Y-%m-%d")


def fmt_datetime(s: str, lang: str) -> str:
    if not s:
        return ""
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return s
    return d.strftime("%d-%m-%Y %H:%M" if lang == "nl" else "%Y-%m-%d %H:%M")


def p(s: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(escape(s).replace("\n", "<br/>"), style)


# --------------------------------------------------------------------------- #
# PDF rendering
# --------------------------------------------------------------------------- #

BRAND = colors.HexColor("#1F3A5F")
LIGHT = colors.HexColor("#EEF2F7")
GRID = colors.HexColor("#C9D2DE")
RED = colors.HexColor("#B00020")
GREEN = colors.HexColor("#1B7F3B")


def build_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("t", parent=base["Title"], fontSize=16, textColor=BRAND,
                                alignment=0, spaceAfter=4),
        "h2": ParagraphStyle("h2", parent=base["Heading2"], fontSize=11, textColor=BRAND,
                             spaceBefore=8, spaceAfter=4),
        "cell": ParagraphStyle("c", parent=base["BodyText"], fontSize=7.5, leading=9.5),
        "cell_small": ParagraphStyle("cs", parent=base["BodyText"], fontSize=6.5, leading=8,
                                     textColor=colors.HexColor("#555555")),
        "num": ParagraphStyle("n", parent=base["BodyText"], fontSize=7.5, leading=9.5,
                              alignment=TA_RIGHT),
        "hdr": ParagraphStyle("h", parent=base["BodyText"], fontSize=7.5, leading=9.5,
                              textColor=colors.white, fontName="Helvetica-Bold"),
        "hdr_num": ParagraphStyle("hn", parent=base["BodyText"], fontSize=7.5, leading=9.5,
                                  textColor=colors.white, fontName="Helvetica-Bold",
                                  alignment=TA_RIGHT),
        "info": ParagraphStyle("i", parent=base["BodyText"], fontSize=8.5, leading=11),
        "ok": ParagraphStyle("ok", parent=base["BodyText"], fontSize=8, textColor=GREEN),
        "warn": ParagraphStyle("w", parent=base["BodyText"], fontSize=8, textColor=RED,
                               fontName="Helvetica-Bold"),
    }


def kv_table(rows: list[tuple[str, str]], st: dict, widths: tuple[float, float]) -> Table:
    data = [[p(k, st["cell"]), p(v, st["info"])] for k, v in rows if v]
    t = Table(data, colWidths=widths, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#555555")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    return t


def statement_flowables(s: Statement, st: dict, L: dict, lang: str, page_w: float) -> list:
    out: list = []
    ccy = s.currency or (s.balances[0].currency if s.balances else "")

    out.append(p(L["title"], st["title"]))

    left = kv_table([
        (L["account"], s.iban),
        (L["currency"], ccy),
        (L["owner"], s.owner),
        (L["bank"], s.bic),
    ], st, (32 * mm, 85 * mm))
    period = " – ".join(x for x in (fmt_date(s.period_from, lang), fmt_date(s.period_to, lang)) if x)
    right = kv_table([
        (L["statement_id"], s.id),
        (L["sequence"], s.sequence),
        (L["period"], period),
        (L["created"], fmt_datetime(s.created, lang)),
    ], st, (28 * mm, 85 * mm))
    header = Table([[left, right]], colWidths=(page_w / 2, page_w / 2), hAlign="LEFT")
    header.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"),
                                ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    out += [header, Spacer(1, 4 * mm)]

    # Balances
    if s.balances:
        out.append(p(L["balances"], st["h2"]))
        rows = [[p(L["balance_type"], st["hdr"]), p(L["date"], st["hdr"]),
                 p(f'{L["amount"]} ({ccy})', st["hdr_num"])]]
        for b in s.balances:
            label = L["bal"].get(b.code, b.code)
            rows.append([p(f"{label} ({b.code})", st["cell"]), p(fmt_date(b.date, lang), st["cell"]),
                         p(fmt_amount(b.amount, lang), st["num"])])
        t = Table(rows, colWidths=(70 * mm, 30 * mm, 40 * mm), hAlign="LEFT")
        t.setStyle(_grid_style())
        out.append(t)

    # Entries
    out.append(p(f'{L["entries"]} ({len(s.entries)})', st["h2"]))
    if not s.entries:
        out.append(p(L["no_entries"], st["info"]))
    else:
        widths = [21 * mm, 22 * mm, 46 * mm, 0, 22 * mm, 22 * mm]
        widths[3] = page_w - sum(widths)
        rows = [[
            p(L["booking_date"], st["hdr"]), p(L["value_date"], st["hdr"]),
            p(L["counterparty"], st["hdr"]), p(L["description"], st["hdr"]),
            p(L["debit"], st["hdr_num"]), p(L["credit"], st["hdr_num"]),
        ]]
        for e in s.entries:
            cp = [p(e.counterparty_name, st["cell"])]
            if e.counterparty_account:
                cp.append(p(e.counterparty_account, st["cell_small"]))
            desc = [p(e.description, st["cell"])]
            meta = [r for r in e.references]
            if e.bank_tx_code:
                meta.append(e.bank_tx_code)
            if e.status and e.status != "BOOK":
                meta.append(e.status)
            if e.reversal:
                meta.append(L["reversal"])
            if meta:
                desc.append(p(" · ".join(meta), st["cell_small"]))
            amt = fmt_amount(e.amount, lang)
            rows.append([
                p(fmt_date(e.booking_date, lang), st["cell"]),
                p(fmt_date(e.value_date, lang), st["cell"]),
                cp, desc,
                p("" if e.is_credit else amt, st["num"]),
                p(amt if e.is_credit else "", st["num"]),
            ])
        t = Table(rows, colWidths=widths, repeatRows=1, hAlign="LEFT")
        style = _grid_style()
        for i in range(2, len(rows), 2):
            style.add("BACKGROUND", (0, i), (-1, i), LIGHT)
        t.setStyle(style)
        out.append(t)

    # Summary + reconciliation
    credits = sum((e.amount for e in s.entries if e.is_credit), Decimal(0))
    debits = sum((e.amount for e in s.entries if not e.is_credit), Decimal(0))
    n_cr = s.n_credit or str(sum(1 for e in s.entries if e.is_credit))
    n_db = s.n_debit or str(sum(1 for e in s.entries if not e.is_credit))
    summary = [p(L["summary"], st["h2"]), kv_table([
        (L["n_credit"], n_cr),
        (L["sum_credit"], f"{ccy} {fmt_amount(s.sum_credit if s.sum_credit is not None else credits, lang)}"),
        (L["n_debit"], n_db),
        (L["sum_debit"], f"{ccy} {fmt_amount(s.sum_debit if s.sum_debit is not None else debits, lang)}"),
    ], st, (45 * mm, 60 * mm))]

    bal = {b.code: b.amount for b in s.balances}
    opening = bal.get("OPBD", bal.get("PRCD"))
    closing = bal.get("CLBD")
    if opening is not None and closing is not None:
        calc = opening + credits - debits
        summary.append(Spacer(1, 2 * mm))
        if calc == closing:
            summary.append(p(L["reconcile_ok"], st["ok"]))
        else:
            summary.append(p(L["reconcile_fail"].format(
                calc=fmt_amount(calc, lang), closing=fmt_amount(closing, lang)), st["warn"]))
    out.append(KeepTogether(summary))
    return out


def _grid_style() -> TableStyle:
    return TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BRAND),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, GRID),
        ("BOX", (0, 0), (-1, -1), 0.5, GRID),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
    ])


def render_pdf(statements: list[Statement], out_path: Path, source_name: str, lang: str,
               orientation: str) -> None:
    L = LABELS[lang]
    pagesize = landscape(A4) if orientation == "landscape" else A4
    margin = 14 * mm
    doc = SimpleDocTemplate(
        str(out_path), pagesize=pagesize,
        leftMargin=margin, rightMargin=margin, topMargin=margin, bottomMargin=16 * mm,
        title=f'{L["title"]} {statements[0].iban}'.strip(),
        author="camt053_to_pdf",
    )
    page_w = pagesize[0] - 2 * margin
    st = build_styles()

    story: list = []
    for i, s in enumerate(statements):
        if i:
            story.append(PageBreak())
        story += statement_flowables(s, st, L, lang, page_w)

    def footer(canvas, doc_):
        canvas.saveState()
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(colors.HexColor("#777777"))
        canvas.drawString(margin, 9 * mm, f'{L["generated"]} {source_name}')
        canvas.drawRightString(pagesize[0] - margin, 9 * mm, f'{L["page"]} {doc_.page}')
        canvas.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def safe_name(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in s)[:80] or "statement"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Convert camt.053 XML bank statements to PDF.")
    ap.add_argument("inputs", nargs="+", help="camt.053 XML file(s); wildcards allowed")
    ap.add_argument("-o", "--output",
                    help="output PDF (single input) or output directory (default: next to input)")
    ap.add_argument("--lang", choices=sorted(LABELS), default="nl", help="label language (default: nl)")
    ap.add_argument("--orientation", choices=("portrait", "landscape"), default="portrait")
    ap.add_argument("--split", action="store_true",
                    help="write one PDF per <Stmt> instead of one PDF per input file")
    args = ap.parse_args(argv)

    files: list[Path] = []
    for pattern in args.inputs:
        matches = glob.glob(pattern)
        files += [Path(m) for m in matches] if matches else [Path(pattern)]

    out_arg = Path(args.output) if args.output else None
    out_is_dir = out_arg is not None and (len(files) > 1 or args.split or out_arg.suffix.lower() != ".pdf")
    if out_is_dir:
        out_arg.mkdir(parents=True, exist_ok=True)

    errors = 0
    for f in files:
        try:
            statements = parse_file(f)
        except (ET.ParseError, OSError, ValueError) as exc:
            print(f"ERROR {f}: {exc}", file=sys.stderr)
            errors += 1
            continue

        out_dir = out_arg if out_is_dir else f.parent
        jobs: list[tuple[list[Statement], Path]]
        if args.split:
            jobs = [([s], out_dir / f"{f.stem}_{safe_name(s.id or str(i + 1))}.pdf")
                    for i, s in enumerate(statements)]
        else:
            target = out_arg if (out_arg and not out_is_dir) else out_dir / f"{f.stem}.pdf"
            jobs = [(statements, target)]

        for stmts, target in jobs:
            render_pdf(stmts, target, f.name, args.lang, args.orientation)
            n_entries = sum(len(s.entries) for s in stmts)
            print(f"{f} -> {target} ({len(stmts)} statement(s), {n_entries} entries)")

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
