<script>
(function(){

  // Сообщение об ошибке конфигурации (если нет ключей Supabase)
  function showConfigError(message){
    const msg = message || 'Не удалось инициализировать тренажёр: отсутствуют параметры подключения.';
    const render = () => {
      const container = document.createElement('div');
      container.setAttribute('role', 'alert');
      container.style.background = '#fff3cd';
      container.style.color = '#856404';
      container.style.padding = '16px';
      container.style.margin = '16px';
      container.style.border = '1px solid #ffeeba';
      container.style.borderRadius = '8px';
      container.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      container.innerHTML =
        `<strong>Требуется конфигурация.</strong><br>${msg}<br>` +
        'Перед загрузкой скрипта задайте <code>window.PDD_CONFIG</code> с ключами <code>SUPA</code> и <code>ANON</code>.';
      const target = document.body || document.documentElement;
      if (target) {
        if (typeof target.prepend === 'function') {
          target.prepend(container);
        } else {
          target.insertBefore(container, target.firstChild || null);
        }
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', render, { once: true });
    } else {
      render();
    }
    console.error(`PDD Trainer: ${msg}`);
  }

  // === Конфиг из Webflow (ключи Supabase) ===
  const CONFIG = window.PDD_CONFIG || null;
  const SUPA = CONFIG && CONFIG.SUPA;
  const ANON = CONFIG && CONFIG.ANON;
  if (!SUPA || !ANON) {
    showConfigError('Проверьте, что параметры <code>SUPA</code> и <code>ANON</code> переданы в глобальный объект конфигурации.');
    return;
  }

  // ---------- Хэш билета ----------
  // ожидаем формат #t<topic>-<ticket>
  // поддерживаем старые: #t-2 => topic=1,ticket=2; #2 => topic=1,ticket=2
  function parseHash() {
    const h = (window.location.hash || '').slice(1).trim();
    let m = h.match(/^t(\d+)-(\d+)$/i);
    if (m) return { topic: Number(m[1]), ticket: Number(m[2]) };

    m = h.match(/^t-(\d+)$/i); // #t-2
    if (m) return { topic: 1, ticket: Number(m[1]) };

    if (/^\d+$/.test(h)) return { topic: 1, ticket: Number(h) }; // #2
    return { topic: 1, ticket: 1 };
  }

  function ensureNamespacedHash(topic, ticket){
    const target = `#t${topic}-${ticket}`;
    if (window.location.hash !== target) {
      try { history.replaceState(null, '', target); }
      catch(e){ window.location.hash = target; }
    }
  }

  const { topic: TOPIC, ticket: TICKET } = parseHash();
  ensureNamespacedHash(TOPIC, TICKET);

  // ---------- Ключи кэша для sessionStorage ----------
  const CACHE_KEY = `pdd_topic${TOPIC}_ticket${TICKET}_v1`;
  const STATE_KEY = `pdd_topic${TOPIC}_ticket${TICKET}_state_v1`;

  // ---------- Идентификаторы элементов на странице ----------
  const IDS = {
    imgContainer: 'question-img',
    question: 'question',
    answers: ['answer-1','answer-2','answer-3','answer-4','answer-5'],
    navPrefix: 'nav-q',
    nextBtn: 'train-answer-btn-next',
    reloadBtn: 'train-answer-btn-reload'
  };

  // классы ответа
  const CLASS_ANS_NON = 'train-answer-btn-nonactive';
  const CLASS_ANS_OK  = 'train-answer-btn-ok';
  const CLASS_ANS_NO  = 'train-answer-btn-no';

  // классы прогресса (верхняя навигация 1..10)
  const NAV = {
    active: ['train-progress-btn-active','Train-progress-btn-active'],
    ok:     ['train-progress-btn-ok','Train-progress-btn-ok'],
    no:     ['train-progress-btn-no','Train-progress-btn-no'],
    non:    ['train-progress-btn-nonactive','Train-progress-btn-nonactive']
  };

  // ---------- Утилиты ----------
  const qs = id => document.getElementById(id);
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

  function safeParseAnswers(raw){
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    try { return JSON.parse(raw); } catch(e){ return []; }
  }

  function buildImageUrl(path){
    if (!path) return null;
    if (typeof path === 'string' && (path.startsWith('http') || path.startsWith('/'))) return path;
    return `${SUPA}/storage/v1/object/public/${path}`;
  }

  async function fetchJSON(url, opts={}, {timeoutMs=12000, retries=2}={}){
    for (let retryIndex=0; retryIndex<=retries; retryIndex++){
      const ctrl = new AbortController();
      const t = setTimeout(()=>ctrl.abort(), timeoutMs);
      try{
        const res = await fetch(url, {...opts, signal: ctrl.signal});
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      }catch(err){
        clearTimeout(t);
        if (retryIndex===retries) throw err;
        await sleep(400*(retryIndex+1));
      }
    }
  }

  // --- прогресс-блоки (1..10)
  function stripProgressClasses(el){
    if (!el) return;
    const all = [...NAV.active,...NAV.ok,...NAV.no,...NAV.non];
    for (const c of all){
      el.classList.remove(c);
      if (el.firstElementChild) el.firstElementChild.classList.remove(c);
    }
  }
  function addProgressClass(el, kind){
    if (!el) return;
    for (const c of NAV[kind]||[]){
      el.classList.add(c);
      if (el.firstElementChild) el.firstElementChild.classList.add(c);
    }
  }
  function discoverNavs(){
    const nodes = Array.from(document.querySelectorAll('[id^="nav-q"]'));
    const map = {};
    nodes.forEach(node => {
      const m = node.id.match(/^nav-q(\d+)$/i);
      if (m) {
        const idx = Number(m[1]) - 1;
        if (!Number.isNaN(idx)) map[idx] = node;
      }
    });
    return map;
  }
  function initNavClasses(navMap){
    Object.values(navMap).forEach(el => {
      stripProgressClasses(el);
      addProgressClass(el,'non');
    });
  }
  function setNavActive(navMap, index){
    Object.entries(navMap).forEach(([k, el]) => {
      const idx = Number(k);
      if (idx === index) {
        stripProgressClasses(el);
        addProgressClass(el,'active');
      } else {
        const marked = [...NAV.ok,...NAV.no].some(c =>
          el.classList.contains(c) ||
          (el.firstElementChild && el.firstElementChild.classList.contains(c))
        );
        if (!marked){
          stripProgressClasses(el);
          addProgressClass(el,'non');
        }
      }
    });
  }
  function markNavResult(navMap, index, correct){
    const el = navMap[index];
    if (!el) return;
    stripProgressClasses(el);
    addProgressClass(el, correct ? 'ok' : 'no');
  }

  // ---------- Получение вопросов для текущего билета ----------
  async function fetchTicketQuestions(){
    // пробуем взять из sessionStorage
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (Array.isArray(cached) && cached.length) return cached;
      }
    } catch(e){}

    const url =
      `${SUPA}/rest/v1/questions` +
      `?select=id,question,answers,correct_answer,image_path,comment` +
      `&topic_number=eq.${TOPIC}` +
      `&ticket_number=eq.${TICKET}` +
      `&order=created_at.asc`;

    const raw = await fetchJSON(
      url,
      { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } }
    );

    const prepared = raw.map(q => ({
      ...q,
      answers: safeParseAnswers(q.answers),
      image_url: q.image_path ? buildImageUrl(q.image_path) : null
    }));

    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(prepared)); } catch(e){}
    return prepared;
  }

  // ---------- Локальный state билета ----------
  function loadState(len){
    try {
      const raw = sessionStorage.getItem(STATE_KEY);
      if (raw) return JSON.parse(raw);
    } catch(e){}
    return {
      answers: {},       // индекс вопроса -> true/false (правильно/неправильно)
      currentIdx: 0,     // какой вопрос сейчас показываем
      finished: false,   // билет завершён?
      length: len,
      startedAt: Date.now()
    };
  }

  function saveState(state){
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch(e){}
  }

  // ---------- Оформление ответов ----------
  function stripAllAnswerClasses(btn){
    if (!btn) return;
    for (const c of [CLASS_ANS_NON,CLASS_ANS_OK,CLASS_ANS_NO]){
      btn.classList.remove(c);
      if (btn.firstElementChild) btn.firstElementChild.classList.remove(c);
    }
  }
  function setAnswerNonactive(btn){
    stripAllAnswerClasses(btn);
    btn.classList.add(CLASS_ANS_NON);
    if (btn.firstElementChild) btn.firstElementChild.classList.add(CLASS_ANS_NON);
  }
  function setAnswerOk(btn){
    stripAllAnswerClasses(btn);
    btn.classList.add(CLASS_ANS_OK);
    if (btn.firstElementChild) btn.firstElementChild.classList.add(CLASS_ANS_OK);
  }
  function setAnswerNo(btn){
    stripAllAnswerClasses(btn);
    btn.classList.add(CLASS_ANS_NO);
    if (btn.firstElementChild) btn.firstElementChild.classList.add(CLASS_ANS_NO);
  }

  function setHeaderText(el, text){
    if (!el) return;
    let hasTextNode = false;
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        node.textContent = text;
        hasTextNode = true;
      }
    }
    if (!hasTextNode) el.textContent = text;
  }

  // ---------- Панель результата внизу ----------
  function updateResultDisplay(stateAnswers, totalQuestions){
    try {
      const okEl = document.getElementById('train-results-ok');
      const noEl = document.getElementById('train-results-no');
      const block232 = document.getElementById('div-block-232');
      const block231 = document.getElementById('div-block-231');

      // исходное состояние
      if (block232) block232.style.display = 'flex';
      if (block231) block231.style.display = 'flex';
      if (okEl) okEl.style.display = 'none';
      if (noEl) noEl.style.display = 'none';

      if (!stateAnswers || typeof totalQuestions !== 'number') return;

      const correctCount = Object.values(stateAnswers).filter(v => v === true).length;
      const wrongCount = totalQuestions - correctCount;

      // по завершению скрываем плейсхолдеры и показываем либо ok блок, либо no блок
      if (block232) block232.style.display = 'none';
      if (block231) block231.style.display = 'none';

      if (wrongCount >= 2) {
        if (noEl) noEl.style.display = 'flex';
      } else {
        if (okEl) okEl.style.display = 'flex';
      }
    } catch (err) {
      console.error('updateResultDisplay error:', err);
    }
  }

  // подгрузка следующей картинки заранее
  function preloadNextImage(questions, idx){
    const next = questions[idx+1];
    if (next && next.image_url){
      const img = new Image();
      img.src = next.image_url;
    }
  }

  // ---------- Рендер текущего вопроса ----------
  function renderQuestionForIndex(questions, idx, questionEl, imgContainerEl, answerEls, state, navMap, nextBtn){
    const qobj = questions[idx];
    if (!qobj) return;

    // разблокируем ответы
    window.__pdd_lockedSelection = false;
    for (let i = 0; i < answerEls.length; i++) {
      const b = answerEls[i];
      if (!b) continue;
      b.style.pointerEvents = '';
      b.removeAttribute('aria-disabled');
      b.disabled = false;
    }
    if (nextBtn) {
      nextBtn.style.display = '';
      nextBtn.disabled = true;
    }

    // если тест уже завершён
    if (state.finished) {
      if (questionEl) questionEl.textContent = 'Тест завершён.';
      for (const b of answerEls) {
        if (b) { b.style.display = 'none'; b.disabled = true; }
      }
      if (imgContainerEl) {
        if (imgContainerEl.tagName && imgContainerEl.tagName.toLowerCase() === 'img') {
          imgContainerEl.removeAttribute('src');
        } else {
          const existing = imgContainerEl.querySelector('[data-pdd-img]');
          if (existing) existing.remove();
        }
      }
      if (nextBtn) nextBtn.style.display = 'none';

      setNavActive(navMap, state.currentIdx >= questions.length ? questions.length-1 : state.currentIdx);
      updateResultDisplay(state.answers, questions.length);
      return;
    }

    // текст вопроса
    if (questionEl) setHeaderText(questionEl, qobj.question || '');

    // картинка
    if (imgContainerEl) {
      if (imgContainerEl.tagName && imgContainerEl.tagName.toLowerCase() === 'img') {
        if (qobj.image_url){
          imgContainerEl.onerror = ()=>{ imgContainerEl.removeAttribute('src'); };
          imgContainerEl.src = qobj.image_url;
        } else {
          imgContainerEl.removeAttribute('src');
        }
      } else {
        const existing = imgContainerEl.querySelector('[data-pdd-img]');
        if (existing) existing.remove();
        if (qobj.image_url) {
          const img = document.createElement('img');
          img.src = qobj.image_url;
          img.alt = 'Вопрос';
          img.style.maxWidth = '100%';
          img.dataset.pddImg = '1';
          img.onerror = ()=>{ img.remove(); };
          imgContainerEl.appendChild(img);
        }
      }
    }

    // варианты ответов
    const answers = (qobj.answers || []).slice(0,5);
    for (let j=0;j<answerEls.length;j++){
      const btn = answerEls[j];
      if (!btn) continue;
      const ans = answers[j];
      if (ans !== undefined && ans !== null) {
        const text = (typeof ans === 'object' && 'text' in ans) ? String(ans.text) : String(ans);
        btn.textContent = text;
        btn.style.display = '';
        btn.disabled = false;
        setAnswerNonactive(btn);
        const num = (typeof ans === 'object' && ans.num != null) ? Number(ans.num) : (j+1);
        btn.dataset.pddNum = String(num);
      } else {
        btn.style.display = 'none';
        btn.dataset.pddNum = '';
      }
    }

    // подсветить активный номер в прогрессе
    setNavActive(navMap, idx);

    // прелоад картинки следующего вопроса
    preloadNextImage(questions, idx);
  }

  // ---------- Основная инициализация ----------
  async function init(){
    const questionEl = qs(IDS.question);
    const imgContainerEl = qs(IDS.imgContainer);
    const answerEls = IDS.answers.map(id => qs(id));
    const nextBtn = qs(IDS.nextBtn);

    // верхние кружочки 1..10
    const navMap = discoverNavs();
    initNavClasses(navMap);

    // привести блоки результата в дефолт
    try {
      const okEl = document.getElementById('train-results-ok');
      const noEl = document.getElementById('train-results-no');
      const block232 = document.getElementById('div-block-232');
      const block231 = document.getElementById('div-block-231');
      if (block232) block232.style.display = 'flex';
      if (block231) block231.style.display = 'flex';
      if (okEl) okEl.style.display = 'none';
      if (noEl) noEl.style.display = 'none';
    } catch(e){}

    // грузим вопросы билета
    let questions = [];
    try {
      questions = await fetchTicketQuestions();
    } catch(e){
      console.error('Failed to load questions', e);
      if (questionEl) questionEl.textContent = 'Не удалось загрузить вопросы. Перезагрузите страницу.';
      return;
    }
    if (!questions.length) {
      if (questionEl) questionEl.textContent = 'Вопросы не найдены';
      return;
    }

    // подтягиваем state из sessionStorage
    const state = loadState(questions.length);
    if (typeof state.currentIdx !== 'number') state.currentIdx = 0;
    if (state.currentIdx < 0 || state.currentIdx >= questions.length) state.currentIdx = 0;

    // восстановить статусы (ок / не ок) в прогрессе
    if (state.answers) {
      Object.keys(state.answers).forEach(k => {
        const idx = Number(k);
        const val = !!state.answers[k];
        if (!Number.isNaN(idx)) markNavResult(navMap, idx, val);
      });
    }

    // показать состояние (вопрос или "завершено")
    if (state.finished) {
      if (questionEl) questionEl.textContent = 'Тест завершён.';
      for (const b of answerEls) {
        if (b) { b.style.display = 'none'; b.disabled = true; }
      }
      setNavActive(navMap, Math.min(state.currentIdx, questions.length-1));
      if (nextBtn) nextBtn.style.display = 'none';
      updateResultDisplay(state.answers, questions.length);
      return;
    } else {
      renderQuestionForIndex(
        questions,
        state.currentIdx,
        questionEl,
        imgContainerEl,
        answerEls,
        state,
        navMap,
        nextBtn
      );
    }

    // ---------- Логика ответа на вопрос ----------
    let pendingAnswer = null;
    let lockedSelection = false;
    window.__pdd_lockedSelection = lockedSelection;

    function onAnswerClick(e){
      if (state.finished || lockedSelection) return;

      const btn = e.currentTarget;
      const chosenNum = btn.dataset.pddNum ? Number(btn.dataset.pddNum) : null;

      const cur = state.currentIdx;
      const currentQ = questions[cur];
      const correctNum =
        currentQ && currentQ.correct_answer !== undefined
          ? Number(currentQ.correct_answer)
          : null;

      const correct =
        (chosenNum !== null && correctNum !== null)
          ? (chosenNum === correctNum)
          : null;

      // сбрасываем подсветку всех кнопок
      for (let i=0;i<answerEls.length;i++){
        const b = answerEls[i];
        if (!b) continue;
        setAnswerNonactive(b);
      }

      // подсвечиваем правильный ответ зелёным
      for (let i=0;i<answerEls.length;i++){
        const b = answerEls[i];
        if (!b) continue;
        const num = b.dataset.pddNum ? Number(b.dataset.pddNum) : (i+1);
        if (num === correctNum) {
          setAnswerOk(b);
          break;
        }
      }

      // если выбрал не то — подсветить красным
      if (correct === false) {
        setAnswerNo(btn);
      }

      pendingAnswer = { chosenNum, correct: !!correct };

      if (nextBtn) nextBtn.disabled = false;

      // блокируем повторный клик по вариантам
      lockedSelection = true;
      window.__pdd_lockedSelection = lockedSelection;
      for (let i = 0; i < answerEls.length; i++) {
        const b2 = answerEls[i];
        if (!b2) continue;
        b2.style.pointerEvents = 'none';
        b2.setAttribute('aria-disabled', 'true');
      }
    }

    function confirmAndNext(){
      if (state.finished || !pendingAnswer) return;

      const cur = state.currentIdx;

      // записываем результат текущего вопроса в локальный state,
      // чтобы потом показать общее "сдал / не сдал"
      state.answers = state.answers || {};
      state.answers[cur] = !!pendingAnswer.correct;

      // сохраняем время ответа (локально; не уходит никуда)
      state.qTimes = state.qTimes || {};
      state.qTimes[cur] = state.qTimes[cur] || {
        startedAt: state.qTimes[cur]?.startedAt || Date.now(),
        answeredAt: Date.now()
      };

      saveState(state);
      markNavResult(navMap, cur, !!pendingAnswer.correct);

      pendingAnswer = null;
      if (nextBtn) nextBtn.disabled = true;

      // разблокируем клики, готовим следующий вопрос
      lockedSelection = false;
      window.__pdd_lockedSelection = lockedSelection;
      for (let i = 0; i < answerEls.length; i++) {
        const b2 = answerEls[i];
        if (!b2) continue;
        b2.style.pointerEvents = '';
        b2.removeAttribute('aria-disabled');
      }

      state.currentIdx++;

      // был последний вопрос билета
      if (state.currentIdx >= questions.length) {
        // подсветить последний кружок
        setNavActive(navMap, Math.min(state.currentIdx - 1, questions.length - 1));
        try {
          const lastIdx = Math.min(state.currentIdx - 1, questions.length - 1);
          markNavResult(navMap, lastIdx, !!state.answers[lastIdx]);
        } catch(e){}

        state.finished = true;
        saveState(state);

        if (qs(IDS.question)) qs(IDS.question).textContent = 'Тест завершён.';
        for (const b of answerEls) {
          if (b) { b.style.display = 'none'; b.disabled = true; }
        }
        if (nextBtn) nextBtn.style.display = 'none';

        updateResultDisplay(state.answers, questions.length);
        return;
      }

      // иначе просто показываем следующий вопрос
      saveState(state);
      renderQuestionForIndex(
        questions,
        state.currentIdx,
        qs(IDS.question),
        qs(IDS.imgContainer),
        answerEls,
        state,
        navMap,
        nextBtn
      );
    }

    // навешиваем клики на варианты ответов
    for (const b of answerEls) {
      if (!b) continue;
      setAnswerNonactive(b);
      b.addEventListener('click', onAnswerClick);
    }

    // "Далее >" внутри вопроса
    if (nextBtn) {
      nextBtn.disabled = true;
      nextBtn.style.display = '';
      // раньше тут была логика подтверждения ответа; оставляем её
      nextBtn.addEventListener('click', function(e){
        e.stopPropagation();
        confirmAndNext();
      });
    }

    // клавиатура: 1..5 выбрать ответ, Enter -> "Далее"
    function onKeyDown(e){
      if (state.finished) return;

      const numKey = Number(e.key);
      if (!isNaN(numKey) && numKey>=1 && numKey<=5){
        const idx = numKey-1;
        const btn = answerEls[idx];
        if (
          btn &&
          btn.style.display !== 'none' &&
          !btn.disabled &&
          !lockedSelection
        ){
          btn.click();
          e.preventDefault();
          return;
        }
      }

      if (e.key === 'Enter' && pendingAnswer){
        e.preventDefault();
        confirmAndNext();
      }
    }
    window.addEventListener('keydown', onKeyDown);

    // ---------- Кнопки "Следующий билет" и "Пройти заново" ----------
    (function attachBannerHandlers(){

      // helper: проверяем предварительно, существует ли билет
      async function requestTicketPreview(topicNumber, ticketNumber){
        const url =
          `${SUPA}/rest/v1/questions` +
          `?select=id` +
          `&topic_number=eq.${topicNumber}` +
          `&ticket_number=eq.${ticketNumber}` +
          `&limit=1`;

        const res = await fetchJSON(
          url,
          { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } },
          { timeoutMs: 8000, retries: 1 }
        );

        return Array.isArray(res) ? res : [];
      }

      // выбираем следующий билет по правилам:
      // 1) попытаться ticket+1 в той же теме
      // 2) если такого нет, прыгнуть в topic+1, ticket=1
      async function resolveNextTicket(){
        const currentTopic = Number(TOPIC);
        const currentTicket = Number(TICKET);
        const candidateTicket = currentTicket + 1;

        // пробуем следующий билет в той же теме
        try {
          const candidateData = await requestTicketPreview(currentTopic, candidateTicket);
          if (candidateData.length > 0) {
            return { topic: currentTopic, ticket: candidateTicket };
          }
        } catch (err) {
          console.warn('Next ticket preview failed, trying next topic', err);
        }

        // иначе идём в следующую тему с первым билетом
        const nextTopic = currentTopic + 1;
        const fallbackTicket = 1;

        const fallbackData = await requestTicketPreview(nextTopic, fallbackTicket);
        if (fallbackData.length > 0) {
          return { topic: nextTopic, ticket: fallbackTicket };
        }

        throw new Error('Следующий билет не найден');
      }

      // Клик по кнопке "следующий билет"
      async function handleBannerNextClick(e){
        const btn = e.target.closest && e.target.closest(`#${IDS.nextBtn}`);
        if (!btn) return;

        // переход доступен только после завершения текущего билета
        if (!state.finished) return;

        // не даём задвоенный клик
        if (btn.dataset.pddLoading === '1') return;
        btn.dataset.pddLoading = '1';

        const prevText = btn.textContent || '';
        btn.disabled = true;
        btn.textContent = 'Загрузка...';

        try {
          // ЧИСТО переход. Никаких сохранений результатов в БД.
          // 1. Чистим локальные данные текущего билета
          try {
            sessionStorage.removeItem(CACHE_KEY);
            sessionStorage.removeItem(STATE_KEY);
          } catch(e){}

          // 2. Находим следующий билет
          const nextTarget = await resolveNextTicket();

          // 3. Обновляем hash и перезагружаем
          ensureNamespacedHash(nextTarget.topic, nextTarget.ticket);
          window.location.reload();

        } catch (err) {
          console.error('Не удалось перейти к следующему билету:', err);
          btn.disabled = false;
          btn.textContent = prevText;
          alert('Не получилось открыть следующий билет. Проверьте соединение и консоль.');
        } finally {
          delete btn.dataset.pddLoading;
        }
      }

      // Клик по кнопке "пройти заново"
      function handleBannerReloadClick(e){
        const btn = e.target.closest && e.target.closest(`#${IDS.reloadBtn}`);
        if (!btn) return;

        e.preventDefault();
        e.stopPropagation();

        // просто чистим стейт и остаёмся на том же билете
        try {
          sessionStorage.removeItem(CACHE_KEY);
          sessionStorage.removeItem(STATE_KEY);
        } catch(err){}

        ensureNamespacedHash(TOPIC, TICKET);
        window.location.reload();
      }

      document.addEventListener('click', handleBannerNextClick);
      document.addEventListener('click', handleBannerReloadClick);

      // сохраним ссылки, чтобы потом снять листенеры
      window.__pdd_banner_handlers = window.__pdd_banner_handlers || {};
      window.__pdd_banner_handlers.next = handleBannerNextClick;
      window.__pdd_banner_handlers.reload = handleBannerReloadClick;
    })();

    // ---------- cleanup при уходе со страницы ----------
    window.addEventListener('beforeunload', () => {
      try {
        window.removeEventListener('keydown', onKeyDown);
        if (nextBtn) nextBtn.removeEventListener('click', confirmAndNext);
        for (const b of answerEls) {
          if (b) b.removeEventListener('click', onAnswerClick);
        }
        if (window.__pdd_banner_handlers?.next) {
          document.removeEventListener('click', window.__pdd_banner_handlers.next);
        }
        if (window.__pdd_banner_handlers?.reload) {
          document.removeEventListener('click', window.__pdd_banner_handlers.reload);
        }
      } catch(e){}
    });

  } // end init

  // Запуск и пересчёт по хэшу
  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }

  // если hash сменился на #t<topic>-<ticket>, просто перегружаем тренажёр
  window.addEventListener('hashchange', ()=>{
    const h = (window.location.hash || '').trim();
    if (/^#t\d+-\d+$/i.test(h)) {
      location.reload();
    }
    // любые другие якори (внутренние якоря Webflow) игнорируем
  });

})();
</script>
