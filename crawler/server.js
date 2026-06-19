const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

async function searchDuckDuckGo(query) {
  const results = [];
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 10000 });
    const $ = cheerio.load(data);

    $('.result').each((i, el) => {
      if (i >= 20) return false;
      const titleEl = $(el).find('.result__title a');
      const snippetEl = $(el).find('.result__snippet');
      const linkEl = $(el).find('.result__url');

      const title = titleEl.text().trim();
      let href = titleEl.attr('href') || '';

      // DDG wraps links — extract the actual URL from the uddg param
      if (href.startsWith('//duckduckgo.com/l/?')) {
        const params = new URLSearchParams(href.replace('//duckduckgo.com/l/?', ''));
        href = params.get('uddg') || href;
      }
      if (href.startsWith('http') && title) {
        results.push({
          title,
          url: href,
          snippet: snippetEl.text().trim(),
          displayUrl: linkEl.text().trim() || new URL(href).hostname,
          source: 'DuckDuckGo',
        });
      }
    });
  } catch (err) {
    console.error('DDG search error:', err.message);
  }
  return results;
}

async function searchBing(query) {
  const results = [];
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=20`;
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 10000 });
    const $ = cheerio.load(data);

    $('#b_results .b_algo').each((i, el) => {
      if (i >= 20) return false;
      const titleEl = $(el).find('h2 a');
      const snippetEl = $(el).find('.b_caption p');
      const title = titleEl.text().trim();
      const href = titleEl.attr('href') || '';
      if (href.startsWith('http') && title) {
        results.push({
          title,
          url: href,
          snippet: snippetEl.text().trim(),
          displayUrl: (() => { try { return new URL(href).hostname; } catch { return href; } })(),
          source: 'Bing',
        });
      }
    });
  } catch (err) {
    console.error('Bing search error:', err.message);
  }
  return results;
}

async function fetchPageMeta(url) {
  try {
    const { data } = await axios.get(url, {
      headers: HEADERS,
      timeout: 6000,
      maxRedirects: 3,
    });
    const $ = cheerio.load(data);
    const description =
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      '';
    const title =
      $('title').text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      '';
    return { title, description: description.slice(0, 200) };
  } catch {
    return null;
  }
}

function deduplicateByDomain(results) {
  const seen = new Set();
  return results.filter(r => {
    try {
      const host = new URL(r.url).hostname.replace(/^www\./, '');
      if (seen.has(host)) return false;
      seen.add(host);
      return true;
    } catch {
      return false;
    }
  });
}

app.get('/api/crawl', async (req, res) => {
  const { query, enrich } = req.query;
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters.' });
  }

  try {
    const [ddgResults, bingResults] = await Promise.all([
      searchDuckDuckGo(query),
      searchBing(query),
    ]);

    // Merge and deduplicate
    const merged = deduplicateByDomain([...ddgResults, ...bingResults]);

    // Optionally enrich top results with live page metadata
    let final = merged;
    if (enrich === 'true') {
      const top = merged.slice(0, 8);
      const rest = merged.slice(8);
      const enriched = await Promise.all(
        top.map(async r => {
          const meta = await fetchPageMeta(r.url);
          if (meta && meta.description) r.snippet = meta.description;
          if (meta && meta.title) r.title = meta.title;
          return r;
        })
      );
      final = [...enriched, ...rest];
    }

    res.json({ query, count: final.length, results: final });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Crawler error: ' + err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Web Crawler running at http://localhost:${PORT}`);
});
