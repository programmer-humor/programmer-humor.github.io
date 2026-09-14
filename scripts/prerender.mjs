#!/usr/bin/env node
/**
 * 빌드 타임 프리렌더 — API → 정적 HTML (dist/)
 *
 *   node scripts/prerender.mjs           # 실제 API
 *   node scripts/prerender.mjs --local   # humor_data.json (개발용)
 *
 * 산출물
 *   dist/                       ← 목록 1페이지 (index.html)
 *   dist/page/N/                ← 목록 페이지네이션
 *   dist/tag/{slug}/            ← 태그 허브 (데이터에 tags 필드가 있을 때만)
 *   dist/humor/{id}/            ← 상세 (제목이 MIN_TITLE_LEN 이상인 항목만)
 *   dist/sitemap.xml            ← 5만 URL 초과 시 sitemap-N.xml + 인덱스로 자동 분할
 *   dist/robots.txt, 404.html, 정적 파일 복사
 *
 * index.html 이 레이아웃 템플릿이다. 아래 마커를 치환한다.
 *   <!-- prerender:head -->        head 추가분 (JSON-LD, prev/next)
 *   <!-- prerender:before-feed --> 피드 위 (태그 목록, 페이지 제목)
 *   <!-- prerender:feed -->        피드 본문
 *   <!-- prerender:after-feed -->  피드 아래 (페이지네이션, 상세 이전/다음)
 */
import { mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const SITE = {
    origin: 'https://programmer-humor.github.io',
    name: 'Programmer Humor Feed',
    title: '개발자 유머 · 프로그래머 밈 모음 | Programmer Humor Feed',
    description: '개발자를 위한 유머 피드. 코딩과 관련된 재미있는 밈과 짤방을 모았습니다.',
    ogImage: 'https://programmer-humor.github.io/static/cover.jpg',
};

const API_BASE = 'https://real-brave-people.p-e.kr/front/v1/humors?orderType=RECENTLY&langType=ENG,KO';
const FETCH_SIZE = 50;
const PAGE_SIZE = 12;        // 목록 페이지당 항목 수. app.js 의 pageSize 와 같아야 한다
const MIN_TITLE_LEN = 5;     // 이 미만이면 상세 URL 미발행 (thin content 방지). app.js 와 동일
const SITEMAP_MAX = 50000;   // sitemaps.org 파일당 상한

// 그대로 dist/ 로 복사할 파일·폴더
const STATIC_COPY = ['main.css', 'app.js', 'ads.txt', 'googlee4e66f52d37b17c7.html', '404.html', 'static', 'humor_data.json' /* ?source=local 개발용 */];

const useLocal = process.argv.includes('--local');

// ── 데이터 ──────────────────────────────────────────────────────────────

async function fetchJson(url, retries = 3) {
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            if (attempt >= retries) throw err;
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
}

async function fetchAll() {
    if (useLocal) {
        return JSON.parse(await readFile(path.join(ROOT, 'humor_data.json'), 'utf8'));
    }
    const items = [];
    for (let page = 0; ; page++) {
        const batch = await fetchJson(`${API_BASE}&page=${page}&size=${FETCH_SIZE}`);
        if (!Array.isArray(batch) || batch.length === 0) break;
        items.push(...batch);
        if (batch.length < FETCH_SIZE) break;
    }
    return items;
}

function normalize(raw) {
    const title = String(raw.title ?? '').trim();
    const content = String(raw.content ?? '').trim();
    const images = (raw.image_list ?? [])
        .slice()
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        .map(i => i.image_url)
        .filter(Boolean);
    const tags = Array.isArray(raw.tags) ? raw.tags.map(t => String(t).trim()).filter(Boolean) : [];
    return {
        id: raw.humor_id,
        title, content, images, tags,
        indexable: title.length >= MIN_TITLE_LEN && images.length > 0,
    };
}

// ── HTML 조각 ───────────────────────────────────────────────────────────

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const jsonLd = obj => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const slugify = tag => tag.toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '');
const detailPath = item => `/humor/${item.id}/`;
const tagPath = tag => `/tag/${slugify(tag)}/`;

function articleHTML(item, { eager = false, lcp = false, heading = 'h2', link = true, detail = false } = {}) {
    const alt = item.title || '개발자 유머 이미지';
    const slides = item.images.map((src, i) => {
        const suffix = item.images.length > 1 ? ` (${i + 1}/${item.images.length})` : '';
        const first = eager && i === 0;
        return `
                <div class="swiper-slide">
                    <img src="${esc(src)}" alt="${esc(alt + suffix)}" loading="${first ? 'eager' : 'lazy'}"${first && lcp ? ' fetchpriority="high"' : ''} decoding="async" onclick="openModal(this.src)">
                </div>`;
    }).join('');

    let title = '';
    if (item.title) {
        const inner = link && item.indexable ? `<a href="${detailPath(item)}">${esc(item.title)}</a>` : esc(item.title);
        title = `\n            <${heading}>${inner}</${heading}>`;
    }
    const body = item.content ? `\n            <p>${esc(item.content)}</p>` : '';
    const tags = item.tags.length
        ? `\n            <div class="tag-list">${item.tags.map(t => `<a href="${tagPath(t)}" rel="tag">#${esc(t)}</a>`).join('')}</div>`
        : '';

    return `
        <article class="feed-item${detail ? ' feed-item--detail' : ''}" data-humor-id="${item.id}">${title}${body}
            <div class="swiper">
                <div class="swiper-wrapper">${slides}
                </div>
                <div class="swiper-pagination"></div>
                <div class="swiper-button-next"></div>
                <div class="swiper-button-prev"></div>
            </div>${tags}
        </article>`;
}

function paginationHTML(current, total, pathOf) {
    if (total <= 1) return '';
    // 1 … c-2 c-1 [c] c+1 c+2 … N  — 수천 페이지가 되어도 링크 수가 폭발하지 않게
    const pages = new Set([1, total]);
    for (let p = current - 2; p <= current + 2; p++) if (p >= 1 && p <= total) pages.add(p);
    const sorted = [...pages].sort((a, b) => a - b);

    const parts = [];
    if (current > 1) parts.push(`<a href="${pathOf(current - 1)}" rel="prev">‹ 이전</a>`);
    let last = 0;
    for (const p of sorted) {
        if (p - last > 1) parts.push('<span class="gap">…</span>');
        parts.push(p === current
            ? `<span class="current" aria-current="page">${p}</span>`
            : `<a href="${pathOf(p)}">${p}</a>`);
        last = p;
    }
    if (current < total) parts.push(`<a href="${pathOf(current + 1)}" rel="next">다음 ›</a>`);
    return `\n        <nav class="pagination" aria-label="페이지">${parts.join('')}</nav>`;
}

// ── 템플릿 치환 ─────────────────────────────────────────────────────────

function setTag(html, pattern, replacement) {
    if (!pattern.test(html)) throw new Error(`index.html 템플릿에서 찾을 수 없음: ${pattern}`);
    return html.replace(pattern, replacement);
}

function renderPage(tpl, p) {
    let html = tpl;
    html = setTag(html, /<title>[^<]*<\/title>/, `<title>${esc(p.title)}</title>`);
    html = setTag(html, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${SITE.origin}${p.path}">`);
    html = setTag(html, /<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(p.description)}">`);
    html = setTag(html, /<meta property="og:type" content="[^"]*">/, `<meta property="og:type" content="${p.ogType ?? 'website'}">`);
    html = setTag(html, /<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(p.ogTitle ?? p.title)}">`);
    html = setTag(html, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(p.description)}">`);
    html = setTag(html, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${SITE.origin}${p.path}">`);
    html = setTag(html, /<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${esc(p.ogImage ?? SITE.ogImage)}">`);

    if (p.siteTitleAsH1) {
        html = setTag(html, /<p class="site-title">([\s\S]*?)<\/p>/, '<h1 class="site-title">$1</h1>');
    }

    // 피드 컨테이너에 런타임 설정을 data-* 로 심는다. app.js 가 읽는다.
    const attrs = [`data-api="${esc(API_BASE)}"`, `data-page-size="${PAGE_SIZE}"`];
    if (p.nextPage != null) attrs.push(`data-next-page="${p.nextPage}"`);
    else attrs.push('data-static="1"');
    html = setTag(html, /<div id="feed-container">/, `<div id="feed-container" ${attrs.join(' ')}>`);

    html = setTag(html, /<!-- prerender:head -->/, p.headExtra ?? '');
    html = setTag(html, /<!-- prerender:before-feed -->/, p.beforeFeed ?? '');
    html = setTag(html, /<!-- prerender:feed -->/, p.feed ?? '');
    html = setTag(html, /<!-- prerender:after-feed -->/, p.afterFeed ?? '');
    return html;
}

async function emit(pathname, html) {
    const dir = path.join(DIST, pathname);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), html);
}

// ── 페이지 생성 ─────────────────────────────────────────────────────────

/** 목록 시리즈: basePath '' → /, /page/2/ …  basePath '/tag/x' → /tag/x/, /tag/x/page/2/ … */
async function renderListSeries(tpl, items, { basePath, title, description, beforeFeed = '', continueFromApi }) {
    const chunks = [];
    for (let i = 0; i < items.length; i += PAGE_SIZE) chunks.push(items.slice(i, i + PAGE_SIZE));
    if (chunks.length === 0) chunks.push([]);

    const pathOf = n => n === 1 ? `${basePath}/` : `${basePath}/page/${n}/`;
    const paths = [];

    for (let idx = 0; idx < chunks.length; idx++) {
        const n = idx + 1;
        const pathname = pathOf(n);
        const isFirst = n === 1;
        const pageTitle = isFirst ? title : `${title} - ${n}페이지`;

        // 상세 URL 이 있는 항목만 ItemList 에 올린다 — 비어 있으면 스키마 자체를 생략
        const listItems = chunks[idx].filter(it => it.indexable).map((it, i) => ({
            '@type': 'ListItem', position: idx * PAGE_SIZE + i + 1,
            url: `${SITE.origin}${detailPath(it)}`, name: it.title,
        }));
        const headExtra = [
            n > 1 ? `<link rel="prev" href="${SITE.origin}${pathOf(n - 1)}">` : '',
            n < chunks.length ? `<link rel="next" href="${SITE.origin}${pathOf(n + 1)}">` : '',
            isFirst && basePath === '' ? jsonLd({
                '@context': 'https://schema.org', '@type': 'WebSite',
                name: SITE.name, url: `${SITE.origin}/`, description: SITE.description, inLanguage: 'ko',
            }) : '',
            listItems.length ? jsonLd({
                '@context': 'https://schema.org', '@type': 'ItemList',
                itemListElement: listItems,
            }) : '',
        ].filter(Boolean).join('\n    ');

        await emit(pathname, renderPage(tpl, {
            path: pathname,
            title: pageTitle,
            ogTitle: pageTitle.replace(/ \| .*$/, ''),
            description,
            siteTitleAsH1: true,
            // 무한 스크롤은 이 페이지에 박힌 분량 다음 API 페이지부터 이어간다 (API 페이지 = 목록 페이지 - 1)
            nextPage: continueFromApi ? n : null,
            headExtra, beforeFeed,
            feed: chunks[idx].map((it, i) => articleHTML(it, { eager: i < 2, lcp: i === 0 })).join(''),
            afterFeed: paginationHTML(n, chunks.length, pathOf),
        }));
        paths.push(pathname);
    }
    return paths;
}

async function renderDetails(tpl, indexable) {
    const paths = [];
    for (let i = 0; i < indexable.length; i++) {
        const it = indexable[i];
        const newer = indexable[i - 1];   // 최신순 정렬이므로 앞이 더 새 항목
        const older = indexable[i + 1];
        const pathname = detailPath(it);
        const url = `${SITE.origin}${pathname}`;
        const description = it.content || `${it.title} — 개발자 유머 · 프로그래머 밈`;

        const nav = (newer || older) ? `
        <nav class="detail-nav" aria-label="이전/다음 유머">
            ${newer ? `<a href="${detailPath(newer)}" rel="prev">‹ ${esc(newer.title)}</a>` : '<span></span>'}
            ${older ? `<a href="${detailPath(older)}" rel="next">${esc(older.title)} ›</a>` : '<span></span>'}
        </nav>` : '';

        await emit(pathname, renderPage(tpl, {
            path: pathname,
            title: `${it.title} - 개발자 유머 | ${SITE.name}`,
            ogTitle: it.title,
            ogType: 'article',
            ogImage: it.images[0],
            description,
            nextPage: null,
            headExtra: jsonLd([
                {
                    '@context': 'https://schema.org', '@type': 'ImageObject',
                    contentUrl: it.images[0], url, name: it.title, caption: it.title,
                    description, inLanguage: 'ko',
                    isPartOf: { '@type': 'WebSite', name: SITE.name, url: `${SITE.origin}/` },
                },
                {
                    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
                    itemListElement: [
                        { '@type': 'ListItem', position: 1, name: '홈', item: `${SITE.origin}/` },
                        { '@type': 'ListItem', position: 2, name: it.title, item: url },
                    ],
                },
            ]),
            feed: articleHTML(it, { eager: true, lcp: true, heading: 'h1', link: false, detail: true }),
            afterFeed: `${nav}
        <p class="back-home"><a href="/">전체 피드로 ›</a></p>`,
        }));
        paths.push(pathname);
    }
    return paths;
}

async function writeSitemaps(paths) {
    const urls = paths.map(p => `${SITE.origin}${p}`);
    const urlset = list => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${list.map(u => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}
</urlset>
`;
    if (urls.length <= SITEMAP_MAX) {
        await writeFile(path.join(DIST, 'sitemap.xml'), urlset(urls));
        return 1;
    }
    const files = [];
    for (let i = 0; i < urls.length; i += SITEMAP_MAX) {
        const name = `sitemap-${files.length + 1}.xml`;
        await writeFile(path.join(DIST, name), urlset(urls.slice(i, i + SITEMAP_MAX)));
        files.push(name);
    }
    await writeFile(path.join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${files.map(f => `  <sitemap><loc>${SITE.origin}/${f}</loc></sitemap>`).join('\n')}
</sitemapindex>
`);
    return files.length;
}

// ── main ────────────────────────────────────────────────────────────────

const t0 = Date.now();
const tpl = await readFile(path.join(ROOT, 'index.html'), 'utf8');
const items = (await fetchAll()).map(normalize).filter(it => it.id != null && it.images.length > 0);
const indexable = items.filter(it => it.indexable);

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const allPaths = [];

// 태그 허브 — 데이터에 tags 가 들어오면 자동으로 켜진다
const tagMap = new Map();
for (const it of items) for (const t of it.tags) tagMap.set(t, [...(tagMap.get(t) ?? []), it]);
const tagIndexHTML = tagMap.size
    ? `\n        <div class="tag-list">${[...tagMap.keys()].sort().map(t => `<a href="${tagPath(t)}" rel="tag">#${esc(t)}</a>`).join('')}</div>`
    : '';

allPaths.push(...await renderListSeries(tpl, items, {
    basePath: '', title: SITE.title, description: SITE.description,
    beforeFeed: tagIndexHTML, continueFromApi: true,
}));

for (const [tag, tagItems] of tagMap) {
    allPaths.push(...await renderListSeries(tpl, tagItems, {
        basePath: tagPath(tag).replace(/\/$/, ''),
        title: `${tag} 개발자 유머 · 프로그래머 밈 | ${SITE.name}`,
        description: `${tag} 관련 개발자 유머와 밈 ${tagItems.length}개를 모았습니다.`,
        continueFromApi: false,   // API 에 태그 필터가 없으므로 정적으로만
    }));
}

allPaths.push(...await renderDetails(tpl, indexable));

const sitemapFiles = await writeSitemaps(allPaths);
await writeFile(path.join(DIST, 'robots.txt'), `User-agent: *
Allow: /

Sitemap: ${SITE.origin}/sitemap.xml
`);
await writeFile(path.join(DIST, '.nojekyll'), '');

for (const name of STATIC_COPY) {
    const src = path.join(ROOT, name);
    if (existsSync(src)) await cp(src, path.join(DIST, name), { recursive: true });
}

console.log(`prerender 완료 (${Date.now() - t0}ms, ${useLocal ? 'humor_data.json' : 'API'})
  전체 항목      ${items.length}
  상세 URL 발행  ${indexable.length}  (제목 ${MIN_TITLE_LEN}자 미만 ${items.length - indexable.length}건 제외)
  목록 페이지    ${Math.ceil(items.length / PAGE_SIZE)}
  태그 허브      ${tagMap.size}
  사이트맵 URL   ${allPaths.length} (${sitemapFiles}개 파일)
  → ${path.relative(process.cwd(), DIST)}/`);
