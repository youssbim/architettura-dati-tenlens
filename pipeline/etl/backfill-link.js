// Backfill: estrae dai grezzi (raw_pl.template) il link alla piattaforma di gara
// (documenti_di_gara_link) e all'avviso TED (link_eform_ted) e li salva sul lotto
// canonico come `link: { piattaforma, ted }`.
//
// Join: lotto.avvisi[].idAvviso == raw_pl._id (== idAvviso).
// Idempotente: ricalcola e fa $set; ri-eseguibile senza duplicati.
//
// Uso: docker exec -i garagraph-mongo mongosh garagraph < etl/backfill-link.js

const BATCH = 5000;

function estraiLink(template) {
  let piattaforma = null;
  let ted = null;
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === "string" && /^https?:\/\//i.test(v)) {
        if (!piattaforma && /documenti_di_gara_link/i.test(k)) piattaforma = v;
        if (!ted && /link_eform_ted/i.test(k)) ted = v;
      } else if (v && typeof v === "object") {
        walk(v);
      }
    }
  })(template);
  return { piattaforma, ted };
}

const totale = db.lotti.countDocuments({ "avvisi.0": { $exists: true } });
print("lotti con avvisi da processare: " + totale);

let processati = 0;
let conLink = 0;
let ops = [];

const cur = db.lotti.find({ "avvisi.0": { $exists: true } }, { avvisi: 1 });
while (cur.hasNext()) {
  const l = cur.next();
  const ids = (l.avvisi || []).map((a) => a.idAvviso).filter(Boolean);
  let piattaforma = null;
  let ted = null;

  if (ids.length) {
    const raws = db.raw_pl.find({ _id: { $in: ids } }, { template: 1 }).toArray();
    for (const r of raws) {
      const got = estraiLink(r.template);
      if (!piattaforma) piattaforma = got.piattaforma;
      if (!ted) ted = got.ted;
      if (piattaforma && ted) break;
    }
  }

  if (piattaforma || ted) {
    ops.push({
      updateOne: {
        filter: { _id: l._id },
        update: { $set: { link: { piattaforma: piattaforma, ted: ted } } },
      },
    });
    conLink++;
  }

  processati++;
  if (ops.length >= BATCH) {
    db.lotti.bulkWrite(ops, { ordered: false });
    ops = [];
    print("  ... " + processati + "/" + totale + " (con link: " + conLink + ")");
  }
}
if (ops.length) db.lotti.bulkWrite(ops, { ordered: false });

print("FATTO. processati: " + processati + " | con link: " + conLink);
print("verifica: lotti con link.piattaforma = " + db.lotti.countDocuments({ "link.piattaforma": { $ne: null } }));
print("verifica: lotti con link.ted = " + db.lotti.countDocuments({ "link.ted": { $ne: null } }));
