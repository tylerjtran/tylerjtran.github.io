#!/usr/bin/env node
/**
 * Fetches USDA Plants Database characteristics for all species in the
 * iNaturalist project and writes them to usda_cache.json.
 *
 * Run: node fetch-usda.js
 *
 * Only fetches species not already present in the cache, so it's safe
 * to re-run whenever new observations are added to the project.
 *
 * API endpoints discovered:
 *   PlantSearch?searchText={name}       → [{Plant: {Id, Symbol, ...}}]
 *   PlantProfile?symbol={symbol}        → {GrowthHabits, ...}
 *   PlantCharacteristics/{numericId}    → [{PlantCharacteristicName, PlantCharacteristicValue}]
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const INAT_API = 'https://api.inaturalist.org/v1';
const INAT_PROJECT = 'boy-scout-road';
const INAT_PLACE_ID = 235670;
const USDA_API = 'https://plantsservices.sc.egov.usda.gov/api';
const CACHE_FILE = path.join(__dirname, 'usda_cache.json');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'BoyScoutRoadPlants/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (!data.trim()) { reject(new Error(`Empty response from ${url}`)); return; }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}\nBody: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getInatSpecies() {
  let page = 1, results = [];
  while (true) {
    const url = `${INAT_API}/observations?project_id=${INAT_PROJECT}&place_id=${INAT_PLACE_ID}&per_page=50&page=${page}&order_by=observed_on`;
    console.log(`  Fetching iNat page ${page}…`);
    const data = await get(url);
    results = results.concat(data.results);
    if (results.length >= data.total_results) break;
    page++;
    await sleep(1000);
  }

  const seen = new Set();
  const species = [];
  for (const obs of results) {
    const t = obs.taxon;
    if (!t) continue;
    if (t.iconic_taxon_name && t.iconic_taxon_name !== 'Plantae') continue;
    if (t.rank !== 'species') continue;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    species.push({ taxonId: t.id, scientificName: t.name, commonName: t.preferred_common_name || t.name });
  }
  return species;
}

function stripHtml(s) {
  return s ? s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
}

async function findUsda(scientificName) {
  // Try genus+species first; if multi-word name, also try just first two tokens
  const names = [scientificName];
  const parts = scientificName.split(' ');
  if (parts.length > 2) names.push(parts.slice(0, 2).join(' '));

  for (const name of names) {
    const url = `${USDA_API}/PlantSearch?searchText=${encodeURIComponent(name)}`;
    const results = await get(url);
    if (!Array.isArray(results) || results.length === 0) { await sleep(300); continue; }

    // Prefer exact scientific name match (stripping HTML); fall back to first result
    const clean = n => stripHtml(n).replace(/ [A-Z][\w.].*$/, '').toLowerCase(); // strip author
    const exact = results.find(r => clean(r.Plant?.ScientificName) === name.toLowerCase());
    const match = (exact || results[0])?.Plant;
    if (match?.Symbol && match?.Id) return { symbol: match.Symbol, numericId: match.Id, matchedName: stripHtml(match.ScientificName) };
    await sleep(300);
  }
  return null;
}

async function getGrowthHabits(symbol) {
  const data = await get(`${USDA_API}/PlantProfile?symbol=${symbol}`);
  const habits = data.GrowthHabits || [];
  return habits.map(h => h === 'Graminoid' ? 'Grass' : h);
}

async function getCharacteristics(numericId) {
  const chars = await get(`${USDA_API}/PlantCharacteristics/${numericId}`);
  const map = {};
  for (const c of chars) map[c.PlantCharacteristicName] = c.PlantCharacteristicValue;
  return map;
}

function parseSeasons(period) {
  if (!period) return [];
  const seasons = [];
  if (/spring/i.test(period)) seasons.push('Spring');
  if (/summer/i.test(period)) seasons.push('Summer');
  if (/fall/i.test(period)) seasons.push('Fall');
  if (/winter/i.test(period)) seasons.push('Winter');
  return seasons;
}

function heightBin(ft) {
  if (ft == null) return null;
  if (ft < 1) return 'Under 1 ft';
  if (ft < 3) return '1–3 ft';
  if (ft < 10) return '3–10 ft';
  if (ft < 30) return '10–30 ft';
  return 'Over 30 ft';
}

async function main() {
  let cache = {};
  if (fs.existsSync(CACHE_FILE)) {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    // Clear entries that had errors so they get retried
    const retryKeys = Object.keys(cache).filter(k => cache[k].fetchError);
    retryKeys.forEach(k => delete cache[k]);
    console.log(`Loaded cache: ${Object.keys(cache).length} valid entries (${retryKeys.length} error entries will be retried).`);
  }

  console.log('\nFetching species from iNaturalist…');
  const species = await getInatSpecies();
  console.log(`Found ${species.length} species in project.\n`);

  const newSpecies = species.filter(s => !cache[String(s.taxonId)]);
  if (newSpecies.length === 0) {
    console.log('Cache is up to date — no new species to fetch.');
    return;
  }
  console.log(`${newSpecies.length} species to fetch from USDA:\n`);

  for (const s of newSpecies) {
    console.log(`[${s.taxonId}] ${s.scientificName} (${s.commonName})`);

    try {
      const found = await findUsda(s.scientificName);
      await sleep(400);

      if (!found) {
        console.log('  → Not found in USDA Plants\n');
        cache[String(s.taxonId)] = {
          taxonId: s.taxonId, scientificName: s.scientificName, notFound: true,
          growthHabits: [], evergreen: null, bloomPeriod: [], flowerColor: null,
          shadeTolerance: null, moistureUse: null, matureHeightFt: null, matureHeightBin: null,
        };
        continue;
      }

      console.log(`  → Symbol: ${found.symbol}  (${found.matchedName})`);

      const [growthHabits, chars] = await Promise.all([
        getGrowthHabits(found.symbol),
        getCharacteristics(found.numericId),
      ]);
      await sleep(400);

      const lr = chars['Leaf Retention'];
      const evergreen = lr === 'Yes' ? true : lr === 'No' ? false : null;

      const conspicuous = (chars['Flower Conspicuous'] || '').toLowerCase() === 'yes';
      const bloomPeriod = conspicuous ? parseSeasons(chars['Bloom Period'] || '') : [];
      const flowerColor = conspicuous ? (chars['Flower Color'] || null) : null;

      const shadeTolerance = chars['Shade Tolerance'] || null;
      const moistureUse = chars['Moisture Use'] || null;

      const heightRaw = chars['Height, Mature (feet)'];
      const matureHeightFt = heightRaw != null && heightRaw !== '' ? parseFloat(heightRaw) : null;

      const entry = {
        taxonId: s.taxonId,
        scientificName: s.scientificName,
        symbol: found.symbol,
        growthHabits,
        evergreen,
        bloomPeriod,
        flowerColor,
        shadeTolerance,
        moistureUse,
        matureHeightFt,
        matureHeightBin: heightBin(matureHeightFt),
      };
      cache[String(s.taxonId)] = entry;

      console.log(`  Growth habits : ${growthHabits.join(', ') || '—'}`);
      console.log(`  Evergreen     : ${evergreen ?? '—'}`);
      console.log(`  Bloom period  : ${bloomPeriod.join(', ') || '—'}`);
      console.log(`  Flower color  : ${flowerColor || '—'}`);
      console.log(`  Shade toler.  : ${shadeTolerance || '—'}`);
      console.log(`  Moisture use  : ${moistureUse || '—'}`);
      console.log(`  Mature height : ${matureHeightFt != null ? matureHeightFt + ' ft (' + entry.matureHeightBin + ')' : '—'}`);
      console.log();

    } catch (err) {
      console.error(`  ERROR: ${err.message}\n`);
      cache[String(s.taxonId)] = {
        taxonId: s.taxonId, scientificName: s.scientificName, fetchError: err.message,
        growthHabits: [], evergreen: null, bloomPeriod: [], flowerColor: null,
        shadeTolerance: null, moistureUse: null, matureHeightFt: null, matureHeightBin: null,
      };
    }

    await sleep(400);
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`\nSaved ${Object.keys(cache).length} entries to usda_cache.json`);

  const missing = Object.values(cache).filter(e => e.notFound || e.fetchError);
  if (missing.length) {
    console.log(`\n⚠ ${missing.length} species with no USDA data:`);
    missing.forEach(e => console.log(`  - ${e.scientificName} (${e.notFound ? 'not found' : 'fetch error'})`));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
