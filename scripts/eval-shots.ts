/**
 * Scores the shot classifier against hand labels. Fill the `truth` column
 * of the labels.csv that run-shots.ts wrote (use the type keys: serve,
 * return, third_shot_drop, dink, drive, reset, ...; leave blank to skip a
 * row), then:
 *
 *   npx tsx scripts/eval-shots.ts shot-results/<clip>/labels.csv
 *
 * Prints overall accuracy, per-type precision/recall, and the confusion
 * pairs that cost the most — the list you tune THRESHOLDS (shots.ts) from.
 * "Extreme accuracy" is a number this script prints, not a claim.
 */
import fs from "node:fs/promises";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: npx tsx scripts/eval-shots.ts <labels.csv>");
    process.exit(1);
  }
  const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
  const header = lines[0].split(",");
  const iPred = header.indexOf("predicted");
  const iTruth = header.indexOf("truth");
  const iConf = header.indexOf("confidence");
  const rows = lines
    .slice(1)
    .map((l) => l.split(","))
    .filter((r) => r[iTruth] && r[iTruth].trim());
  if (rows.length === 0) {
    console.log("No labelled rows yet — fill the `truth` column first.");
    return;
  }

  let correct = 0;
  const types = new Set<string>();
  const tp = new Map<string, number>(), fp = new Map<string, number>(), fn = new Map<string, number>();
  const confusion = new Map<string, number>();
  let confidentCorrect = 0, confidentTotal = 0;
  for (const r of rows) {
    const p = r[iPred].trim(), t = r[iTruth].trim();
    const conf = Number(r[iConf] ?? 0);
    types.add(p); types.add(t);
    if (p === t) { correct += 1; tp.set(t, (tp.get(t) ?? 0) + 1); }
    else { fp.set(p, (fp.get(p) ?? 0) + 1); fn.set(t, (fn.get(t) ?? 0) + 1); confusion.set(`${t} → ${p}`, (confusion.get(`${t} → ${p}`) ?? 0) + 1); }
    if (conf >= 0.5) { confidentTotal += 1; if (p === t) confidentCorrect += 1; }
  }
  console.log(`Accuracy: ${((correct / rows.length) * 100).toFixed(1)}%  (${correct}/${rows.length} labelled shots)`);
  if (confidentTotal) console.log(`Accuracy on shots with confidence ≥ 0.5: ${((confidentCorrect / confidentTotal) * 100).toFixed(1)}%  (${confidentTotal} shots)`);
  console.log("\nPer type            precision   recall   n");
  for (const t of [...types].sort()) {
    const TP = tp.get(t) ?? 0, FP = fp.get(t) ?? 0, FN = fn.get(t) ?? 0;
    const n = TP + FN;
    if (n === 0 && FP === 0) continue;
    const prec = TP + FP ? (TP / (TP + FP)) * 100 : 0;
    const rec = n ? (TP / n) * 100 : 0;
    console.log(`${t.padEnd(20)}${prec.toFixed(0).padStart(6)}%  ${rec.toFixed(0).padStart(6)}%  ${String(n).padStart(3)}`);
  }
  const worst = [...confusion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (worst.length) {
    console.log("\nMost common confusions (truth → predicted):");
    for (const [k, v] of worst) console.log(`  ${v.toString().padStart(3)}  ${k}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
