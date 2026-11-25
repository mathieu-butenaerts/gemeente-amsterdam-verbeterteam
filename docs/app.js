"use strict";
// Page UI: pick files, convert them with Camt (camt.js), offer the PDFs for download.

const $ = id => document.getElementById(id);
const results = []; // { filename, blob, url }

const safeName = s => (s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "statement");
const stem = name => name.replace(/\.[^.]+$/, "");
const pdfToBlob = dd => new Promise(resolve => pdfMake.createPdf(dd).getBlob(resolve));

function el(tag, className, textContent) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (textContent !== undefined) n.textContent = textContent;
  return n;
}

function addRow(title, metaParts, download, hashLine) {
  const li = el("li");
  const info = el("div");
  info.append(el("div", "name", title));
  const meta = el("div", "meta");
  metaParts.forEach(([t, cls], i) => {
    if (i) meta.append(" · ");
    meta.append(el("span", cls || "", t));
  });
  info.append(meta);
  if (hashLine) info.append(el("div", "hash", hashLine));
  li.append(info);
  if (download) {
    const a = el("a", "btn", "Download PDF");
    a.href = download.url;
    a.download = download.filename;
    li.append(a);
  }
  $("list").append(li);
  $("results").hidden = false;
}

function checkSummary(statements) {
  const checks = statements.map(Camt.reconcile);
  if (checks.some(r => r.status === "mismatch")) return ["saldo wijkt af", "warn"];
  if (checks.some(r => r.status === "unchecked")) return ["saldo niet gecontroleerd", "unchecked"];
  return ["saldo klopt", "ok"];
}

async function handleFiles(files) {
  const lang = $("lang").value, orientation = $("orientation").value, split = $("split").checked;
  for (const file of files) {
    let parsed;
    try {
      parsed = await Camt.readFile(file.name, await file.arrayBuffer());
    } catch (err) {
      const msg = err instanceof Camt.CamtError ? err.message : `Onverwachte fout: ${err.message}`;
      addRow(file.name, [["Afgekeurd – er is geen PDF gemaakt. " + msg, "error"]]);
      continue;
    }
    const { source, statements } = parsed;
    const jobs = split
      ? statements.map((s, i) => [[s], `${stem(file.name)}_${safeName(s.id || String(i + 1))}.pdf`])
      : [[statements, `${stem(file.name)}.pdf`]];
    for (const [stmts, filename] of jobs) {
      const blob = await pdfToBlob(Camt.docDefinition(stmts, source, lang, orientation));
      const url = URL.createObjectURL(blob);
      results.push({ filename, blob, url });
      const nEntries = stmts.reduce((a, s) => a + s.entries.length, 0);
      addRow(filename, [
        [stmts.map(s => s.iban).filter(Boolean).join(", ") || "onbekende rekening"],
        [`${stmts.length} afschrift(en), ${nEntries} transacties`],
        checkSummary(stmts),
      ], { url, filename }, `SHA-256 van ${file.name}: ${source.sha256}`);
    }
  }
}

$("drop").addEventListener("click", () => $("file").click());
$("drop").addEventListener("keydown", e => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); }
});
$("file").addEventListener("change", e => { handleFiles(Array.from(e.target.files)); e.target.value = ""; });
["dragenter", "dragover"].forEach(t => $("drop").addEventListener(t, e => { e.preventDefault(); $("drop").classList.add("over"); }));
["dragleave", "drop"].forEach(t => $("drop").addEventListener(t, e => { e.preventDefault(); $("drop").classList.remove("over"); }));
$("drop").addEventListener("drop", e => handleFiles(Array.from(e.dataTransfer.files)));

$("zip").addEventListener("click", async () => {
  const zip = new JSZip();
  const seen = {};
  for (const r of results) {
    let name = r.filename;
    if (seen[name]) name = `${stem(name)}_${seen[name]}.pdf`;
    seen[r.filename] = (seen[r.filename] || 0) + 1;
    zip.file(name, r.blob);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = "afschriften.zip";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

$("clear").addEventListener("click", () => {
  results.splice(0).forEach(r => URL.revokeObjectURL(r.url));
  $("list").replaceChildren();
  $("results").hidden = true;
});
