// Daily check for newly released PURSUE videos.
// Finds video case pages not yet in the browser, reads each one's DVIDS thumbnail
// (which encodes the DVIDS id, DOD file number and upload folder), and writes extra.json.
// Runs on GitHub Actions (Node 20+, built-in fetch). No dependencies.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SITEMAP = 'https://uapbrowser.com/sitemaps/cases-vid.xml';
const MAX_NEW_PER_RUN = 80;
const UA = { 'user-agent': 'ufo-video-browser updater (github.com/mascari16/ufo-video-browser)' };

const full = id => (id.includes('-') ? id : 'DOW-UAP-' + id).toUpperCase();
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

const xml = await get(SITEMAP);
if (!xml) { console.log('Sitemap unreachable; nothing changed.'); process.exit(0); }
const slugs = [...new Set([...xml.matchAll(/https:\/\/uapbrowser\.com\/en\/cases\/([a-z0-9-]+)/g)].map(m => m[1]))];
const found = [];
for (const slug of slugs) {
  const m = slug.match(/^((?:dow|fbi|lle|nasa|doe)-uap-pr\d+[a-z]?)(?:-(.*))?$/);
  if (!m) continue;
  const id = m[1].toUpperCase();
  if (known.has(id) || found.some(f => f.id === id)) continue;
  found.push({ id, slug, rest: m[2] || '' });
}
console.log(`${slugs.length} case pages in sitemap, ${found.length} new video IDs.`);

const today = new Date().toISOString().slice(0, 10);
let added = 0, newRel = 0;
for (const f of found.slice(0, MAX_NEW_PER_RUN)) {
  const page = await get(`https://uapbrowser.com/en/cases/${f.slug}`);
  if (!page) continue;
  const img = (meta(page, 'og:image').match(/thumbs\/frames\/video\/(\d{4})\/(\d+)\/DOD_(\d+)\.0*(\d+)\//) ||
               page.match(/thumbs\/frames\/video\/(\d{4})\/(\d+)\/DOD_(\d+)\.0*(\d+)\//));
  if (!img) { console.log(`skip ${f.id}: no DVIDS thumbnail (probably audio or not posted yet)`); continue; }
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
    title: title || `${f.id} video`, description: desc, dvids, dod, ym, fr,
    note: 'Added automatically by the daily update; details may be refined later.'
  });
  known.add(f.id); added++;
  console.log(`added ${f.id} (release ${release}, DVIDS ${dvids})`);
  await new Promise(r => setTimeout(r, 400));
}

if (added) {
  writeFileSync(extraPath, JSON.stringify(extra, null, 1) + '\n');
  console.log(`Wrote ${added} new video(s) to ${extraPath}.`);
} else {
  if (!existsSync(extraPath)) writeFileSync(extraPath, '[]\n');
  console.log('No new videos.');
}
