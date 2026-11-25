// Tours saved per tab. Reopening Tourist beside the same terminal brings back the tour it was
// on, at the stop it was on, without asking the agent for a plan again. The plan file it points
// at lives in plans/ (saved.js); this keeps which tab holds which plan, where the reader stopped,
// and the agent conversation they were having. `tours.json` is the index the sidebar reads.
import { appHome, readTextFile, writeTextFile } from "herdr";
import * as fs from "fs/promises";

const dir = () => `${appHome()}/data/tourist/tabs`.replace(/\\/g, "/");
const indexPath = () => `${appHome()}/data/tourist/tours.json`.replace(/\\/g, "/");
const file = (tab) => `${dir()}/${String(tab).replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;

/** The tour this tab had, or null. Anything unreadable counts as none. */
export async function loadTabTour(tab) {
  if (!tab) return null;
  try {
    const tour = JSON.parse((await readTextFile(file(tab))) ?? "null");
    return tour && Array.isArray(tour.plan?.stops) && tour.plan.stops.length ? tour : null;
  } catch { return null; }
}

/** Saves the tab's tour and refreshes the sidebar's index in one go. */
export async function saveTabTour(tab, tour) {
  if (!tab) return;
  const text = JSON.stringify({ ...tour, tab, at: new Date().toISOString() });
  try {
    await fs.mkdir(dir(), { recursive: true });
    const path = file(tab), before = await readTextFile(path).catch(() => null);
    await writeTextFile(path, text, before ?? null);
  } catch { return; } // a failed save only costs the next reopen its tour
  await updateIndex(tab, {
    tab, scope: tour.scope ?? "", title: tour.title ?? "", subject: tour.subject ?? "",
    idx: Number(tour.idx) || 0, total: tour.plan?.stops?.length ?? 0, at: new Date().toISOString(),
  });
}

/** Forgets this tab's tour (新导览). */
export async function clearTabTour(tab) {
  if (!tab) return;
  await fs.unlink(file(tab)).catch(() => {});
  await updateIndex(tab, null);
}

/** Every saved tour, for the sidebar: newest first. Rows whose file is gone are dropped. */
export async function listTours() {
  let rows = [];
  try { rows = JSON.parse((await readTextFile(indexPath())) ?? "[]"); } catch { rows = []; }
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row?.tab) continue;
    const tour = await loadTabTour(row.tab);
    if (tour) out.push(row);
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** Replaces one tab's row in the index (null removes it), writing the file compare-and-swap. */
async function updateIndex(tab, row) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let rows = [];
    const before = await readTextFile(indexPath()).catch(() => null);
    try { rows = before ? JSON.parse(before) : []; } catch { rows = []; }
    const next = (Array.isArray(rows) ? rows : []).filter(r => r?.tab !== tab);
    if (row) next.unshift(row);
    const text = JSON.stringify(next, null, 1);
    try {
      await fs.mkdir(`${appHome()}/data/tourist`.replace(/\\/g, "/"), { recursive: true });
      await writeTextFile(indexPath(), text, before);
      return;
    } catch { /* another pane wrote first: read it again */ }
  }
}
