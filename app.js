/**
 * 피드 런타임 — 프리렌더된 HTML 위에 무한 스크롤을 얹는 점진적 향상 레이어.
 *
 * #feed-container 의 data-* 를 읽는다 (scripts/prerender.mjs 가 심는다).
 *   data-api        API 엔드포인트 (orderType/langType 포함)
 *   data-page-size  페이지당 항목 수
 *   data-next-page  이어서 불러올 API 페이지 번호. 없고 data-static="1" 이면 무한 스크롤 없음 (상세·태그)
 *
 * 마커 없이 index.html 을 그대로 열면 (로컬 개발) 0페이지부터 전부 클라이언트에서 불러온다.
 * ?source=local 을 붙이면 humor_data.json 을 읽는다.
 */
(function () {
    const container = document.getElementById('feed-container');
    if (!container) return;

    const params = new URLSearchParams(location.search);
    const API = container.dataset.api
        || 'https://real-brave-people.p-e.kr/front/v1/humors?orderType=RECENTLY&langType=ENG,KO';
    const useLocal = params.get('source') === 'local';
    const pageSize = Number(container.dataset.pageSize) || 12;
    const isStatic = container.dataset.static === '1';
    const MIN_TITLE_LEN = 5;   // prerender.mjs 와 동일 — 이 미만은 상세 URL 이 없으므로 링크 안 검

    let nextPage = Number(container.dataset.nextPage ?? 0);
    let isLoading = false;
    let hasMore = !isStatic;
    let localCache = null;
    // 빌드와 런타임 사이에 새 항목이 끼어들면 페이지 경계가 밀린다 → id 로 중복 제거
    const seen = new Set([...container.querySelectorAll('[data-humor-id]')].map(el => el.dataset.humorId));

    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    async function fetchPage(page, size) {
        if (useLocal) {
            if (!localCache) localCache = await (await fetch('/humor_data.json')).json();
            return localCache.slice(page * size, (page + 1) * size);
        }
        const res = await fetch(`${API}&page=${page}&size=${size}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    // prerender.mjs 의 articleHTML 과 같은 구조를 유지할 것
    function articleHTML(item) {
        const title = String(item.title ?? '').trim();
        const content = String(item.content ?? '').trim();
        const images = (item.image_list ?? []).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        const alt = title || '개발자 유머 이미지';
        const linkable = title.length >= MIN_TITLE_LEN && images.length > 0;

        const slides = images.map((img, i) => {
            const suffix = images.length > 1 ? ` (${i + 1}/${images.length})` : '';
            return `<div class="swiper-slide">
                <img src="${esc(img.image_url)}" alt="${esc(alt + suffix)}" loading="lazy" decoding="async" onclick="openModal(this.src)">
            </div>`;
        }).join('');

        const heading = title
            ? `<h2>${linkable ? `<a href="/humor/${item.humor_id}/">${esc(title)}</a>` : esc(title)}</h2>`
            : '';
        const body = content ? `<p>${esc(content)}</p>` : '';

        return `<article class="feed-item" data-humor-id="${item.humor_id}">
            ${heading}${body}
            <div class="swiper">
                <div class="swiper-wrapper">${slides}</div>
                <div class="swiper-pagination"></div>
                <div class="swiper-button-next"></div>
                <div class="swiper-button-prev"></div>
            </div>
        </article>`;
    }

    function initSwipers(root) {
        if (typeof Swiper === 'undefined') return;
        root.querySelectorAll('.feed-item .swiper:not(.swiper-initialized)').forEach(el => {
            new Swiper(el, {
                pagination: { el: el.querySelector('.swiper-pagination') },
                navigation: {
                    nextEl: el.querySelector('.swiper-button-next'),
                    prevEl: el.querySelector('.swiper-button-prev'),
                },
            });
        });
    }

    const indicator = document.getElementById('loading-indicator');
    const showLoading = on => { if (indicator) indicator.style.display = on ? 'block' : 'none'; };

    async function loadMore() {
        if (isLoading || !hasMore) return;
        isLoading = true;
        showLoading(true);
        try {
            const data = await fetchPage(nextPage, pageSize);
            const fresh = (data || []).filter(it => it && !seen.has(String(it.humor_id)));
            fresh.forEach(it => seen.add(String(it.humor_id)));

            if (fresh.length) {
                const frag = document.createElement('template');
                frag.innerHTML = fresh.map(articleHTML).join('');
                const added = [...frag.content.children];
                container.append(frag.content);
                added.forEach(initSwipers);
            }
            hasMore = (data || []).length === pageSize;
            nextPage++;
        } catch (err) {
            console.error('피드 로드 실패:', err);
            hasMore = false;
        } finally {
            if (!hasMore && !container.querySelector('.end-message')) {
                container.insertAdjacentHTML('beforeend', '<div class="end-message">😀 모든 유머를 읽었습니다.</div>');
            }
            isLoading = false;
            showLoading(false);
        }
    }

    // ── 모달 (inline onclick 에서 부르므로 전역) ──
    const modal = document.getElementById('imageModal');
    const modalImg = document.getElementById('modalImage');
    window.openModal = function (src) {
        if (!modal || !modalImg) return;
        modalImg.src = src;
        modal.style.display = 'block';
    };
    const closeModal = () => { if (modal) modal.style.display = 'none'; };

    document.addEventListener('DOMContentLoaded', () => {
        initSwipers(document);

        if (modal) {
            const closeBtn = modal.querySelector('.modal-close');
            if (closeBtn) closeBtn.onclick = closeModal;
            modal.onclick = e => { if (e.target === modal) closeModal(); };
            document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
        }

        // 프리렌더된 항목이 하나도 없으면 (템플릿을 그대로 연 경우) 즉시 첫 페이지를 불러온다
        if (!isStatic && seen.size === 0) loadMore();
    });

    if (!isStatic) {
        // loadMore 가 isLoading 으로 재진입을 막으므로 별도 스로틀 불필요 (rAF 는 백그라운드 탭에서 멈춤)
        window.addEventListener('scroll', () => {
            if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) loadMore();
        }, { passive: true });
    }
})();
