'use strict';
(() => {
  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MAX_PHOTOS = 4;

  const icon = {
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  };

  // ── 기기에만 저장되는 값(서버로 보내지 않음) ──
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
  };
  const liked = new Set(store.get('mist:liked', []));
  const saveLiked = () => store.set('mist:liked', [...liked].slice(-3000));
  const viewed = new Set((() => { try { return JSON.parse(sessionStorage.getItem('mist:viewed') || '[]'); } catch { return []; } })());
  const saveViewed = () => { try { sessionStorage.setItem('mist:viewed', JSON.stringify([...viewed].slice(-500))); } catch { /* */ } };

  async function api(path, { method = 'GET', json, body } = {}) {
    const opt = { method, headers: {} };
    if (json !== undefined) { opt.body = JSON.stringify(json); opt.headers['Content-Type'] = 'application/json'; }
    else if (body) opt.body = body;
    let res;
    try { res = await fetch(`/api${path}`, opt); } catch { throw new Error('인터넷 연결을 확인해 주세요.'); }
    let data = null;
    try { data = await res.json(); } catch { /* */ }
    if (!res.ok) throw new Error(data?.error || '요청을 처리하지 못했어요.');
    return data;
  }

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  function ago(sec) {
    const d = Date.now() / 1000 - sec;
    if (d < 60) return '방금';
    if (d < 3600) return `${Math.floor(d / 60)}분 전`;
    if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
    if (d < 86400 * 7) return `${Math.floor(d / 86400)}일 전`;
    const t = new Date(sec * 1000);
    const y = t.getFullYear() === new Date().getFullYear() ? '' : `${t.getFullYear()}. `;
    return `${y}${t.getMonth() + 1}. ${t.getDate()}.`;
  }
  const num = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, '')}만` : String(n));

  const skeleton = () => '<div class="skeleton" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>';
  const empty = (title, sub = '') => `<div class="empty"><b>${esc(title)}</b>${esc(sub)}</div>`;

  function setTab(tab) {
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
    const on = document.querySelector('.tabs a.on');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  const tabFor = (slug) => (slug === 'free' || slug === 'notice' ? slug : 'user');

  // ── 라우터 ──
  let nav = 0;
  function route() {
    const [, a, b] = (location.hash.slice(1) || '/r/free').split('/');
    const my = ++nav;
    window.scrollTo(0, 0);
    if (a === 'r' && b) { setTab(tabFor(b)); renderBoard(decodeURIComponent(b), my); }
    else if (a === 'hot') { setTab('hot'); renderHot(my); }
    else if (a === 'user') { setTab('user'); renderRos(my); }
    else if (a === 'p' && Number(b)) { renderPost(Number(b), my); }
    else location.replace('#/r/free');
  }
  window.addEventListener('hashchange', route);

  // ── 목록 ──
  function postItem(p, showBoard) {
    return `<li><a class="item" href="#/p/${p.id}">
      <div class="item-body">
        ${showBoard ? `<span class="tag">${esc(p.board_name)}</span>` : ''}
        <h2 class="item-title">${esc(p.title)}</h2>
        ${p.excerpt ? `<p class="item-excerpt">${esc(p.excerpt)}</p>` : ''}
        <div class="meta">
          <span class="who">${esc(p.author)}</span><span>${ago(p.created_at)}</span>
          <span class="stat" title="조회">${icon.eye}${num(p.views)}</span>
          <span class="stat" title="좋아요">${icon.heart}${num(p.likes)}</span>
          <span class="stat" title="댓글">${icon.chat}${num(p.comment_count)}</span>
        </div>
      </div>
      ${p.thumb ? `<img class="thumb" src="${esc(p.thumb)}" alt="" loading="lazy">` : ''}
    </a></li>`;
  }

  function mountList(root, { posts, more }, loadMore, showBoard, emptyHtml) {
    const list = $('.list', root);
    const moreEl = $('.more', root);
    let items = [...posts];
    const draw = (batch) => list.insertAdjacentHTML('beforeend', batch.map((p) => postItem(p, showBoard)).join(''));
    if (!items.length) list.outerHTML = emptyHtml;
    else draw(items);
    const setMore = (has) => { moreEl.innerHTML = has ? '<button class="btn" type="button">더 보기</button>' : ''; };
    setMore(more);
    moreEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = '불러오는 중';
      try {
        const data = await loadMore(items);
        items = items.concat(data.posts);
        draw(data.posts);
        setMore(data.more);
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = '더 보기';
      }
    });
  }

  async function renderBoard(slug, my) {
    app.innerHTML = skeleton();
    let data;
    try { data = await api(`/boards/${encodeURIComponent(slug)}/posts`); }
    catch (err) { if (my === nav) app.innerHTML = empty(err.message); return; }
    if (my !== nav) return;
    const { board } = data;
    document.title = `${board.name} | MIST`;
    app.innerHTML = `
      <div class="page-head"><h1>${esc(board.name)}</h1></div>
      <div class="compose-wrap"></div>
      <ul class="list"></ul>
      <div class="more"></div>`;
    mountCompose($('.compose-wrap', app), board);
    mountList(app, data, (items) => api(`/boards/${encodeURIComponent(slug)}/posts?before=${items[items.length - 1].id}`), false,
      board.slug === 'notice' ? empty('아직 공지가 없어요.') : empty('아직 글이 없어요.', '첫 글을 남겨 보세요.'));
  }

  async function renderHot(my) {
    app.innerHTML = skeleton();
    let data;
    try { data = await api('/hot'); }
    catch (err) { if (my === nav) app.innerHTML = empty(err.message); return; }
    if (my !== nav) return;
    document.title = '인기로 | MIST';
    app.innerHTML = '<div class="page-head"><h1>인기로</h1></div><ul class="list"></ul><div class="more"></div>';
    mountList(app, data, (items) => api(`/hot?offset=${items.length}`), true, empty('아직 인기 글이 없어요.', '반응이 많은 글이 이곳에 올라와요.'));
  }

  // ── 글쓰기 ──
  function mountCompose(root, board) {
    root.innerHTML = '<button class="compose-open" type="button">글 작성하기</button>';
    $('.compose-open', root).addEventListener('click', () => openCompose(root, board));
  }

  function loadImg(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img')); };
      img.src = url;
    });
  }
  // 큰 사진은 기기에서 줄여서 올린다(업로드 속도↑). 서버에서도 메타데이터를 한 번 더 제거한다.
  async function prepareImage(file) {
    const big = file.size > 1.5 * 1024 * 1024;
    if (file.type === 'image/gif' || !big) return file;
    try {
      const img = await loadImg(file);
      const s = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
      return blob && blob.size < file.size ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
    } catch { return file; }
  }

  function openCompose(root, board) {
    const notice = board.slug === 'notice';
    root.innerHTML = `
      <form class="compose" novalidate>
        <input class="field title" name="title" placeholder="제목" maxlength="100" autocomplete="off" enterkeyhint="next">
        <textarea class="field" name="content" placeholder="글 작성하기" maxlength="5000"></textarea>
        <div class="photos">
          <label class="photo-add" title="사진 추가">${icon.image}<span>사진</span>
            <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden>
          </label>
        </div>
        <div class="row">
          <input class="field" name="author" placeholder="작성자명" maxlength="20" autocomplete="off">
          ${notice
            ? '<input class="field" name="adminPassword" type="password" placeholder="운영자 비밀번호" autocomplete="off">'
            : '<input class="field" name="password" type="password" placeholder="삭제 비밀번호 (4자 이상)" maxlength="64" autocomplete="new-password">'}
        </div>
        <div class="bar"><span class="grow"></span>
          <button class="btn ghost" type="button" data-cancel>취소</button>
          <button class="btn primary" type="submit">등록</button>
        </div>
      </form>`;
    const form = $('form', root);
    const f = form.elements;
    f.author.value = store.get('mist:name', '');
    f.title.focus();

    const photos = [];
    const photosEl = $('.photos', form);
    const addLabel = $('.photo-add', form);
    const fileInput = $('input[type=file]', form);
    const drawPhotos = () => {
      photosEl.querySelectorAll('.photo').forEach((el) => el.remove());
      photos.forEach((p, i) => {
        addLabel.insertAdjacentHTML('beforebegin', `<div class="photo"><img src="${p.url}" alt=""><button type="button" data-rm="${i}" aria-label="사진 빼기">${icon.x}</button></div>`);
      });
      addLabel.hidden = photos.length >= MAX_PHOTOS;
    };
    fileInput.addEventListener('change', async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      if (photos.length + files.length > MAX_PHOTOS) toast(`사진은 ${MAX_PHOTOS}장까지 올릴 수 있어요.`);
      for (const file of files.slice(0, MAX_PHOTOS - photos.length)) {
        if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) { toast('JPG, PNG, GIF, WEBP만 올릴 수 있어요.'); continue; }
        const ready = await prepareImage(file);
        if (ready.size > 8 * 1024 * 1024) { toast('사진은 한 장에 8MB까지 올릴 수 있어요.'); continue; }
        photos.push({ file: ready, url: URL.createObjectURL(ready) });
      }
      drawPhotos();
    });
    photosEl.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rm]');
      if (!rm) return;
      const [p] = photos.splice(Number(rm.dataset.rm), 1);
      URL.revokeObjectURL(p.url);
      drawPhotos();
    });
    const close = () => { photos.forEach((p) => URL.revokeObjectURL(p.url)); mountCompose(root, board); };
    $('[data-cancel]', form).addEventListener('click', () => {
      const dirty = f.title.value.trim() || f.content.value.trim() || photos.length;
      if (!dirty || confirm('작성 중인 글을 지울까요?')) close();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = f.title.value.trim();
      const content = f.content.value.trim();
      if (!title) { f.title.focus(); return toast('제목을 입력해 주세요.'); }
      if (!content) { f.content.focus(); return toast('내용을 입력해 주세요.'); }
      if (notice && !f.adminPassword.value) { f.adminPassword.focus(); return toast('운영자 비밀번호를 입력해 주세요.'); }
      if (!notice && f.password.value.length < 4) { f.password.focus(); return toast('삭제 비밀번호를 4자 이상 입력해 주세요.'); }
      const fd = new FormData();
      fd.append('title', title);
      fd.append('content', content);
      fd.append('author', f.author.value.trim());
      if (notice) fd.append('adminPassword', f.adminPassword.value);
      else fd.append('password', f.password.value);
      photos.forEach((p) => fd.append('images', p.file, p.file.name || 'photo'));
      const btn = $('button[type=submit]', form);
      btn.disabled = true;
      btn.textContent = photos.length ? '올리는 중' : '등록 중';
      try {
        const r = await api(`/boards/${encodeURIComponent(board.slug)}/posts`, { method: 'POST', body: fd });
        store.set('mist:name', f.author.value.trim());
        photos.forEach((p) => URL.revokeObjectURL(p.url));
        toast('등록했어요');
        location.hash = `#/p/${r.id}`;
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = '등록';
      }
    });
  }

  // ── 비밀번호 확인 후 삭제 ──
  function askDelete(anchor, label, onConfirm) {
    const existing = anchor.nextElementSibling;
    if (existing?.classList.contains('confirm')) { existing.remove(); return; }
    anchor.insertAdjacentHTML('afterend', `
      <form class="confirm" novalidate>
        <input class="field" type="password" placeholder="${esc(label)}" autocomplete="off">
        <button class="btn danger" type="submit">삭제</button>
        <button class="btn ghost" type="button">취소</button>
      </form>`);
    const form = anchor.nextElementSibling;
    const input = $('input', form);
    input.focus();
    $('.btn.ghost', form).addEventListener('click', () => form.remove());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value) return input.focus();
      const btn = $('.btn.danger', form);
      btn.disabled = true;
      try { await onConfirm(input.value); }
      catch (err) { toast(err.message); btn.disabled = false; input.select(); }
    });
  }

  // ── 글 보기 ──
  async function renderPost(id, my) {
    app.innerHTML = skeleton();
    const count = !viewed.has(id);
    let data;
    try { data = await api(`/posts/${id}${count ? '?view=1' : ''}`); }
    catch (err) { if (my === nav) app.innerHTML = empty(err.message); return; }
    if (my !== nav) return;
    if (count) { viewed.add(id); saveViewed(); }
    const { post: p, comments } = data;
    setTab(tabFor(p.board_slug));
    document.title = `${p.title} | MIST`;
    const isNotice = p.board_slug === 'notice';
    app.innerHTML = `
      <a class="back" href="#/r/${esc(p.board_slug)}">${icon.back}${esc(p.board_name)}</a>
      <article class="post">
        <h1 class="post-title">${esc(p.title)}</h1>
        <div class="meta">
          <span class="who">${esc(p.author)}</span><span>${ago(p.created_at)}</span>
          <span class="stat" title="조회">${icon.eye}${num(p.views)}</span>
        </div>
        <div class="post-content">${esc(p.content)}</div>
        ${p.images.length ? `<div class="post-images">${p.images.map((src) => `<a href="${esc(src)}" target="_blank" rel="noopener noreferrer"><img src="${esc(src)}" alt="" loading="lazy"></a>`).join('')}</div>` : ''}
        <div class="post-actions">
          <button class="like${liked.has(p.id) ? ' on' : ''}" type="button" aria-pressed="${liked.has(p.id)}" aria-label="좋아요">${icon.heart}<span>${num(p.likes)}</span></button>
          <span class="stat" title="댓글">${icon.chat}<span data-ccount>${num(p.comment_count)}</span></span>
          <button class="text-btn" type="button" data-del>삭제</button>
        </div>
      </article>
      <section class="comments">
        <h2>댓글<span data-ccount>${num(p.comment_count)}</span></h2>
        <ul class="clist">${comments.map(commentItem).join('')}</ul>
        <form class="cform" novalidate>
          <textarea class="field" name="content" placeholder="댓글 쓰기" maxlength="1000"></textarea>
          <div class="row">
            <input class="field" name="author" placeholder="작성자명" maxlength="20" autocomplete="off">
            <input class="field" name="password" type="password" placeholder="삭제 비밀번호" maxlength="64" autocomplete="new-password">
            <button class="btn primary" type="submit">등록</button>
          </div>
        </form>
      </section>`;

    let commentCount = p.comment_count;
    const setCount = (n) => { commentCount = n; app.querySelectorAll('[data-ccount]').forEach((el) => { el.textContent = num(n); }); };

    // 좋아요
    const likeBtn = $('.like', app);
    likeBtn.addEventListener('click', async () => {
      const on = !liked.has(p.id);
      likeBtn.disabled = true;
      try {
        const r = await api(`/posts/${p.id}/like`, { method: 'POST', json: { liked: on } });
        on ? liked.add(p.id) : liked.delete(p.id);
        saveLiked();
        likeBtn.classList.toggle('on', on);
        likeBtn.setAttribute('aria-pressed', String(on));
        $('span', likeBtn).textContent = num(r.likes);
        if (on) { likeBtn.classList.add('pop'); setTimeout(() => likeBtn.classList.remove('pop'), 200); }
      } catch (err) { toast(err.message); }
      finally { likeBtn.disabled = false; }
    });

    // 글 삭제
    const actions = $('.post-actions', app);
    $('[data-del]', app).addEventListener('click', () => {
      askDelete(actions, isNotice ? '운영자 비밀번호' : '삭제 비밀번호', async (pw) => {
        await api(`/posts/${p.id}`, { method: 'DELETE', json: { password: pw } });
        toast('삭제했어요');
        location.hash = `#/r/${p.board_slug}`;
      });
    });

    // 댓글
    const clist = $('.clist', app);
    clist.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cdel]');
      if (!btn) return;
      const li = btn.closest('.comment');
      askDelete($('.meta', li), '삭제 비밀번호', async (pw) => {
        await api(`/comments/${li.dataset.id}`, { method: 'DELETE', json: { password: pw } });
        li.remove();
        setCount(Math.max(0, commentCount - 1));
        toast('삭제했어요');
      });
    });
    const cform = $('.cform', app);
    const cf = cform.elements;
    cf.author.value = store.get('mist:name', '');
    cform.addEventListener('submit', async (e) => {
      e.preventDefault();
      const content = cf.content.value.trim();
      if (!content) { cf.content.focus(); return toast('댓글을 입력해 주세요.'); }
      if (cf.password.value.length < 4) { cf.password.focus(); return toast('삭제 비밀번호를 4자 이상 입력해 주세요.'); }
      const btn = $('button[type=submit]', cform);
      btn.disabled = true;
      try {
        const r = await api(`/posts/${p.id}/comments`, { method: 'POST', json: { content, author: cf.author.value.trim(), password: cf.password.value } });
        clist.insertAdjacentHTML('beforeend', commentItem(r.comment));
        setCount(commentCount + 1);
        store.set('mist:name', cf.author.value.trim());
        cf.content.value = '';
        toast('등록했어요');
      } catch (err) { toast(err.message); }
      finally { btn.disabled = false; }
    });
  }

  function commentItem(c) {
    return `<li class="comment" data-id="${c.id}">
      <div class="meta"><span class="who">${esc(c.author)}</span><span>${ago(c.created_at)}</span><button class="text-btn" type="button" data-cdel>삭제</button></div>
      <p>${esc(c.content)}</p>
    </li>`;
  }

  // ── 유저로 ──
  async function renderRos(my) {
    app.innerHTML = skeleton();
    let data;
    try { data = await api('/boards'); }
    catch (err) { if (my === nav) app.innerHTML = empty(err.message); return; }
    if (my !== nav) return;
    document.title = '유저로 | MIST';
    const ros = data.boards.filter((b) => !b.system);
    app.innerHTML = `
      <div class="page-head"><h1>유저로</h1><span class="count">${ros.length}</span></div>
      <form class="ro-new" novalidate>
        <input class="field" name="name" placeholder="새 로 이름" maxlength="20" autocomplete="off" enterkeyhint="done">
        <button class="btn primary" type="submit">만들기</button>
      </form>
      ${ros.length ? `<ul class="ro-list">${ros.map((b) => `
        <li><a class="ro" href="#/r/${esc(b.slug)}">
          <span class="ro-name">${esc(b.name)}</span>
          <span class="ro-meta"><span>글 ${num(b.post_count)}</span><span>${ago(b.last_post_at || b.created_at)}</span></span>
        </a></li>`).join('')}</ul>` : empty('아직 만들어진 로가 없어요.', '첫 로를 만들어 보세요.')}`;
    const form = $('.ro-new', app);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      if (name.length < 2) { form.elements.name.focus(); return toast('로 이름은 2자 이상이어야 해요.'); }
      const btn = $('button', form);
      btn.disabled = true;
      try {
        const r = await api('/boards', { method: 'POST', json: { name } });
        toast('로를 만들었어요');
        location.hash = `#/r/${r.board.slug}`;
      } catch (err) { toast(err.message); btn.disabled = false; }
    });
  }

  route();
})();
