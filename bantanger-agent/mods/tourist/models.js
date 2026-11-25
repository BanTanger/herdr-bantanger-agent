// The models omp can run a tour with. omp's own catalog lists every provider it knows, most of
// which this machine cannot call, and building it takes half a minute: the lists it actually
// runs with are in ~/.omp/agent/models.yml (its providers and models) and config.yml (its model
// roles). Both are read straight from disk, so the picker opens at once.
import { exec, home, readTextFile } from "herdr";

const MODELS_FILE = ".omp/agent/models.yml";
const CONFIG_FILE = ".omp/agent/config.yml";
const CACHE = "tourist.models.v1";
const CACHE_MS = 24 * 3600 * 1000;

/** A YAML scalar, unquoted. */
function scalar(text) {
  return text.trim().replace(/^["']|["']$/g, "");
}

/**
 * The providers' models from models.yml: `[{ provider, id, name, contextWindow }]`.
 * Only indentation decides: a provider is a key at two spaces, its models are items six deep.
 * @param {string} text
 */
export function parseModels(text) {
  const models = [];
  let provider = null, model = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "  ");
    const body = line.trim();
    if (!body || body.startsWith("#")) continue;
    const depth = line.length - line.trimStart().length;
    if (depth <= 2) {
      model = null;
      provider = depth === 2 && body.endsWith(":") ? body.slice(0, -1).trim() : null;
      continue;
    }
    if (depth <= 4) { model = null; continue; }
    const item = body.startsWith("- ") ? body.slice(2) : body;
    const at = item.indexOf(":");
    if (at < 0) continue;
    const key = item.slice(0, at).trim(), value = item.slice(at + 1).trim();
    if (key === "id" && value) {
      model = { provider, id: scalar(value) };
      if (provider) models.push(model);
    } else if (model && key === "name" && value) model.name = scalar(value);
    else if (model && key === "contextWindow") model.contextWindow = Number(value) || undefined;
  }
  return models.filter((m) => m.provider && m.id);
}

/**
 * The model roles and the provider order from config.yml: `{ roles: [{ role, selector }], order, standard }`.
 * @param {string} text
 */
export function parseConfig(text) {
  const roles = [], order = [];
  let section = null, sectionDepth = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "  ");
    const body = line.trim();
    if (!body || body.startsWith("#")) continue;
    const depth = line.length - line.trimStart().length;
    if (depth === 0) {
      section = body.endsWith(":") ? body.slice(0, -1).trim() : null;
      sectionDepth = 0;
      continue;
    }
    if (!section) continue;
    if (!sectionDepth) sectionDepth = depth;
    if (depth < sectionDepth) { section = null; continue; }
    if (depth > sectionDepth) continue;
    if (section === "modelRoles") {
      const at = body.indexOf(":");
      if (at > 0) {
        const selector = scalar(body.slice(at + 1));
        if (selector && !roles.some((r) => r.selector === selector)) roles.push({ role: body.slice(0, at).trim(), selector });
      }
    } else if (section === "modelProviderOrder" && body.startsWith("- ")) {
      const provider = scalar(body.slice(2));
      if (provider && !order.includes(provider)) order.push(provider);
    }
  }
  const standard = roles.find((r) => r.role === "default")?.selector ?? null;
  for (const { selector } of roles) {
    const provider = selector.split("/")[0];
    if (provider && !order.includes(provider)) order.push(provider);
  }
  return { roles, order, standard };
}

/** The catalogue read earlier today, or null. */
export function cachedModels() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE) ?? "null");
    if (cached && Array.isArray(cached.models) && Date.now() - cached.at < CACHE_MS) return cached;
  } catch {}
  return null;
}

/** omp's catalog for a machine whose files can't be read: slow, so it is kept for the day. */
async function catalog(on) {
  const cached = cachedModels();
  if (cached) return cached;
  const r = await exec("omp", ["models", "--json"], { on, timeout: 8000 });
  let all;
  try { all = JSON.parse(String(r?.stdout ?? "")).models; } catch { all = null; }
  if (!Array.isArray(all) || all.length === 0) throw new Error("omp 没有列出任何模型。");
  const models = all.filter((m) => m.kind === "chat" && m.selector)
    .map((m) => ({ provider: m.provider, id: m.id, selector: m.selector, name: m.name ?? m.id, contextWindow: m.contextWindow }));
  const listed = { models, standard: null, roles: [] };
  try { localStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), ...listed })); } catch {}
  return listed;
}

/**
 * This machine's models: omp's roles first, then every model its providers define, each with the
 * `provider/model` selector omp's `--model` takes. Falls back to `omp models --json` when the
 * files aren't there (another machine, another omp).
 */
export async function listModels(on) {
  const [modelsText, configText] = await Promise.all([
    readTextFile(`${home()}/${MODELS_FILE}`, { on }).catch(() => null),
    readTextFile(`${home()}/${CONFIG_FILE}`, { on }).catch(() => null),
  ]);
  if (modelsText === null) return catalog(on);
  const cfg = parseConfig(configText ?? "");
  const known = parseModels(modelsText).map((m) => ({
    ...m,
    selector: `${m.provider}/${m.id}`,
    common: cfg.order.includes(m.provider),
  }));
  if (known.length === 0) return catalog(on);
  const rank = (provider) => { const i = cfg.order.indexOf(provider); return i < 0 ? cfg.order.length : i; };
  const models = known
    .map((m, i) => ({ ...m, at: i }))
    .sort((a, b) => rank(a.provider) - rank(b.provider) || a.at - b.at)
    .map(({ at, ...m }) => m);
  return { models, standard: cfg.standard, roles: cfg.roles };
}
