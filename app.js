/**
 * Gemini SaaS Studio - Application Logic with Supabase Auto-Sync
 */

// --- Storage Keys ---
const STORAGE_KEY_CHATS = 'gemini_studio_chats';
const STORAGE_KEY_SETTINGS = 'gemini_studio_settings';
const STORAGE_KEY_ACTIVE_ID = 'gemini_studio_active_id';
const STORAGE_KEY_THEME = 'gemini_studio_theme';

// --- State ---
let chats = JSON.parse(localStorage.getItem(STORAGE_KEY_CHATS)) || [];
let currentChatId = localStorage.getItem(STORAGE_KEY_ACTIVE_ID) || null;
let pendingFiles = [];
let isGenerating = false;
let supabaseClient = null;
let supabaseUser = null;
let realtimeChannel = null;

let settings = JSON.parse(localStorage.getItem(STORAGE_KEY_SETTINGS)) || {
  apiKeys: [],
  activeKeyId: null,
  systemInstructions: [
    { id: 'default', title: 'Без инструкции', prompt: '' },
    { id: 'code_expert', title: 'Senior Разработчик', prompt: 'Ты опытный senior инженер. Пиши чистый, идиоматичный и безопасный код с пояснениями.' },
    { id: 'concise', title: 'Краткий помощник', prompt: 'Отвечай максимально кратко, по делу и структурированно.' }
  ],
  activeInstructionId: 'default',
  thinkingLevel: 'medium',
  tools: {
    search: false,
    codeExecution: false
  },
  safetySettings: {
    HARM_CATEGORY_HARASSMENT: 'BLOCK_NONE',
    HARM_CATEGORY_HATE_SPEECH: 'BLOCK_NONE',
    HARM_CATEGORY_SEXUALLY_EXPLICIT: 'BLOCK_NONE',
    HARM_CATEGORY_DANGEROUS_CONTENT: 'BLOCK_NONE',
    HARM_CATEGORY_CIVIC_INTEGRITY: 'BLOCK_NONE'
  },
  supabase: {
    url: '',
    anonKey: ''
  }
};

// --- Custom Marked Renderer with Collapsible Code Spoilers ---
const customCodeRenderer = {
  code(token) {
    const rawCode = typeof token === 'object' ? token.text : token;
    const rawLang = (typeof token === 'object' ? token.lang : arguments[1]) || 'code';
    const cleanLang = (rawLang || 'code').toLowerCase().trim();

    const extMap = {
      js: 'js', javascript: 'js', py: 'py', python: 'py', html: 'html', css: 'css',
      json: 'json', ts: 'ts', typescript: 'ts', cpp: 'cpp', c: 'c', java: 'java',
      go: 'go', rust: 'rs', sql: 'sql', sh: 'sh', bash: 'sh', txt: 'txt', md: 'md'
    };
    const ext = extMap[cleanLang] || 'txt';
    const encoded = encodeURIComponent(rawCode);

    return `
      <details class="code-spoiler-card">
        <summary class="code-spoiler-header">
          <div class="code-spoiler-left">
            <span class="material-symbols-outlined spoiler-arrow">expand_more</span>
            <span class="code-lang-tag">${escapeHtml(cleanLang)}</span>
          </div>
          <div class="code-actions" onclick="event.stopPropagation()">
            <button type="button" class="code-action-btn" onclick="copyCodeSnippet(this, decodeURIComponent('${encoded}'))" title="Копировать код">
              <span class="material-symbols-outlined">content_copy</span>
              <span>Копировать</span>
            </button>
            <button type="button" class="code-action-btn" onclick="downloadCodeSnippet(decodeURIComponent('${encoded}'), 'code.${ext}')" title="Скачать как файл">
              <span class="material-symbols-outlined">download</span>
              <span>Скачать</span>
            </button>
          </div>
        </summary>
        <div class="code-content">
          <pre><code class="language-${cleanLang}">${escapeHtml(rawCode)}</code></pre>
        </div>
      </details>
    `;
  }
};
marked.use({ renderer: customCodeRenderer });

// --- Initialization ---
window.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  renderTopPills();
  
  if (chats.length === 0) {
    createNewChat();
  } else {
    if (!currentChatId || !chats.find(c => c.id === currentChatId)) {
      currentChatId = chats[0].id;
    }
    renderChatList();
    renderActiveChat();
  }

  await initSupabaseClient();
});

// --- Theme Management ---
function initTheme() {
  const savedTheme = localStorage.getItem(STORAGE_KEY_THEME) || 'dark';
  applyTheme(savedTheme);
}

function toggleTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  applyTheme(isDark ? 'light' : 'dark');
}

function applyTheme(theme) {
  const hljsTheme = document.getElementById('hljs-theme');
  const themeIcon = document.getElementById('theme-icon');
  
  if (theme === 'dark') {
    document.documentElement.classList.add('dark');
    document.documentElement.classList.remove('light');
    hljsTheme.href = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css";
    document.getElementById('theme-label').innerText = 'Светлая';
    if (themeIcon) themeIcon.innerText = 'light_mode';
  } else {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    hljsTheme.href = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css";
    document.getElementById('theme-label').innerText = 'Темная';
    if (themeIcon) themeIcon.innerText = 'dark_mode';
  }
  localStorage.setItem(STORAGE_KEY_THEME, theme);
}

// --- Dynamic Supabase Client Resolver ---
async function ensureSupabaseClient() {
  const urlInput = document.getElementById('supabase-url-input');
  const keyInput = document.getElementById('supabase-key-input');

  const url = (urlInput && urlInput.value.trim()) ? urlInput.value.trim() : settings.supabase?.url?.trim();
  const key = (keyInput && keyInput.value.trim()) ? keyInput.value.trim() : settings.supabase?.anonKey?.trim();

  if (!url || !key) {
    return null;
  }

  if (typeof supabase === 'undefined') {
    throw new Error('Библиотека Supabase не загружена. Проверьте подключение к интернету.');
  }

  if (!settings.supabase) settings.supabase = {};
  settings.supabase.url = url;
  settings.supabase.anonKey = key;
  localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));

  if (!supabaseClient || supabaseClient.supabaseUrl !== url) {
    supabaseClient = supabase.createClient(url, key);
  }

  return supabaseClient;
}

// --- Supabase Cloud Sync Engine ---
async function initSupabaseClient() {
  try {
    const client = await ensureSupabaseClient();
    if (!client) {
      updateSyncIndicator(false, 'Офлайн');
      return;
    }

    const { data: { session } } = await client.auth.getSession();
    
    if (session?.user) {
      supabaseUser = session.user;
      updateSyncIndicator(true, 'Синхронизировано');
      renderSupabaseAuthUI();
      await pullDataFromCloud();
      subscribeToCloudChanges();
    } else {
      supabaseUser = null;
      updateSyncIndicator(false, 'Не авторизован');
      renderSupabaseAuthUI();
    }
  } catch (err) {
    console.error('Supabase init error:', err);
    updateSyncIndicator(false, 'Ошибка');
  }
}

function updateSyncIndicator(isSynced, text) {
  const pill = document.getElementById('sync-status-pill');
  const label = document.getElementById('sync-status-label');
  const icon = document.getElementById('sync-status-icon');

  if (label) label.innerText = text;
  if (pill) {
    if (isSynced) {
      pill.classList.add('synced');
      if (icon) icon.innerText = 'cloud_done';
    } else {
      pill.classList.remove('synced');
      if (icon) icon.innerText = 'cloud_off';
    }
  }
}

function renderSupabaseAuthUI() {
  const loggedOutBox = document.getElementById('supabase-logged-out-box');
  const loggedInBox = document.getElementById('supabase-logged-in-box');
  const userEmail = document.getElementById('supabase-user-email');

  if (!loggedOutBox || !loggedInBox) return;

  if (supabaseUser) {
    loggedOutBox.classList.add('hidden');
    loggedInBox.classList.remove('hidden');
    if (userEmail) userEmail.innerText = supabaseUser.email;
  } else {
    loggedOutBox.classList.remove('hidden');
    loggedInBox.classList.add('hidden');
  }
}

async function handleSupabaseSignUp() {
  try {
    const client = await ensureSupabaseClient();
    if (!client) {
      alert('Пожалуйста, заполните поля Supabase URL и Anon Key.');
      return;
    }

    const email = document.getElementById('supabase-email').value.trim();
    const password = document.getElementById('supabase-password').value.trim();

    if (!email || !password) {
      alert('Введите email и пароль.');
      return;
    }

    const { data, error } = await client.auth.signUp({ email, password });
    if (error) {
      alert('Ошибка регистрации: ' + error.message);
    } else {
      alert('Аккаунт создан! Авторизация выполнена.');
      supabaseUser = data.user;
      renderSupabaseAuthUI();
      updateSyncIndicator(true, 'Синхронизировано');
      await pushDataToCloud();
      subscribeToCloudChanges();
    }
  } catch (err) {
    alert('Ошибка подключения: ' + err.message);
  }
}

async function handleSupabaseSignIn() {
  try {
    const client = await ensureSupabaseClient();
    if (!client) {
      alert('Пожалуйста, заполните поля Supabase URL и Anon Key.');
      return;
    }

    const email = document.getElementById('supabase-email').value.trim();
    const password = document.getElementById('supabase-password').value.trim();

    if (!email || !password) {
      alert('Введите email и пароль.');
      return;
    }

    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      alert('Ошибка входа: ' + error.message);
    } else {
      supabaseUser = data.user;
      renderSupabaseAuthUI();
      updateSyncIndicator(true, 'Синхронизировано');
      await pullDataFromCloud();
      subscribeToCloudChanges();
    }
  } catch (err) {
    alert('Ошибка подключения: ' + err.message);
  }
}

async function handleSupabaseSignOut() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  supabaseUser = null;
  if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
  renderSupabaseAuthUI();
  updateSyncIndicator(false, 'Офлайн');
}

async function pushDataToCloud() {
  if (!supabaseClient || !supabaseUser) return;

  try {
    const { error } = await supabaseClient
      .from('user_sync')
      .upsert({
        user_id: supabaseUser.id,
        chats: chats,
        settings: settings,
        updated_at: new Date().toISOString()
      });

    if (error) throw error;
    updateSyncIndicator(true, 'Синхронизировано');
  } catch (err) {
    console.error('Push to cloud error:', err);
    updateSyncIndicator(false, 'Сбой синхронизации');
  }
}

async function pullDataFromCloud() {
  if (!supabaseClient || !supabaseUser) return;

  try {
    const { data, error } = await supabaseClient
      .from('user_sync')
      .select('chats, settings, updated_at')
      .eq('user_id', supabaseUser.id)
      .maybeSingle();

    if (error) throw error;

    if (data) {
      if (data.chats && Array.isArray(data.chats)) {
        chats = data.chats;
        localStorage.setItem(STORAGE_KEY_CHATS, JSON.stringify(chats));
      }
      if (data.settings) {
        settings = { ...settings, ...data.settings };
        localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
      }
      renderTopPills();
      renderChatList();
      renderActiveChat();
      updateSyncIndicator(true, 'Синхронизировано');
    } else {
      await pushDataToCloud();
    }
  } catch (err) {
    console.error('Pull from cloud error:', err);
  }
}

function subscribeToCloudChanges() {
  if (!supabaseClient || !supabaseUser) return;
  if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);

  realtimeChannel = supabaseClient
    .channel('user_sync_channel')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'user_sync',
        filter: `user_id=eq.${supabaseUser.id}`
      },
      (payload) => {
        if (payload.new) {
          if (payload.new.chats && !isGenerating) {
            chats = payload.new.chats;
            localStorage.setItem(STORAGE_KEY_CHATS, JSON.stringify(chats));
            renderChatList();
            renderActiveChat();
          }
          if (payload.new.settings) {
            settings = { ...settings, ...payload.new.settings };
            localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
            renderTopPills();
          }
        }
      }
    )
    .subscribe();
}

async function forceCloudSync() {
  updateSyncIndicator(false, 'Синхронизация...');
  await pullDataFromCloud();
  await pushDataToCloud();
}

// --- API Keys Management ---
function getActiveApiKey() {
  if (!settings.apiKeys || settings.apiKeys.length === 0) return '';
  const found = settings.apiKeys.find(k => k.id === settings.activeKeyId);
  return found ? found.key : (settings.apiKeys[0]?.key || '');
}

function switchActiveKey(keyId) {
  settings.activeKeyId = keyId;
  saveSettingsToStorage();
  renderTopPills();
}

function addNewApiKey() {
  const labelInput = document.getElementById('new-key-label');
  const valInput = document.getElementById('new-key-value');
  
  const label = labelInput.value.trim() || `Ключ ${settings.apiKeys.length + 1}`;
  const key = valInput.value.trim();

  if (!key) {
    alert('Введите значение API-ключа.');
    return;
  }

  const newId = 'key_' + Date.now();
  settings.apiKeys.push({ id: newId, label, key });
  if (!settings.activeKeyId) settings.activeKeyId = newId;

  labelInput.value = '';
  valInput.value = '';

  saveSettingsToStorage();
  renderTopPills();
  renderKeysManagerList();
}

function deleteApiKey(keyId) {
  settings.apiKeys = settings.apiKeys.filter(k => k.id !== keyId);
  if (settings.activeKeyId === keyId) {
    settings.activeKeyId = settings.apiKeys[0]?.id || null;
  }
  saveSettingsToStorage();
  renderTopPills();
  renderKeysManagerList();
}

// --- System Instructions Management ---
function getActiveSystemPrompt() {
  if (!settings.systemInstructions || settings.systemInstructions.length === 0) return '';
  const found = settings.systemInstructions.find(i => i.id === settings.activeInstructionId);
  return found ? found.prompt : '';
}

function switchActiveInstruction(id) {
  settings.activeInstructionId = id;
  saveSettingsToStorage();
  renderTopPills();
}

function addNewSystemInstruction() {
  const titleInput = document.getElementById('new-instruction-title');
  const promptInput = document.getElementById('new-instruction-prompt');

  const title = titleInput.value.trim();
  const prompt = promptInput.value.trim();

  if (!title) {
    alert('Укажите название пресета.');
    return;
  }

  const newId = 'inst_' + Date.now();
  settings.systemInstructions.push({ id: newId, title, prompt });
  settings.activeInstructionId = newId;

  titleInput.value = '';
  promptInput.value = '';

  saveSettingsToStorage();
  renderTopPills();
  renderInstructionsManagerList();
}

function deleteSystemInstruction(id) {
  settings.systemInstructions = settings.systemInstructions.filter(i => i.id !== id);
  if (settings.activeInstructionId === id) {
    settings.activeInstructionId = settings.systemInstructions[0]?.id || null;
  }
  saveSettingsToStorage();
  renderTopPills();
  renderInstructionsManagerList();
}

// --- Thinking Level Management ---
function selectThinkingLevel(level) {
  settings.thinkingLevel = level;
  updateThinkingLevelUI();
}

function updateThinkingLevelUI() {
  const current = settings.thinkingLevel || 'medium';
  document.querySelectorAll('#thinking-level-control .segment-btn').forEach(btn => {
    if (btn.getAttribute('data-level') === current) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  const hints = {
    off: 'Отключено: модель отвечает без этапа предварительного рассуждения (минимальная задержка).',
    minimal: 'Minimal: сверхлегкое рассуждение для базовых задач с поддержкой минимального уровня.',
    low: 'Low: быстрое рассуждение для стандартных запросов с минимальным расходом токенов.',
    medium: 'Medium: сбалансированное рассуждение (рекомендуемый стандарт).',
    high: 'High: глубокий многошаговый анализ для сложных задач, архитектуры и сложного кода.'
  };
  const hintEl = document.getElementById('thinking-level-hint');
  if (hintEl) hintEl.innerText = hints[current] || hints.medium;
}

// --- Safety Settings ---
function loadSafetySettingsUI() {
  const s = settings.safetySettings || {};
  document.getElementById('safety-harassment').value = s.HARM_CATEGORY_HARASSMENT || 'BLOCK_NONE';
  document.getElementById('safety-hate').value = s.HARM_CATEGORY_HATE_SPEECH || 'BLOCK_NONE';
  document.getElementById('safety-sexual').value = s.HARM_CATEGORY_SEXUALLY_EXPLICIT || 'BLOCK_NONE';
  document.getElementById('safety-dangerous').value = s.HARM_CATEGORY_DANGEROUS_CONTENT || 'BLOCK_NONE';
  document.getElementById('safety-civic').value = s.HARM_CATEGORY_CIVIC_INTEGRITY || 'BLOCK_NONE';
}

function readSafetySettingsUI() {
  return {
    HARM_CATEGORY_HARASSMENT: document.getElementById('safety-harassment').value,
    HARM_CATEGORY_HATE_SPEECH: document.getElementById('safety-hate').value,
    HARM_CATEGORY_SEXUALLY_EXPLICIT: document.getElementById('safety-sexual').value,
    HARM_CATEGORY_DANGEROUS_CONTENT: document.getElementById('safety-dangerous').value,
    HARM_CATEGORY_CIVIC_INTEGRITY: document.getElementById('safety-civic').value
  };
}

// --- Topbar Selectors Sync ---
function renderTopPills() {
  const keySelect = document.getElementById('active-key-select');
  keySelect.innerHTML = '';
  if (settings.apiKeys.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.innerText = 'Нет ключей';
    keySelect.appendChild(opt);
  } else {
    settings.apiKeys.forEach(k => {
      const opt = document.createElement('option');
      opt.value = k.id;
      opt.innerText = k.label;
      if (k.id === settings.activeKeyId) opt.selected = true;
      keySelect.appendChild(opt);
    });
  }

  const instSelect = document.getElementById('active-instruction-select');
  instSelect.innerHTML = '';
  if (!settings.systemInstructions || settings.systemInstructions.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.innerText = 'Без инструкций';
    instSelect.appendChild(opt);
  } else {
    settings.systemInstructions.forEach(i => {
      const opt = document.createElement('option');
      opt.value = i.id;
      opt.innerText = i.title;
      if (i.id === settings.activeInstructionId) opt.selected = true;
      instSelect.appendChild(opt);
    });
  }
}

// --- Chat Lifecycle ---
function createNewChat() {
  const newChat = {
    id: 'chat_' + Date.now(),
    title: 'Новый диалог',
    model: 'gemini-3.5-flash',
    createdAt: new Date().toISOString(),
    totalTokens: 0,
    messages: []
  };

  chats.unshift(newChat);
  currentChatId = newChat.id;
  saveChats();
  renderChatList();
  renderActiveChat();

  if (window.innerWidth <= 768) {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    sidebar.classList.remove('open');
    backdrop.classList.remove('active');
  }
}

function selectChat(id) {
  if (currentChatId === id) return;
  currentChatId = id;
  localStorage.setItem(STORAGE_KEY_ACTIVE_ID, id);
  renderChatList();
  renderActiveChat();

  if (window.innerWidth <= 768) toggleSidebar();
}

function deleteChat(id, event) {
  event.stopPropagation();
  chats = chats.filter(c => c.id !== id);
  
  if (chats.length === 0) {
    createNewChat();
  } else {
    if (currentChatId === id) currentChatId = chats[0].id;
    saveChats();
    renderChatList();
    renderActiveChat();
  }
}

function clearCurrentChat() {
  const active = getActiveChat();
  if (!active) return;
  active.messages = [];
  active.totalTokens = 0;
  saveChats();
  renderActiveChat();
}

function updateChatModel(modelName) {
  const active = getActiveChat();
  if (active) {
    active.model = modelName;
    saveChats();
  }
}

function getActiveChat() {
  return chats.find(c => c.id === currentChatId);
}

function saveChats() {
  localStorage.setItem(STORAGE_KEY_CHATS, JSON.stringify(chats));
  localStorage.setItem(STORAGE_KEY_ACTIVE_ID, currentChatId);
  pushDataToCloud();
}

function saveSettingsToStorage() {
  localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
  pushDataToCloud();
}

// --- UI Rendering ---
function renderChatList() {
  const listContainer = document.getElementById('chat-list');
  listContainer.innerHTML = '';

  chats.forEach(chat => {
    const isActive = chat.id === currentChatId;
    const item = document.createElement('div');
    item.className = `chat-item ${isActive ? 'active' : ''}`;
    item.onclick = () => selectChat(chat.id);

    item.innerHTML = `
      <div class="chat-item-title">
        <span class="material-symbols-outlined">chat_bubble</span>
        <span>${escapeHtml(chat.title)}</span>
      </div>
      <button onclick="deleteChat('${chat.id}', event)" class="chat-item-delete" title="Удалить">
        <span class="material-symbols-outlined" style="font-size:14px;">close</span>
      </button>
    `;
    listContainer.appendChild(item);
  });
}

function renderActiveChat() {
  const active = getActiveChat();
  if (!active) return;

  document.getElementById('model-select').value = active.model;
  document.getElementById('tokens-count').innerText = active.totalTokens || 0;

  const container = document.getElementById('messages-container');
  container.innerHTML = '';

  if (active.messages.length === 0) {
    container.innerHTML = `
      <div class="empty-chat">
        <div class="empty-icon"><img src="logo.svg" class="brand-custom-svg" alt="Logo"></div>
        <div class="empty-text">Диалог пуст. Отправьте запрос для начала работы.</div>
      </div>
    `;
    return;
  }

  active.messages.forEach((msg, idx) => {
    const isUser = msg.role === 'user';
    const isLast = idx === active.messages.length - 1;
    const row = document.createElement('div');
    row.className = `message-row ${isUser ? 'user' : 'model'}`;

    const metaHeader = document.createElement('div');
    metaHeader.className = 'message-meta-header';

    if (isUser) {
      metaHeader.innerHTML = `<span class="meta-role-pill">Вы</span>`;
    } else {
      const modelLabel = msg.model || active.model || 'Gemini';
      metaHeader.innerHTML = `
        <span class="meta-role-pill">Модель</span>
        <span class="meta-model-tag">${escapeHtml(modelLabel)}</span>
      `;
    }

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    // File attachments
    if (msg.attachments && msg.attachments.length > 0) {
      const attDiv = document.createElement('div');
      attDiv.className = 'bubble-attachments';
      msg.attachments.forEach(att => {
        if (att.mimeType.startsWith('image/')) {
          attDiv.innerHTML += `<img src="data:${att.mimeType};base64,${att.data}" class="bubble-attachment-img" alt="attachment">`;
        } else {
          attDiv.innerHTML += `
            <div class="bubble-attachment-file">
              <span class="material-symbols-outlined" style="font-size:14px;">description</span>
              <span>${escapeHtml(att.name)}</span>
            </div>
          `;
        }
      });
      bubble.appendChild(attDiv);
    }

    // Thinking Box
    if (msg.thinking) {
      const thinkDetails = document.createElement('details');
      thinkDetails.className = 'thinking-box';
      thinkDetails.innerHTML = `
        <summary class="thinking-summary">Процесс рассуждения</summary>
        <div class="thinking-content">${escapeHtml(msg.thinking)}</div>
      `;
      bubble.appendChild(thinkDetails);
    }

    // Markdown Content
    const mdContainer = document.createElement('div');
    mdContainer.className = 'markdown-body';
    
    let renderedHtml = marked.parse(msg.text || '');
    if (isGenerating && isLast && !isUser) {
      renderedHtml += '<span class="streaming-cursor"></span>';
    }
    mdContainer.innerHTML = renderedHtml;
    bubble.appendChild(mdContainer);

    row.appendChild(metaHeader);
    row.appendChild(bubble);
    container.appendChild(row);
  });

  document.querySelectorAll('.code-content pre code').forEach((el) => {
    hljs.highlightElement(el);
  });

  container.scrollTop = container.scrollHeight;
}

// --- Attachment Handlers ---
function handleFileSelect(event) {
  const files = event.target.files;
  if (!files.length) return;

  Array.from(files).forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64Data = e.target.result.split(',')[1];
      pendingFiles.push({
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        data: base64Data
      });
      renderPendingFiles();
    };
    reader.readAsDataURL(file);
  });

  event.target.value = '';
}

function removeAttachment(index) {
  pendingFiles.splice(index, 1);
  renderPendingFiles();
}

function renderPendingFiles() {
  const bar = document.getElementById('attachments-bar');
  const list = document.getElementById('attachments-list');
  
  if (pendingFiles.length === 0) {
    bar.classList.add('hidden');
    list.innerHTML = '';
    return;
  }

  bar.classList.remove('hidden');
  list.innerHTML = '';

  pendingFiles.forEach((file, idx) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.innerHTML = `
      <span class="attachment-chip-name">${escapeHtml(file.name)}</span>
      <button onclick="removeAttachment(${idx})">
        <span class="material-symbols-outlined" style="font-size:12px;">close</span>
      </button>
    `;
    list.appendChild(chip);
  });
}

// --- Textarea Autosize & Keydown ---
function autoResizeTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = textarea.scrollHeight + 'px';
}

function handleTextareaKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

// --- Real-time Streaming API Request Processing (SSE) ---
async function sendMessage() {
  if (isGenerating) return;

  const currentKey = getActiveApiKey();
  if (!currentKey) {
    alert('Пожалуйста, добавьте API-ключ в окне параметров.');
    openSettings('keys');
    return;
  }

  const input = document.getElementById('user-input');
  const text = input.value.trim();

  if (!text && pendingFiles.length === 0) return;

  const active = getActiveChat();
  if (!active) return;

  if (active.messages.length === 0 && text) {
    active.title = text.slice(0, 26);
    renderChatList();
  }

  const userMessage = {
    role: 'user',
    text: text,
    attachments: [...pendingFiles]
  };
  active.messages.push(userMessage);

  input.value = '';
  input.style.height = 'auto';
  pendingFiles = [];
  renderPendingFiles();

  const respondingModel = active.model || 'gemini-3.5-flash';
  const aiMessage = {
    role: 'model',
    model: respondingModel,
    text: '',
    thinking: ''
  };
  active.messages.push(aiMessage);
  
  isGenerating = true;
  const sendBtn = document.getElementById('send-btn');
  sendBtn.disabled = true;
  renderActiveChat();

  try {
    await streamGeminiResponse(active, currentKey, respondingModel);
  } catch (err) {
    aiMessage.text = 'Ошибка: ' + err.message;
  } finally {
    isGenerating = false;
    sendBtn.disabled = false;
    saveChats();
    renderActiveChat();
  }
}

async function streamGeminiResponse(chat, apiKey, model) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

  const contents = chat.messages.slice(0, -1).map(msg => {
    const parts = [];
    if (msg.attachments && msg.attachments.length > 0) {
      msg.attachments.forEach(att => {
        parts.push({
          inlineData: {
            mimeType: att.mimeType,
            data: att.data
          }
        });
      });
    }
    if (msg.text) {
      parts.push({ text: msg.text });
    }
    return {
      role: msg.role === 'user' ? 'user' : 'model',
      parts: parts
    };
  });

  const generationConfig = {};
  const lvl = (settings.thinkingLevel || 'medium').toLowerCase();

  if (lvl !== 'off') {
    if (model.startsWith('gemini-3')) {
      generationConfig.thinkingConfig = { thinkingLevel: lvl.toUpperCase() };
    } else {
      const budgetMap = { minimal: 512, low: 1024, medium: 8192, high: 24576 };
      generationConfig.thinkingConfig = { thinkingBudget: budgetMap[lvl] || 8192 };
    }
  } else if (!model.startsWith('gemini-3')) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const safetySettingsArray = Object.entries(settings.safetySettings || {}).map(([category, threshold]) => ({
    category,
    threshold
  }));

  const payload = {
    contents,
    generationConfig: Object.keys(generationConfig).length > 0 ? generationConfig : undefined,
    safetySettings: safetySettingsArray
  };

  const activePrompt = getActiveSystemPrompt();
  if (activePrompt && activePrompt.trim()) {
    payload.systemInstruction = {
      parts: [{ text: activePrompt.trim() }]
    };
  }

  const tools = [];
  if (settings.tools.search) tools.push({ googleSearch: {} });
  if (settings.tools.codeExecution) tools.push({ codeExecution: {} });
  if (tools.length > 0) payload.tools = tools;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey.trim()
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errObj = await response.json().catch(() => ({}));
    throw new Error(errObj.error?.message || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const targetAiMsg = chat.messages[chat.messages.length - 1];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const jsonStr = trimmed.replace(/^data:\s*/, '');
      if (!jsonStr || jsonStr === '[DONE]') continue;

      try {
        const chunk = JSON.parse(jsonStr);
        const candidate = chunk.candidates?.[0];

        if (candidate?.finishReason === 'SAFETY') {
          targetAiMsg.text += '\n\n[Ответ прерван фильтрами безопасности SAFETY]';
        }

        if (candidate?.content?.parts) {
          candidate.content.parts.forEach(part => {
            if (part.thought) {
              targetAiMsg.thinking += part.text;
            } else if (part.text) {
              targetAiMsg.text += part.text;
            }
          });
          renderActiveChat();
        }

        if (chunk.usageMetadata) {
          chat.totalTokens = chunk.usageMetadata.totalTokenCount || chat.totalTokens;
          document.getElementById('tokens-count').innerText = chat.totalTokens;
        }
      } catch (e) {
        // Ignore partial chunks
      }
    }
  }
}

// --- Code Actions: Copy & Download ---
function copyCodeSnippet(button, codeText) {
  navigator.clipboard.writeText(codeText).then(() => {
    const span = button.querySelector('span:not(.material-symbols-outlined)');
    const originalText = span.innerText;
    span.innerText = 'Скопировано!';
    setTimeout(() => {
      span.innerText = originalText;
    }, 2000);
  }).catch(() => {
    alert('Не удалось скопировать код.');
  });
}

function downloadCodeSnippet(codeText, filename) {
  const blob = new Blob([codeText], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// --- Navigation & Sidebar Drawer ---
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const isOpen = sidebar.classList.contains('open');

  if (isOpen) {
    sidebar.classList.remove('open');
    backdrop.classList.remove('active');
  } else {
    sidebar.classList.add('open');
    backdrop.classList.add('active');
  }
}

// --- Settings Modal & Tabs ---
function switchSettingsTab(tabName) {
  ['keys', 'instructions', 'params', 'safety', 'sync'].forEach(t => {
    const btn = document.getElementById(`tab-btn-${t}`);
    const content = document.getElementById(`tab-content-${t}`);
    if (btn) btn.classList.remove('active');
    if (content) content.classList.add('hidden');
  });

  const activeBtn = document.getElementById(`tab-btn-${tabName}`);
  const activeContent = document.getElementById(`tab-content-${tabName}`);
  if (activeBtn) activeBtn.classList.add('active');
  if (activeContent) activeContent.classList.remove('hidden');
}

function openSettings(defaultTab = 'keys') {
  renderKeysManagerList();
  renderInstructionsManagerList();
  updateThinkingLevelUI();
  loadSafetySettingsUI();

  document.getElementById('tool-search').checked = !!settings.tools?.search;
  document.getElementById('tool-code-execution').checked = !!settings.tools?.codeExecution;

  document.getElementById('supabase-url-input').value = settings.supabase?.url || '';
  document.getElementById('supabase-key-input').value = settings.supabase?.anonKey || '';

  renderSupabaseAuthUI();
  switchSettingsTab(defaultTab);

  document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}

function renderKeysManagerList() {
  const container = document.getElementById('keys-manager-list');
  container.innerHTML = '';

  if (settings.apiKeys.length === 0) {
    container.innerHTML = '<div class="control-hint">Список ключей пуст.</div>';
    return;
  }

  settings.apiKeys.forEach(k => {
    const isActive = k.id === settings.activeKeyId;
    const item = document.createElement('div');
    item.className = `manager-card-item ${isActive ? 'active' : ''}`;
    item.innerHTML = `
      <div class="manager-card-info">
        <span class="manager-card-title">${escapeHtml(k.label)}</span>
        <span class="manager-card-sub">${escapeHtml(k.key.slice(0, 6))}...${escapeHtml(k.key.slice(-4))}</span>
      </div>
      <div class="manager-card-actions">
        <button onclick="switchActiveKey('${k.id}'); renderKeysManagerList();" class="icon-btn-subtle" style="width:26px;height:26px;" title="Сделать активным">
          <span class="material-symbols-outlined" style="font-size:14px;">${isActive ? 'check_circle' : 'radio_button_unchecked'}</span>
        </button>
        <button onclick="deleteApiKey('${k.id}')" class="icon-btn-subtle" style="width:26px;height:26px;" title="Удалить">
          <span class="material-symbols-outlined" style="font-size:14px;">close</span>
        </button>
      </div>
    `;
    container.appendChild(item);
  });
}

function renderInstructionsManagerList() {
  const container = document.getElementById('instructions-manager-list');
  container.innerHTML = '';

  if (!settings.systemInstructions || settings.systemInstructions.length === 0) {
    container.innerHTML = '<div class="control-hint">Список пресетов пуст.</div>';
    return;
  }

  settings.systemInstructions.forEach(i => {
    const isActive = i.id === settings.activeInstructionId;
    const item = document.createElement('div');
    item.className = `manager-card-item ${isActive ? 'active' : ''}`;
    item.innerHTML = `
      <div class="manager-card-info">
        <span class="manager-card-title">${escapeHtml(i.title)}</span>
        <span class="manager-card-sub">${escapeHtml(i.prompt || '(Без текста инструкции)')}</span>
      </div>
      <div class="manager-card-actions">
        <button onclick="switchActiveInstruction('${i.id}'); renderInstructionsManagerList();" class="icon-btn-subtle" style="width:26px;height:26px;" title="Сделать активным">
          <span class="material-symbols-outlined" style="font-size:14px;">${isActive ? 'check_circle' : 'radio_button_unchecked'}</span>
        </button>
        <button onclick="deleteSystemInstruction('${i.id}')" class="icon-btn-subtle" style="width:26px;height:26px;" title="Удалить">
          <span class="material-symbols-outlined" style="font-size:14px;">close</span>
        </button>
      </div>
    `;
    container.appendChild(item);
  });
}

async function saveSettings() {
  settings.tools = {
    search: document.getElementById('tool-search').checked,
    codeExecution: document.getElementById('tool-code-execution').checked
  };

  settings.safetySettings = readSafetySettingsUI();

  const prevUrl = settings.supabase?.url;
  const prevKey = settings.supabase?.anonKey;
  const newUrl = document.getElementById('supabase-url-input').value.trim();
  const newKey = document.getElementById('supabase-key-input').value.trim();

  settings.supabase = {
    url: newUrl,
    anonKey: newKey
  };

  saveSettingsToStorage();
  closeSettings();

  if (newUrl !== prevUrl || newKey !== prevKey) {
    await initSupabaseClient();
  }
}

// --- Export Functionality ---
function openExportModal() {
  document.getElementById('export-modal').classList.remove('hidden');
}

function closeExportModal() {
  document.getElementById('export-modal').classList.add('hidden');
}

function executeExport() {
  const active = getActiveChat();
  if (!active || active.messages.length === 0) {
    alert('История диалога пуста.');
    closeExportModal();
    return;
  }

  const selectedFormat = document.querySelector('input[name="export-format"]:checked').value;
  const lines = [];

  active.messages.forEach(msg => {
    const text = (msg.text || '').trim();
    if (!text) return;

    if (selectedFormat === 'both') {
      const prefix = msg.role === 'user' ? 'Вы: ' : 'ИИ: ';
      lines.push(prefix + text);
    } else if (selectedFormat === 'user' && msg.role === 'user') {
      lines.push(text);
    } else if (selectedFormat === 'model' && msg.role === 'model') {
      lines.push(text);
    }
  });

  const exportString = lines.join('\n');
  const filename = `${active.title.replace(/[^a-zа-яё0-9]/gi, '_').toLowerCase()}_export.txt`;
  
  downloadTxtFile(filename, exportString);
  closeExportModal();
}

function downloadTxtFile(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// --- Utils ---
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}