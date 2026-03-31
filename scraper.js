const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { writePaginatedNewsArtifacts } = require('./src/utils/newsPagination');

function decodeHtmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'");
}

// Helper to clean encoded HTML and strip any leftover tags.
function cleanHtml(html) {
  if (!html) return '';

  let decoded = html.replace(/<br\s*\/?>/gi, ' ');
  for (let i = 0; i < 3; i++) {
    const next = decodeHtmlEntities(decoded);
    if (next === decoded) break;
    decoded = next;
  }

  return decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function collapseText(text) {
  return (text || '').replace(/[ \t]+/g, ' ').trim();
}

function collapseRichText(text) {
  return (text || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeUrl(url, baseUrl = '') {
  if (!url) return '';

  if (url.startsWith('//')) {
    return `https:${url}`;
  }

  try {
    return new URL(url, baseUrl || 'https://www.animenewsnetwork.com').toString();
  } catch (_) {
    return url;
  }
}

function extractUrlCandidate(value, baseUrl = '') {
  if (!value) return '';

  const normalized = value
    .split(',')
    .map(part => part.trim().split(/\s+/)[0])
    .find(Boolean) || '';

  if (!normalized || normalized.startsWith('data:image/')) {
    return '';
  }

  return normalizeUrl(normalized, baseUrl);
}

function getImageUrlFromNode($node, baseUrl = '') {
  const candidates = [
    $node.attr('data-src'),
    $node.attr('data-lazy-src'),
    $node.attr('data-image'),
    $node.attr('data-original'),
    $node.attr('data-srcset'),
    $node.attr('srcset'),
    $node.attr('data-bgset'),
    $node.attr('data-bg'),
    $node.attr('src'),
  ];

  for (const candidate of candidates) {
    const url = extractUrlCandidate(candidate, baseUrl);
    if (!url) continue;
    if (/spacer\.gif|blank\.(gif|png)$|bookmark-shorturl\.png$/i.test(url)) {
      continue;
    }
    return url;
  }

  return '';
}

function isNoiseText(text) {
  const cleaned = cleanHtml(text);
  if (!cleaned) return true;

  const lower = cleaned.toLowerCase();
  return [
    lower.startsWith('source:'),
    lower.startsWith('sources:'),
    lower.startsWith('official site:'),
    lower.startsWith('official website:'),
    lower.startsWith('official x:'),
    lower.startsWith('disclosure:'),
    lower === 'news homepage / archives',
    lower === 'homepage / archives',
    lower.startsWith('image via '),
    lower.startsWith('image courtesy of '),
    lower.startsWith('image courtesy '),
    lower.startsWith('credit:'),
    lower.startsWith('related:'),
    lower.startsWith('read next:'),
    lower.startsWith('continue reading:'),
    lower.startsWith('what do you think?'),
    lower.startsWith('leave a comment'),
    lower.startsWith('join the conversation'),
    lower.startsWith('videos by comicbook.com'),
    lower.startsWith('copyright '),
    (lower.startsWith('via ') && cleaned.length <= 80),
    /^[←→]\s+[a-z]+\s+\d{4}$/i.test(cleaned),
    /^(?:�|©|Â©)/.test(cleaned),
    lower.includes('pic.twitter.com/'),
    lower.includes('pic.x.com/'),
    lower.includes('looking for more anime coverage'),
  ].some(Boolean);
}

function splitCaptionAndCredit(text) {
  const cleaned = cleanHtml(text);
  if (!cleaned) return { caption: '', credit: '' };

  if (/^(image (via|courtesy of|courtesy)|credit:|Â©|copyright )/i.test(cleaned)) {
    return { caption: '', credit: cleaned };
  }

  const creditMatch = cleaned.match(/((?:�|©|Â©).+|Image (?:via|courtesy of|courtesy).+)$/i);
  if (!creditMatch) {
    return { caption: cleaned, credit: '' };
  }

  const credit = creditMatch[1].trim();
  const caption = cleaned.slice(0, cleaned.lastIndexOf(credit)).trim();
  return { caption, credit };
}

function createTextBlock(type, text, extra = {}) {
  const cleaned = cleanHtml(text);
  if (!cleaned || isNoiseText(cleaned)) return null;
  return { type, text: cleaned, ...extra };
}

function createLinkOrParagraphBlock(text) {
  const cleaned = cleanHtml(text);
  if (!cleaned || isNoiseText(cleaned)) return null;

  if (/^[A-Z][A-Za-z0-9&/()'".,: \-]{1,80}:$/.test(cleaned)) {
    return { type: 'heading', text: cleaned };
  }

  if (/^https?:\/\/\S+$/i.test(cleaned)) {
    return { type: 'link', text: cleaned, sourceUrl: cleaned };
  }

  return { type: 'paragraph', text: cleaned };
}

function blocksToPlainText(blocks) {
  return blocks
    .filter(block => ['heading', 'paragraph', 'quote', 'list_item'].includes(block.type))
    .map(block => {
      if (!block.text) return '';
      return block.type === 'list_item' ? `• ${block.text}` : block.text;
    })
    .filter(Boolean)
    .join('\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractContentBlocks(html, baseUrl = '') {
  if (!html) return [];

  const $ = cheerio.load(`<div id="article-body">${html}</div>`);
  const root = $('#article-body');

  root.find(
    'script, style, noscript, iframe, .share, .sharedaddy, .jp-relatedposts, .news-info-block, .social-share, .related, .ad, .advertisement, .wp-block-savage-platform-read-next, .read-next, .newsletter-form, .mailing-list, .social-embed, .twitter-tweet, .instagram-media, span[id^="ezoic-pub-ad-placeholder"], span[data-ez-ph-id]'
  ).remove();

  const blocks = [];
  const seenImages = new Set();
  const blockSelector =
    'figure, img, h2, h3, h4, blockquote, ul, ol, p, div, section, article';
  const blockTags = new Set([
    'figure',
    'img',
    'h2',
    'h3',
    'h4',
    'blockquote',
    'ul',
    'ol',
    'p',
    'div',
    'section',
    'article',
  ]);

  const pushBlock = block => {
    if (!block) return;

    if (block.type === 'image') {
      const key = block.imageUrl || '';
      if (!key || seenImages.has(key)) return;
      seenImages.add(key);
    }

    blocks.push(block);
  };

  const pushImageBlock = $node => {
    const imgNode = $node.is('img') ? $node : $node.find('img').first();
    if (!imgNode.length) return;

    const imageUrl = getImageUrlFromNode(imgNode, baseUrl);
    if (!imageUrl) return;

    const captionNode = $node.find('figcaption').first();
    const siblingCaptionNode = !captionNode.length
      ? $node.nextAll('figcaption').first().length
        ? $node.nextAll('figcaption').first()
        : $node.prevAll('figcaption').first()
      : null;
    const captionSource = captionNode.length
      ? captionNode.html() || captionNode.text()
      : siblingCaptionNode?.length
        ? siblingCaptionNode.html() || siblingCaptionNode.text()
      : imgNode.attr('alt') || '';
    const { caption, credit } = splitCaptionAndCredit(captionSource);

    pushBlock({
      type: 'image',
      imageUrl,
      ...(caption ? { caption } : {}),
      ...(credit ? { credit } : {}),
    });
  };

  let processNode = () => {};

  const recurseBlockChildren = $node => {
    const blockChildren = $node.children().filter((_, child) =>
      blockTags.has((child.tagName || '').toLowerCase())
    );
    if (!blockChildren.length) return false;

    blockChildren.each((_, child) => processNode($(child)));
    return true;
  };

  const pushListBlocks = $node => {
    $node.children('li').each((_, li) => {
      pushBlock(createTextBlock('list_item', $(li).text()));
    });
  };

  processNode = $node => {
    if (!$node.length) return;

    const tag = ($node[0].tagName || '').toLowerCase();
    if (!tag) return;

    if (tag === 'figure') {
      pushImageBlock($node);
      return;
    }

    if (tag === 'img') {
      pushImageBlock($node);
      return;
    }

    if (['h2', 'h3', 'h4'].includes(tag)) {
      pushBlock(createTextBlock('heading', $node.html() || $node.text()));
      return;
    }

    if (tag === 'blockquote') {
      pushBlock(createTextBlock('quote', $node.html() || $node.text()));
      return;
    }

    if (['ul', 'ol'].includes(tag)) {
      pushListBlocks($node);
      return;
    }

    if (['div', 'section', 'article'].includes(tag) && recurseBlockChildren($node)) {
      return;
    }

    if (tag === 'p') {
      $node.find('img').each((_, img) => pushImageBlock($(img)));

      const textClone = $node.clone();
      textClone.find(`${blockSelector}, figcaption`).remove();
      pushBlock(createLinkOrParagraphBlock(textClone.html() || textClone.text()));
      return;
    }

    recurseBlockChildren($node);
  };

  root.children().each((_, el) => processNode($(el)));

  if (!blocks.length) {
    pushBlock(createTextBlock('paragraph', root.text()));
  }

  return blocks;
}

function isMalSectionHeading(text) {
  return [
    /^week \d+:/i,
    /^(anime|manga|light novel|digital|home video|merchandise) releases$/i,
  ].some(pattern => pattern.test(text));
}

function looksLikeMalListItem(text) {
  return [
    /\bVol\.\d+/i,
    /\bBlu-ray\b/i,
    /\bDVD\b/i,
    /\[Light Novel\]/i,
    /\bSeason \d+\b/i,
    /\bVoyage \d+\b/i,
    /\bSteelBook\b/i,
  ].some(pattern => pattern.test(text));
}

function pushUniqueImageBlock(blocks, seenImages, imageUrl, extra = {}) {
  if (!imageUrl || seenImages.has(imageUrl)) return;
  seenImages.add(imageUrl);
  blocks.push({
    type: 'image',
    imageUrl,
    ...extra,
  });
}

function extractMalContentBlocks(html, baseUrl = '') {
  if (!html) return [];

  const $ = cheerio.load(`<div id="article-body">${html}</div>`, {
    decodeEntities: false,
  });
  const root = $('#article-body');

  root.find('script, style, noscript, iframe, .news-info-block').remove();

  const blocks = [];
  const seenImages = new Set();
  const paragraphBuffer = [];
  let currentLine = '';
  let inReleaseList = false;

  const flushParagraph = () => {
    const text = collapseRichText(paragraphBuffer.join(' '));
    paragraphBuffer.length = 0;
    if (!text || isNoiseText(text)) return;
    blocks.push({ type: 'paragraph', text });
  };

  const handleLine = text => {
    const normalized = collapseText(text);
    currentLine = '';

    if (!normalized) {
      flushParagraph();
      return;
    }

    if (isNoiseText(normalized)) {
      return;
    }

    if (isMalSectionHeading(normalized)) {
      flushParagraph();
      blocks.push({ type: 'heading', text: normalized });
      inReleaseList = !/^week \d+:/i.test(normalized);
      return;
    }

    if (inReleaseList || looksLikeMalListItem(normalized)) {
      flushParagraph();
      blocks.push({ type: 'list_item', text: normalized });
      return;
    }

    paragraphBuffer.push(normalized);
  };

  const appendHtml = htmlChunk => {
    currentLine += htmlChunk || '';
  };

  const flushCurrentLine = () => {
    if (!currentLine.trim()) {
      handleLine('');
      return;
    }

    handleLine(cleanHtml(currentLine));
  };

  const walkNode = node => {
    if (!node) return;

    if (node.type === 'text') {
      appendHtml(node.data || '');
      return;
    }

    if (node.type !== 'tag') {
      return;
    }

    const $node = $(node);
    const tag = (node.tagName || '').toLowerCase();

    if (tag === 'br') {
      flushCurrentLine();
      return;
    }

    if (tag === 'img') {
      flushCurrentLine();
      const imageUrl = getImageUrlFromNode($node, baseUrl);
      if (!imageUrl) return;
      const caption = cleanHtml($node.attr('alt') || '');
      pushUniqueImageBlock(blocks, seenImages, imageUrl, {
        ...(caption ? { caption } : {}),
      });
      return;
    }

    if (['p', 'div', 'section', 'article'].includes(tag)) {
      $node.contents().each((_, child) => walkNode(child));
      flushCurrentLine();
      return;
    }

    if (['ul', 'ol'].includes(tag)) {
      flushCurrentLine();
      $node.children('li').each((_, li) => {
        handleLine($(li).text());
      });
      return;
    }

    appendHtml($.html(node));
  };

  root.contents().each((_, node) => walkNode(node));
  flushCurrentLine();
  flushParagraph();

  return blocks;
}

function extractComicBookContentBlocks(html, baseUrl = '') {
  if (!html) return [];

  const $ = cheerio.load(`<div id="article-body">${html}</div>`);
  const root = $('#article-body');

  root.find(
    'script, style, noscript, iframe, .wp-block-savage-platform-read-next, .read-next, .newsletter-form, .mailing-list, .social-share, .related, .advertisement, .ad'
  ).remove();

  const orphanCaption = root.children('figcaption').first();
  const leadFigure = root.children('figure').first();
  if (orphanCaption.length && leadFigure.length && !leadFigure.find('figcaption').length) {
    leadFigure.append(`<figcaption>${orphanCaption.html() || orphanCaption.text()}</figcaption>`);
    orphanCaption.remove();
  }

  return extractContentBlocks(root.html() || '', baseUrl);
}

function extractAnimeCornerContentBlocks(html, baseUrl = '') {
  if (!html) return [];

  const $ = cheerio.load(`<div id="article-body">${html}</div>`);
  const root = $('#article-body');

  root.find(
    'script, style, noscript, iframe, .sharedaddy, .jp-relatedposts, .code-block, .advertisement, .ad, .twitter-tweet, .instagram-media, span[id^="ezoic-pub-ad-placeholder"], span[data-ez-ph-id]'
  ).remove();

  return extractContentBlocks(root.html() || '', baseUrl);
}

function applyStructuredContent(article, html, extractor = extractContentBlocks) {
  if (!html) return;

  const blocks = extractor(html, article.sourceUrl);
  if (blocks.length) {
    article.contentBlocks = blocks;

    const plainText = blocksToPlainText(blocks);
    if (plainText && plainText.length >= article.content.length) {
      article.content = plainText;
    }

    if (!article.imageUrl || article.imageUrl.includes('placehold')) {
      const firstImage = blocks.find(block => block.type === 'image' && block.imageUrl);
      if (firstImage?.imageUrl) {
        article.imageUrl = firstImage.imageUrl;
      }
    }
    return;
  }

  const fallback = cleanHtml(html);
  if (fallback && fallback.length > article.content.length) {
    article.content = fallback;
  }
}

// Custom NSFW Filter to avoid adult/ecchi articles from scraping
function isNSFW(title, description = '') {
  const lowerText = (title + ' ' + description).toLowerCase();
  const nsfwKeywords = [
    'hentai', 'ecchi', 'erotica', 'adult', 'panties', 'opantsu',
    'sex', 'nsfw', 'nipple', 'breasts', 'boobs', 'nudes',
    'naked', 'porn', 'r18', 'r-18', '18+', 'succubus',
    'succubi', 'virgin', 'harem', 'iya na kao sare nagara'
  ];
  return nsfwKeywords.some(keyword => lowerText.includes(keyword));
}

// Scrape Anime News Network
async function fetchANN() {
  try {
    const { data } = await axios.get('https://www.animenewsnetwork.com/news/', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
    });
    const $ = cheerio.load(data);
    const articles = [];
    
    $('.herald.box.news').each((i, el) => {
      if (i >= 50) return; // limit to 50
      const $el = $(el);
      const title = cleanHtml($el.find('h3 a').text().trim());
      const excerpt = cleanHtml($el.find('.preview').html() || $el.find('.preview').text().trim());
      const dateAttr = $el.find('.byline time').attr('datetime');
      const link = $el.find('h3 a').attr('href');
      
      if (title && link) {
        if (!isNSFW(title, excerpt)) {
          articles.push({
            id: `ann-${link.split('/').pop()}`,
            title: title,
            content: excerpt || title,
            sourceUrl: link.startsWith('http') ? link : `https://www.animenewsnetwork.com${link}`,
            author: 'ANN',
            publishedAt: dateAttr ? new Date(dateAttr) : new Date(),
            category: 'News',
            imageUrl: '' // to be populated
          });
        }
      }
    });

    // Fetch HD images in parallel
    await Promise.all(articles.map(async (article) => {
      try {
        const { data: articleData } = await axios.get(article.sourceUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
        });
        const _$ = cheerio.load(articleData);
        let img = _$('meta[property="og:image"]').attr('content') || 
                  _$('.article img:first-child').attr('src') || '';
        
        if (img.startsWith('//')) img = `https:${img}`;
        else if (img.startsWith('/')) img = `https://www.animenewsnetwork.com${img}`;
        
        article.imageUrl = img || 'https://placehold.co/600x400/1a1a2e/7c3aed/png?text=Anime+News';

        const fullContentRoot = _$('.meat, .text-content, .news-article').first();
        applyStructuredContent(
          article,
          fullContentRoot.html() || fullContentRoot.text() || ''
        );
      } catch (e) {
        article.imageUrl = 'https://placehold.co/600x400/1a1a2e/7c3aed/png?text=Anime+News';
      }
    }));
    return articles;
  } catch (error) {
    console.error('ANN error:', error.message);
    return [];
  }
}

// Scrape MyAnimeList RSS directly
async function fetchMAL() {
  try {
    const { data } = await axios.get('https://myanimelist.net/rss/news.xml', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
    });
    const $ = cheerio.load(data, { xmlMode: true });
    const articles = [];

    $('item').slice(0, 50).each((i, el) => {
      const title = cleanHtml($(el).find('title').text().trim());
      let description = $(el).find('description').text().trim();
      description = cleanHtml(description);
      const link = $(el).find('link').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      
      // MAL thumbnail comes from <media:thumbnail> namespace, cheerio handles wildcards or namespaced tags 
      let imageUrl = $(el).find('media\\:thumbnail').text().trim();
      if (!imageUrl || imageUrl === '') {
        imageUrl = $(el).find('thumbnail').text().trim();
      }

      const lowerText = (title + ' ' + description).toLowerCase();
      let matchedCategory = 'News';
      if (lowerText.includes('shonen') || lowerText.includes('jump')) matchedCategory = 'Shonen';
      else if (lowerText.includes('action') || lowerText.includes('fight')) matchedCategory = 'Action';
      else if (lowerText.includes('adventure') || lowerText.includes('quest')) matchedCategory = 'Adventure';
      else if (lowerText.includes('romance') || lowerText.includes('love')) matchedCategory = 'Romance';

      if (!isNSFW(title, description)) {
        articles.push({
          id: `mal-${Date.now()}-${i}`,
          title: title,
          content: description,
          sourceUrl: link,
          author: 'MyAnimeList',
          publishedAt: new Date(pubDate),
          category: matchedCategory,
          imageUrl: imageUrl || 'https://placehold.co/600x400/1a1a2e/7c3aed/png?text=Anime+News'
        });
      }
    });

    // Fetch full article text for MAL to replace the short RSS snippet
    await Promise.all(articles.map(async (article) => {
      try {
        const { data: articleData } = await axios.get(article.sourceUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
        });
        const _$ = cheerio.load(articleData);
        
        // MAL specific selectors for the main text content, ignoring script tags
        _$('script, style, iframe, .news-info-block').remove();
        const ogImage = _$('meta[property="og:image"]').attr('content') || '';
        if (ogImage) {
          article.imageUrl = ogImage;
        }
        const contentRoot = _$('.news-container .content').first();
        applyStructuredContent(
          article,
          contentRoot.html() || contentRoot.text() || '',
          extractMalContentBlocks
        );
      } catch (e) {
        // Fallback to initial snippet on failure
      }
    }));

    return articles;
  } catch (error) {
    console.error('MAL error:', error.message);
    return [];
  }
}

// Fetch ComicBook Anime News via RSS
async function fetchComicBook() {
  try {
    const { data } = await axios.get('https://comicbook.com/category/anime/feed/', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
    });
    const $ = cheerio.load(data, { xmlMode: true });
    const articles = [];

    $('item').slice(0, 50).each((i, el) => {
      const title = cleanHtml($(el).find('title').text().trim());
      const link = $(el).find('link').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();

      // Comicbook includes full content in content:encoded
      const fullContentHtml = $(el).find('content\\:encoded').text().trim();
      let contentText = '';
      let imageUrl = '';

      if (fullContentHtml) {
        const _$ = cheerio.load(fullContentHtml);
        imageUrl = getImageUrlFromNode(_$('img').first(), link) || '';
        const blocks = extractComicBookContentBlocks(fullContentHtml, link);
        const blockText = blocksToPlainText(blocks);
        contentText = blockText || cleanHtml(fullContentHtml);
      }

      if (!imageUrl) {
        // Fallback to media:content if available
        imageUrl = $(el).find('media\\:content').attr('url') || $(el).find('thumbnail').attr('url') || '';
      }

      if (!title || !link || !contentText) return;
      if (isNSFW(title, contentText)) return;

      articles.push({
        id: `cb-${link.split('/').filter(Boolean).pop() || i}`,
        title,
        content: contentText,
        ...(fullContentHtml ? { contentBlocks: extractComicBookContentBlocks(fullContentHtml, link) } : {}),
        sourceUrl: link,
        author: 'ComicBook',
        publishedAt: new Date(pubDate),
        category: 'News',
        imageUrl: imageUrl || 'https://placehold.co/600x400/1a1a2e/7c3aed/png?text=Anime+News'
      });
    });

    await Promise.all(articles.map(async article => {
      try {
        const { data: articleData } = await axios.get(article.sourceUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
        });
        const _$ = cheerio.load(articleData);
        const ogImage = _$('meta[property="og:image"]').attr('content') || '';
        if (ogImage) {
          article.imageUrl = ogImage;
        }

        const contentRoot = _$('.entry-content.wp-block-post-content, .entry-content, .wp-block-post-content').first();
        applyStructuredContent(
          article,
          contentRoot.html() || '',
          extractComicBookContentBlocks
        );
      } catch (e) {
        // Keep RSS-derived content when page fetch fails.
      }
    }));

    console.log(`ComicBook: ${articles.length} articles fetched`);
    return articles;
  } catch (error) {
    console.error('ComicBook error:', error.message);
    return [];
  }
}

// Scrape Anime Corner News
async function fetchAnimeCorner() {
  try {
    const { data } = await axios.get('https://animecorner.me/category/anime-news/', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
    });
    const $ = cheerio.load(data);
    const articles = [];

    $('article').each((i, el) => {
      if (i >= 30) return;
      const $el = $(el);

      const titleEl = $el.find('h2 a, h3 a').first();
      const title = cleanHtml(titleEl.text().trim());
      const link = titleEl.attr('href') || '';
      if (!title || !link) return;

      // Image: lazy-loaded in data-bgset attribute
      let imageUrl = $el.find('[data-bgset]').attr('data-bgset') ||
                     $el.find('[data-bg]').attr('data-bg') ||
                     $el.find('img').attr('src') || '';
      // data-bgset sometimes has multiple sizes like "url 768w, url2 1024w"
      if (imageUrl && imageUrl.includes(' ')) {
        imageUrl = imageUrl.split(',')[0].trim().split(' ')[0];
      }

      const excerpt = cleanHtml($el.find('.entry-summary p, .excerpt p, p').first().html() || $el.find('.entry-summary p, .excerpt p, p').first().text().trim());
      const dateText = $el.find('time').attr('datetime') || $el.find('.entry-date').text().trim();

      if (isNSFW(title, excerpt)) return;

      articles.push({
        id: `ac-${link.split('/').filter(Boolean).pop() || i}`,
        title,
        content: excerpt || title,
        sourceUrl: link,
        author: 'Anime Corner',
        publishedAt: dateText ? new Date(dateText) : new Date(),
        category: 'News',
        imageUrl: imageUrl || 'https://placehold.co/600x400/1a1a2e/7c3aed/png?text=Anime+News'
      });
    });

    // For articles with short content, fetch full article text
    await Promise.all(articles.map(async (article) => {
      try {
        const { data: articleData } = await axios.get(article.sourceUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000
        });
        const _$ = cheerio.load(articleData);
        // Get og:image if we're missing it
        if (!article.imageUrl || article.imageUrl.includes('placehold')) {
          const img = _$('meta[property="og:image"]').attr('content') || '';
          if (img) article.imageUrl = img;
        }
        // Get full content
        _$('script, style, .sharedaddy, .jp-relatedposts').remove();
        const contentRoot = _$('.entry-content, .post-content, article .content').first();
        applyStructuredContent(
          article,
          contentRoot.html() || contentRoot.text() || '',
          extractAnimeCornerContentBlocks
        );
      } catch(e) {}
    }));

    console.log(`Anime Corner: ${articles.length} articles fetched`);
    return articles;
  } catch (error) {
    console.error('Anime Corner error:', error.message);
    return [];
  }
}

(async () => {
  // Load existing news first to get the latest date
  const apiDir = path.join(__dirname, 'api');
  if (!fs.existsSync(apiDir)) fs.mkdirSync(apiDir);
  const outputPath = path.join(apiDir, 'news.json');

  let existingNews = [];
  if (fs.existsSync(outputPath)) {
    try {
      existingNews = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    } catch (e) {
      console.error('Could not parse existing news.json, starting fresh.');
    }
  }

  console.log(`Existing articles: ${existingNews.length}`);

  // Find the latest article date in existing news to use as a cutoff
  let latestDate = null;
  for (const article of existingNews) {
    const d = new Date(article.publishedAt);
    if (!isNaN(d.getTime())) {
      if (!latestDate || d > latestDate) latestDate = d;
    }
  }
  if (latestDate) {
    console.log(`Latest article in DB: ${latestDate.toISOString()}`);
  } else {
    console.log('No existing articles found, fetching all available news.');
  }

  console.log('Fetching ANN news...');
  const annNews = await fetchANN();

  console.log('Fetching MAL news...');
  const malNews = await fetchMAL();

  console.log('Fetching ComicBook news...');
  const cbNews = await fetchComicBook();

  console.log('Fetching Anime Corner news...');
  const acNews = await fetchAnimeCorner();

  // Combine and sort by date descending
  let newNews = [...annNews, ...malNews, ...cbNews, ...acNews];
  newNews.sort((a, b) => b.publishedAt - a.publishedAt);

  // Format dates to simple strings for Flutter
  newNews = newNews.map(a => {
    const dateObj = new Date(a.publishedAt);
    const options = { month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
    a.publishedAt = dateObj.toLocaleString('en-US', options).replace(',', ' -');
    return a;
  });

  // Filter: only keep articles whose sourceUrl is not already in DB
  const existingUrls = new Set(existingNews.map(a => a.sourceUrl));
  const uniqueNew = newNews.filter(a => !existingUrls.has(a.sourceUrl));

  console.log(`Found ${uniqueNew.length} brand new articles not in DB.`);

  if (uniqueNew.length === 0) {
    console.log('No new articles to add. DB is up to date!');
    return;
  }

  // Accumulate: new articles at the top
  let finalNews = [...uniqueNew, ...existingNews];

  // Limit to 10000 articles max
  finalNews = finalNews.slice(0, 10000);

  writePaginatedNewsArtifacts(apiDir, finalNews);
  console.log(`Wrote paginated news artifacts to ${apiDir}`);
  console.log(`âœ… Added ${uniqueNew.length} new articles. Total: ${finalNews.length}`);
})();


