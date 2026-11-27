// Daily check for newly released PURSUE videos.
// Finds video case pages not yet in the browser, reads each one's DVIDS thumbnail
// (which encodes the DVIDS id, DOD file number and upload folder), and writes extra.json.
// Runs on GitHub Actions (Node 20+, built-in fetch). No dependencies.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SITEMAP = 'https://uapbrowser.com/sitemaps/cases-vid.xml';
const MAX_NEW_PER_RUN = 80;
const UA = { 'user-agent': 'ufo-video-browser updater (github.com/mascari16/ufo-video-browser)' };

const full = id => (id.includes('-') ? id : 'DOW-UAP-' + id).toUpperCase().replace(/-PR0*(\d+)([A-Z]?)$/, (m, n, l) => '-PR' + n.padStart(3, '0') + l);
const html = readFileSync('index.html', 'utf8');
const known = new Set();
for (const m of html.matchAll(/^\['([^']+)',/gm)) known.add(full(m[1]));
const extraPath = 'extra.json';
const extra = existsSync(extraPath) ? JSON.parse(readFileSync(extraPath, 'utf8')) : [];
for (const v of extra) known.add(full(v.id));
const knownRel = [...html.matchAll(/^\['[^']+',(\d+),/gm)].map(m => +m[1]).concat(extra.map(v => +v.release || 0));
let maxRel = Math.max(0, ...knownRel);

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) return await r.text();
      if (r.status === 404) return '';
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  return '';
}

const meta = (page, prop) => {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = page.match(re);
  return m ? (m[1] ?? m[2] ?? '').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"') : '';
};
const titleCase = s => s.replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\bU S\b/g, 'U.S.').replace(/\bOf\b/g, 'of');

// ---- Source 1 (government): search DVIDS, where war.gov hosts every PURSUE video ----
const today0 = new Date().toISOString().slice(0, 10);
const dvidsFound = [];
for (const q of ['DOW-UAP', 'FBI-UAP', 'LLE-UAP', 'DOE-UAP']) {
  for (let page = 1; page <= 3; page++) {
    const html = await get(`https://www.dvidshub.net/search/?q=%22${q}%22&filter%5Btype%5D=video&sort=date&page=${page}`);
    if (!html) { if (page === 1) console.log(`DVIDS search unreachable for ${q}.`); break; }
    const hits = [...html.matchAll(/\/video\/(\d{6,8})\/([a-z0-9-]*?((?:dow|fbi|lle|doe)-uap-pr\d+[a-z]?)[a-z0-9-]*)/gi)];
    if (page === 1) console.log(`DVIDS search "${q}": ${hits.length} matching links on page 1.`);
    let fresh = 0;
    for (const h of hits) {
      const id = full(h[3]);
      if (known.has(id) || dvidsFound.some(d => d.id === id)) continue;
      dvidsFound.push({ id, dv: h[1], slug: h[2] }); fresh++;
    }
    if (!hits.length || !fresh) break; // results are newest-first; stop once a page has nothing new
  }
}
var dvidsAdded = [];
for (const d of dvidsFound.slice(0, MAX_NEW_PER_RUN)) {
  const page = await get(`https://www.dvidshub.net/video/${d.dv}`);
  const img = page && page.match(/thumbs\/frames\/video\/(\d{4})\/(\d+)\/DOD_(\d+)\.0*(\d+)\//);
  if (!img) { console.log(`skip ${d.id}: DVIDS page not readable`); continue; }
  const title = (meta(page, 'og:title') || d.id).replace(/\s*[|–-]\s*DVIDS.*$/i, '').trim();
  if (/\baudio\b/i.test(title + ' ' + d.slug)) { console.log(`skip ${d.id}: audio recording`); continue; }
  const desc = meta(page, 'og:description') || meta(page, 'description');
  const rest = d.slug.replace(/^.*?uap-pr\d+[a-z]?-?/i, '').replace(/^unresolved-uap-report-?/, '');
  const yr = (rest.match(/(19|20)\d{2}/) || [''])[0];
  const location = titleCase(rest.replace(/-?(19|20)\d{2}.*$/, '').replace(/-/g, ' ').trim());
  dvidsAdded.push({ id: d.id, release: 0, releaseDate: today0, location, captured: yr, duration: null,
    agency: d.id.startsWith('FBI') ? 'FBI' : d.id.startsWith('LLE') ? 'Local police' : /Middle East|Iraq|Syria|Iran/i.test(location) ? 'CENTCOM' : /China Sea|Yellow Sea|Japan|Indo/i.test(location) ? 'INDOPACOM' : 'Not stated',
    sensor: /infrared/i.test(title + desc) ? 'IR' : 'EO/IR', title: title.slice(0, 200), description: desc.slice(0, 600),
    dvids: img[2], dod: img[3], ym: img[1], fr: img[4], note: 'Added automatically from DVIDS; details may be refined later.' });
  console.log(`found ${d.id} on DVIDS (${d.dv})`);
  await new Promise(r => setTimeout(r, 400));
}
console.log(`DVIDS: ${dvidsFound.length} new ID(s) spotted, ${dvidsAdded.length} ready to add.`);

const xml = await get(SITEMAP);
if (!xml) console.log('uapbrowser sitemap unreachable; using the other sources.');
const slugs = [...new Set([...(xml || '').matchAll(/https:\/\/uapbrowser\.com\/en\/cases\/([a-z0-9-]+)/g)].map(m => m[1]))];
const found = [];
for (const slug of slugs) {
  const m = slug.match(/^((?:dow|fbi|lle|nasa|doe)-uap-pr\d+[a-z]?)(?:-(.*))?$/);
  if (!m) continue;
  const id = full(m[1]);
  if (known.has(id) || found.some(f => f.id === id)) continue;
  found.push({ id, slug, rest: m[2] || '' });
}
console.log(`${slugs.length} case pages in sitemap, ${found.length} new video IDs.`);

const today = new Date().toISOString().slice(0, 10);
let added = 0, newRel = 0;
for (const v of dvidsAdded) {
  if (known.has(v.id)) continue;
  if (!newRel) newRel = maxRel + 1;
  v.release = newRel; extra.push(v); known.add(v.id); added++;
  console.log(`added ${v.id} from DVIDS (release ${v.release})`);
}
for (const f of found.slice(0, MAX_NEW_PER_RUN)) {
  if (known.has(f.id)) continue; // already picked up from DVIDS
  const page = await get(`https://uapbrowser.com/en/cases/${f.slug}`);
  if (!page) continue;
  const img = (meta(page, 'og:image').match(/thumbs\/frames\/video\/(\d{4})\/(\d+)\/DOD_(\d+)\.0*(\d+)\//) ||
               page.match(/thumbs\/frames\/video\/(\d{4})\/(\d+)\/DOD_(\d+)\.0*(\d+)\//));
  if (!img) { console.log(`skip ${f.id}: no DVIDS thumbnail (probably audio or not posted yet)`); continue; }
  if (/\baudio\b/i.test(meta(page, 'og:title') + ' ' + f.slug)) { console.log(`skip ${f.id}: audio recording`); continue; }
  const [, ym, dvids, dod, fr] = img;
  const title = meta(page, 'og:title').replace(/\s*[|–-]\s*UAP ?Browser.*$/i, '').trim();
  const desc = meta(page, 'og:description') || meta(page, 'description');
  const dur = +(meta(page, 'og:video:duration') || meta(page, 'video:duration')) || null;
  const relM = page.match(/releases\/release-(\d{1,2})/);
  let release = relM ? +relM[1] : 0;
  if (!release) { if (!newRel) newRel = maxRel + 1; release = newRel; }
  // location + year from the slug, e.g. "unresolved-uap-report-yellow-sea-2023"
  let rest = f.rest.replace(/^unresolved-uap-report-?/, '');
  const yr = (rest.match(/-?(\d{4})$/) || [])[1] || '';
  rest = rest.replace(/-?\d{4}$/, '').replace(/-(january|february|march|april|may|june|july|august|september|october|november|december)$/, '');
  const location = titleCase(rest.replace(/-/g, ' ').trim());
  const sensor = /infrared|\bIR\b/i.test(title + desc) && !/EO\/IR|electro/i.test(title + desc) ? 'IR'
    : /cellphone|phone|handheld/i.test(title + desc) ? 'Handheld' : /thermal/i.test(title + desc) ? 'Thermal' : 'EO/IR';
  const agency = f.id.startsWith('FBI') ? 'FBI' : f.id.startsWith('LLE') ? 'Local police' : /CENTCOM|Middle East/i.test(title + location) ? 'CENTCOM'
    : /INDOPACOM|China Sea|Yellow Sea|Japan/i.test(title + location) ? 'INDOPACOM' : 'Not stated';
  extra.push({
    id: f.id, release, releaseDate: today, location, captured: yr, duration: dur, agency, sensor,
    title: (title || `${f.id} video`).slice(0, 200), description: desc.slice(0, 600), dvids, dod, ym, fr,
    note: 'Added automatically by the daily update; details may be refined later.'
  });
  known.add(f.id); added++;
  console.log(`added ${f.id} (release ${release}, DVIDS ${dvids})`);
  await new Promise(r => setTimeout(r, 400));
}

// ---- Source B: war.gov's own catalog CSV → each video's DVIDS page ----
function parseCSV(t) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const CSV_URLS = ['https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-csv.csv'];
for (const u of CSV_URLS) {
  const txt = await get(u);
  if (!txt || !/UAP/i.test(txt)) { console.log(`war.gov catalog unreachable or empty (${u}); relying on the other source.`); continue; }
  const rows = parseCSV(txt), head = (rows.shift() || []).map(h => h.toLowerCase());
  const col = (...names) => head.findIndex(h => names.some(n => h.includes(n)));
  const cLoc = col('location'), cInc = col('incident date', 'incident'), cRel = col('release'), cAg = col('agency'), cTitle = col('title', 'name'), cDesc = col('description', 'summary');
  let n = 0;
  for (const r of rows) {
    const line = r.join(' | ');
    const idm = line.match(/\b((?:DOW|FBI|LLE|DOE)-UAP-PR\d+[A-Za-z]?)\b/i), dv = line.match(/dvidshub\.net\/video\/(\d+)/);
    if (!idm || !dv) continue;
    const id = full(idm[1]);
    if (known.has(id) || /\baudio\b/i.test(line)) continue;
    const page = await get(`https://www.dvidshub.net/video/${dv[1]}`);
    const img = page && page.match(/thumbs\/frames\/video\/(\d{4})\/(\d+)\/DOD_(\d+)\.0*(\d+)\//);
    if (!img) { console.log(`skip ${id}: DVIDS page not readable yet`); continue; }
    const relRaw = cRel >= 0 ? r[cRel] : '', relNum = +(relRaw.match(/\b0?(\d{1,2})\b/) || [])[1] || 0;
    const relDate = (relRaw.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/) || []);
    const releaseDate = relDate.length ? `${relDate[3].length === 2 ? '20' + relDate[3] : relDate[3]}-${relDate[1].padStart(2, '0')}-${relDate[2].padStart(2, '0')}` : today;
    let release = relNum && relNum < 50 && !relDate.length ? relNum : 0;
    if (!release) { if (!newRel) newRel = maxRel + 1; release = newRel; }
    const inc = cInc >= 0 ? r[cInc] : '', yr = (inc.match(/(19|20)\d{2}/) || [''])[0] || ((inc.match(/\/(\d{2})$/) || [])[1] ? '20' + inc.match(/\/(\d{2})$/)[1] : '');
    const title = ((cTitle >= 0 ? r[cTitle] : '') || id).slice(0, 200), desc = cDesc >= 0 ? r[cDesc] : '';
    const location = cLoc >= 0 ? r[cLoc] : '';
    extra.push({ id, release, releaseDate, location, captured: yr, duration: null, agency: (cAg >= 0 ? r[cAg] : '') || 'Not stated',
      sensor: /infrared/i.test(title + desc) ? 'IR' : 'EO/IR', title, description: desc.slice(0, 600), dvids: img[2], dod: img[3], ym: img[1], fr: img[4],
      note: 'Added automatically from the war.gov catalog; details may be refined later.' });
    known.add(id); added++; n++;
    console.log(`added ${id} from war.gov catalog (DVIDS ${img[2]})`);
  }
  console.log(`war.gov catalog: ${rows.length} rows read, ${n} new video(s).`);
}

if (added) {
  writeFileSync(extraPath, JSON.stringify(extra, null, 1) + '\n');
  console.log(`Wrote ${added} new video(s) to ${extraPath}.`);
} else {
  if (!existsSync(extraPath)) writeFileSync(extraPath, '[]\n');
  console.log('No new videos.');
}
const hb = 'last-check.json', prev = existsSync(hb) ? JSON.parse(readFileSync(hb, 'utf8')) : {};
const stale = !prev.heartbeat || (Date.now() - Date.parse(prev.heartbeat)) > 25 * 864e5;
if (added || stale) writeFileSync(hb, JSON.stringify({ heartbeat: new Date().toISOString(), lastAdded: added ? today : (prev.lastAdded || null) }, null, 1) + '\n');
