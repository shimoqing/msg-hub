const ROOMS = [
  { id: "all", label: "全部", sub: "所有房间的消息" },
  { id: "ctf", label: "CTF", sub: "比赛与题目" },
  { id: "src", label: "SRC", sub: "漏洞与提交" },
  { id: "daily", label: "日常", sub: "常规协同" },
  { id: "sys", label: "系统", sub: "状态播报" },
];

const IDENTITY_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
const MENTION_SOURCE = "(^|[^\\w-])(@[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?)(?![\\w-])";
const KNOWN_IDENTITIES = ["cc", "dsh", "xing", "yao"];
const MENTION_LABELS = { cc: "CC", dsh: "dsh", xing: "Xing", yao: "Yao" };
const HOP_RE = /\[hop:\d+\]/;
const STATUS_MAX_TARGETS = 3;
const GROUP_WINDOW_MS = 5 * 60 * 1000;
const MAX_INPUT_HEIGHT = 168;
// Keep this key in sync with the early-read script in index.html.
const SIDE_COLLAPSED_KEY = "msghub.sideCollapsed";
const AVATAR_TINTS = 6;

const state = {
  token: "",
  identity: "",
  activeTopic: "all",
  messages: [],
  byId: new Map(),
  lastId: 0,
  es: null,
  connected: false,
  failures: 0,
  unread: new Map(),
  loaded: new Set(),
  autoScroll: true,
  renderedDay: null,
  renderedLastId: 0,
  renderedTopic: null,
  renderedLastMessage: null,
  presence: new Map(),
  presenceKnown: false,
  replyTo: null,
  search: "",
  newBelow: 0,
};

const el = {};
let pending = [];
let pendingEvicted = [];
let pendingFrame = 0;
let mentionState = null;
let pendingFiles = [];
let roomsTimer = 0;
let saveTimer = null;

function $(id) {
  return document.getElementById(id);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionRegex(identity) {
  if (!identity) return null;
  return new RegExp(`(^|[^\\w-])@${escapeRegExp(identity)}(?![\\w-])`);
}

function isWakeMessage(message) {
  if (message.type === "data" || message.type === "plan") return false;
  const re = mentionRegex(state.identity);
  return re ? re.test(message.body) : false;
}

// Reused Intl formatters: constructing one per call (toLocaleString) showed up
// as a hot path when rendering 1000-message bursts in the bench.
const timeFormatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
const dayFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" });
const dayLabelCache = new Map();

function dayKeyOf(ts) {
  const date = new Date(ts);
  return Number.isNaN(date.getTime())
    ? "invalid"
    : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatTime(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return timeFormatter.format(date);
}

function formatDate(ts) {
  const key = dayKeyOf(ts);
  if (key === "invalid") return "";
  let label = dayLabelCache.get(key);
  if (label === undefined) {
    label = dayFormatter.format(new Date(ts));
    dayLabelCache.set(key, label);
  }
  return label;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function labelOf(identity) {
  return MENTION_LABELS[identity] || identity;
}

function messagePreview(message) {
  if (!message) return "暂无消息";
  const body = String(message.body || "").replace(/\s+/g, " ").trim();
  const text = body.length > 36 ? `${body.slice(0, 36)}…` : body;
  return `${formatTime(message.ts)} · ${text}`;
}

function latestMessageFrom(name) {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    if (state.messages[i].from === name) return state.messages[i];
  }
  return null;
}

function mentionCandidates(query) {
  const q = String(query || "").toLowerCase();
  const names = [];
  const seen = new Set();
  for (const name of KNOWN_IDENTITIES) {
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const name = state.messages[i].from;
    if (typeof name === "string" && IDENTITY_RE.test(name) && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }

  const recent = new Map();
  for (const name of names) recent.set(name, latestMessageFrom(name));
  names.sort((a, b) => {
    const left = recent.get(a);
    const right = recent.get(b);
    const leftId = left ? left.id : -1;
    const rightId = right ? right.id : -1;
    if (leftId !== rightId) return rightId - leftId;
    return a.localeCompare(b);
  });

  const items = [];
  if (!q || "all".startsWith(q)) {
    items.push({ name: "all", label: "全体成员", recent: "唤醒所有 agent" });
  }
  for (const name of names) {
    if (q && !name.startsWith(q)) continue;
    items.push({
      name,
      label: MENTION_LABELS[name] || name,
      recent: messagePreview(recent.get(name)),
    });
  }
  return items;
}

function mentionContext(value, cursor) {
  if (!Number.isInteger(cursor)) return null;
  const before = value.slice(0, cursor);
  const match = /(^|[^A-Za-z0-9_-])@([a-z0-9_-]*)$/.exec(before);
  if (!match) return null;
  let end = cursor;
  while (end < value.length && /[a-z0-9_-]/.test(value[end])) end += 1;
  return { start: cursor - match[2].length - 1, end, query: match[2] };
}

function renderMentionMenu() {
  if (!mentionState || !mentionState.items.length) {
    closeMentionMenu();
    return;
  }
  const fragment = document.createDocumentFragment();
  mentionState.items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = `mention-item${index === mentionState.active ? " active" : ""}`;
    row.id = `mention-opt-${index}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", index === mentionState.active ? "true" : "false");
    const name = document.createElement("span");
    name.className = "mention-name";
    name.textContent = `@${item.name}`;
    const label = document.createElement("span");
    label.className = "mention-label";
    label.textContent = item.label;
    const recent = document.createElement("span");
    recent.className = "mention-recent";
    recent.textContent = item.recent;
    row.append(name, label, recent);
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectMention(index);
    });
    fragment.append(row);
  });
  el.mentionMenu.replaceChildren(fragment);
  el.mentionMenu.hidden = false;
  el.input.setAttribute("aria-expanded", "true");
  el.input.setAttribute("aria-activedescendant", `mention-opt-${mentionState.active}`);
}

function closeMentionMenu() {
  mentionState = null;
  if (el.mentionMenu) {
    el.mentionMenu.hidden = true;
    el.mentionMenu.replaceChildren();
  }
  if (el.input) {
    el.input.setAttribute("aria-expanded", "false");
    el.input.removeAttribute("aria-activedescendant");
  }
}

function updateMentionMenu() {
  if (!el.input || !el.mentionMenu) return;
  const context = mentionContext(el.input.value, el.input.selectionStart);
  if (!context) {
    closeMentionMenu();
    return;
  }
  const items = mentionCandidates(context.query);
  if (!items.length) {
    closeMentionMenu();
    return;
  }
  const active =
    mentionState && mentionState.query === context.query
      ? Math.min(mentionState.active, items.length - 1)
      : 0;
  mentionState = { ...context, items, active };
  renderMentionMenu();
}

function selectMention(index) {
  if (!mentionState) return;
  const item = mentionState.items[index];
  if (!item) return;
  const value = el.input.value;
  const before = value.slice(0, mentionState.start);
  const after = value.slice(mentionState.end);
  const space = !after || !/^[\s.,!?;:，。！？、；：）】]/.test(after) ? " " : "";
  const inserted = `@${item.name}${space}`;
  el.input.value = `${before}${inserted}${after}`;
  const cursor = before.length + inserted.length;
  el.input.setSelectionRange(cursor, cursor);
  el.input.focus();
  autoResizeInput();
  closeMentionMenu();
}

function handleMentionKey(event) {
  if (!mentionState || event.isComposing) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const count = mentionState.items.length;
    mentionState.active = (mentionState.active + delta + count) % count;
    renderMentionMenu();
    return true;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    selectMention(mentionState.active);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeMentionMenu();
    return true;
  }
  return false;
}

function appendMentions(container, text) {
  const re = new RegExp(MENTION_SOURCE, "g");
  let last = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    const at = match.index + match[1].length;
    if (at > last) container.append(document.createTextNode(text.slice(last, at)));
    const span = document.createElement("span");
    span.className = "mention";
    if (match[2] === "@all") {
      span.textContent = "@全体成员";
      span.title = "全体成员（@all）";
    } else {
      span.textContent = match[2];
    }
    container.append(span);
    last = at + match[2].length;
    if (re.lastIndex === match.index) re.lastIndex += 1;
  }
  if (last < text.length) container.append(document.createTextNode(text.slice(last)));
}

function extractMentions(body) {
  const re = new RegExp(MENTION_SOURCE, "g");
  const out = [];
  let match;
  while ((match = re.exec(String(body || ""))) !== null) {
    const name = match[2].slice(1);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function findReply(id, targets) {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const m = state.messages[i];
    if (m.reply_to === id && (targets.includes(m.from) || targets.includes("all"))) return m;
  }
  return null;
}

function statusFor(message) {
  const targets = extractMentions(message.body).filter((t) => t !== state.identity);
  if (!targets.length) return null;
  const known = targets.filter((t) => t !== "all");
  const reply = findReply(message.id, targets);
  if (reply) return { cls: "replied", text: `已回复 #${reply.id}`, jump: reply.id };

  const age = Date.now() - new Date(message.ts).getTime();
  const stale = !Number.isFinite(age) || age > 5 * 60_000;

  if (!stale) {
    const typing = known.find((t) => state.presence.get(t)?.typing);
    if (typing) return { cls: "typing", label: labelOf(typing) };
  }

  if (!known.length) {
    if (!state.presenceKnown) return { cls: "plain", text: "已送达" };
    const n = [...state.presence.values()].filter(
      (e) => e.online && e.identity !== state.identity,
    ).length;
    return { cls: "plain", text: n > 0 ? `已送达 · 在线 ${n} 人` : "已送达 · 当前无人在线" };
  }
  if (!state.presenceKnown) {
    return { cls: "plain", text: `已送达 · 等待 ${known.slice(0, 3).map(labelOf).join("、")} 回复` };
  }
  const parts = known.slice(0, STATUS_MAX_TARGETS).map((t) => {
    if (stale) return `${labelOf(t)} 暂无回复`;
    if (state.presence.get(t)?.online) return `${labelOf(t)} 处理中`;
    return `${labelOf(t)} 未连接`;
  });
  if (known.length > STATUS_MAX_TARGETS) parts.push(`+${known.length - STATUS_MAX_TARGETS}`);
  return { cls: "plain", text: `已送达 · ${parts.join(" · ")}` };
}

function typingDots() {
  const wrap = document.createElement("span");
  wrap.className = "dots";
  for (let i = 0; i < 3; i += 1) wrap.append(document.createElement("span"));
  return wrap;
}

function updateStatusNode(node, message) {
  const s = statusFor(message);
  node.className = `msg-status${s ? ` ${s.cls}` : ""}`;
  node.replaceChildren();
  if (!s) return;
  if (s.cls === "typing") {
    node.append(document.createTextNode(`${s.label} 正在输入`), typingDots());
    return;
  }
  node.textContent = s.text;
  if (s.jump) {
    node.title = "跳到回复";
    node.dataset.jump = String(s.jump);
  } else {
    delete node.dataset.jump;
  }
}

function updateStatuses() {
  if (!el.messages) return;
  for (const node of el.messages.querySelectorAll("[data-status-for]")) {
    const message = state.byId.get(Number(node.dataset.statusFor));
    if (message) updateStatusNode(node, message);
  }
}

/* ---------- avatars ---------- */

function hueOf(identity) {
  let hash = 0;
  for (const ch of String(identity)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

function paintAvatar(node, identity) {
  const tint = (hueOf(identity) % AVATAR_TINTS) + 1;
  node.style.background = `var(--avatar-${tint}-bg)`;
  node.style.color = `var(--avatar-${tint}-ink)`;
  node.textContent = labelOf(identity).slice(0, 1).toUpperCase();
  node.title = identity;
  node.setAttribute("aria-hidden", "true");
}

function avatarEl(identity, extraClass = "") {
  const div = document.createElement("div");
  div.className = `avatar${extraClass ? ` ${extraClass}` : ""}`;
  paintAvatar(div, identity);
  return div;
}

/* ---------- sidebar ---------- */

function presenceOf(name) {
  return state.presence.get(name) || null;
}

function updateMeAvatar() {
  if (el.meAvatar) paintAvatar(el.meAvatar, state.identity);
  if (el.meName) el.meName.textContent = state.identity ? `@${state.identity}` : "未设置身份";
  // Empty identity: open the editor so a first-time user has a way in.
  if (!state.identity) setIdentityEditing(true, false);
}

function setIdentityEditing(editing, focus = true) {
  if (!el.sideFoot) return;
  el.sideFoot.classList.toggle("editing", editing);
  if (el.meEdit) el.meEdit.setAttribute("aria-expanded", String(editing));
  if (editing && focus && el.identity) {
    el.identity.focus();
    el.identity.select();
  }
}

function lastMessageForTopic(topic) {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i];
    if (topic === "all" || message.topic === topic) return message;
  }
  return null;
}

function previewText(message, max = 26) {
  if (!message) return "暂无消息";
  let raw = String(message.body || "");
  if (message.type === "file") {
    try {
      const ref = JSON.parse(raw);
      raw = ref?.name ? `[文件] ${ref.name}` : "[文件]";
    } catch {
      raw = "[文件]";
    }
  } else if (message.type === "plan") {
    raw = "分工卡";
  } else if (message.type === "data") {
    raw = "[数据]";
  }
  const body = raw.replace(/\s+/g, " ").trim();
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

function roomSenders(topic) {
  const senders = [];
  for (let i = state.messages.length - 1; i >= 0 && senders.length < 2; i -= 1) {
    const message = state.messages[i];
    if (message.type === "sys") continue;
    if (topic !== "all" && message.topic !== topic) continue;
    if (!senders.includes(message.from)) senders.push(message.from);
  }
  return senders;
}

function roomAvatarEl(room) {
  const senders = room.id === "all" ? [] : roomSenders(room.id);
  const wrap = document.createElement("div");
  wrap.className = `room-avatar${senders.length < 2 ? " single" : ""}`;
  if (senders.length === 0) {
    const mini = document.createElement("span");
    mini.className = "mini";
    paintAvatar(mini, room.id === "all" ? "all" : room.label);
    wrap.append(mini);
    return wrap;
  }
  for (const sender of senders) {
    const mini = document.createElement("span");
    mini.className = "mini";
    paintAvatar(mini, sender);
    wrap.append(mini);
  }
  return wrap;
}

function renderRooms() {
  if (!el.rooms) return;
  const fragment = document.createDocumentFragment();
  for (const room of ROOMS) {
    const last = lastMessageForTopic(room.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `room${room.id === state.activeTopic ? " active" : ""}`;
    button.dataset.name = `${room.label} ${room.id}`.toLowerCase();

    button.append(roomAvatarEl(room));

    const text = document.createElement("span");
    text.className = "room-text";
    const name = document.createElement("span");
    name.className = "room-name";
    name.textContent = room.label;
    const preview = document.createElement("span");
    preview.className = "room-preview";
    preview.textContent = previewText(last);
    text.append(name, preview);

    const side = document.createElement("span");
    side.className = "room-side";
    if (last) {
      const time = document.createElement("span");
      time.className = "room-time";
      time.textContent = formatTime(last.ts);
      side.append(time);
    }
    const unread = state.unread.get(room.id) || 0;
    if (unread > 0) {
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = unread > 99 ? "99+" : String(unread);
      side.append(count);
    }

    button.append(text, side);
    button.title = room.label;
    button.setAttribute(
      "aria-label",
      unread > 0 ? `${room.label}，${unread} 条未读` : room.label,
    );
    if (room.id === state.activeTopic) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => switchRoom(room.id));
    if (state.search && !button.dataset.name.includes(state.search)) button.hidden = true;
    fragment.append(button);
  }
  el.rooms.replaceChildren(fragment);
}

function peopleNames() {
  const names = new Set([...KNOWN_IDENTITIES, ...state.presence.keys()]);
  names.delete(state.identity);
  return [...names].sort((a, b) => {
    const ea = presenceOf(a);
    const eb = presenceOf(b);
    const rank = (e) => (e?.typing ? 2 : e?.online ? 1 : 0);
    const diff = rank(eb) - rank(ea);
    if (diff) return diff;
    return labelOf(a).localeCompare(labelOf(b), "zh-CN");
  });
}

function renderPeople() {
  if (!el.people) return;
  const fragment = document.createDocumentFragment();
  for (const name of peopleNames()) {
    const entry = presenceOf(name);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "person";
    button.dataset.name = `${name} ${labelOf(name)}`.toLowerCase();

    const wrap = document.createElement("span");
    wrap.className = "avatar-wrap";
    wrap.append(avatarEl(name, "avatar-sm"));
    const dot = document.createElement("span");
    dot.className = `presence-dot${entry?.typing ? " typing" : entry?.online ? " online" : ""}`;
    wrap.append(dot);

    const text = document.createElement("span");
    text.className = "person-text";
    const personName = document.createElement("span");
    personName.className = "person-name";
    personName.textContent = labelOf(name);
    const status = document.createElement("span");
    status.className = `person-status${entry?.typing ? " typing" : entry?.online ? " online" : ""}`;
    const statusText = entry?.typing ? "正在输入…" : entry?.online ? "在线" : "离线";
    status.textContent = statusText;
    text.append(personName, status);

    button.append(wrap, text);
    button.title = `${labelOf(name)} · ${statusText}`;
    button.setAttribute("aria-label", `${labelOf(name)}，${statusText}`);
    button.addEventListener("click", () => insertMention(name));
    if (state.search && !button.dataset.name.includes(state.search)) button.hidden = true;
    fragment.append(button);
  }
  el.people.replaceChildren(fragment);
}

function applySearch(value) {
  state.search = String(value || "").trim().toLowerCase();
  for (const node of el.rooms.querySelectorAll(".room")) {
    node.hidden = Boolean(state.search) && !node.dataset.name.includes(state.search);
  }
  for (const node of el.people.querySelectorAll(".person")) {
    node.hidden = Boolean(state.search) && !node.dataset.name.includes(state.search);
  }
}

function scheduleRooms() {
  if (roomsTimer) return;
  roomsTimer = setTimeout(() => {
    roomsTimer = 0;
    renderRooms();
  }, 250);
}

function insertMention(name) {
  const value = el.input.value;
  const lead = value && !/\s$/.test(value) ? " " : "";
  el.input.value = `${value}${lead}@${name} `;
  el.input.focus();
  const end = el.input.value.length;
  el.input.setSelectionRange(end, end);
  autoResizeInput();
  closeSidebar();
}

/* ---------- message body ---------- */

function parseFileBody(message) {
  try {
    const ref = JSON.parse(message.body);
    if (ref && typeof ref === "object" && typeof ref.id === "string") return ref;
  } catch {
    /* fall through */
  }
  return null;
}

function fileExt(name) {
  const match = /\.([a-z0-9]{1,6})$/i.exec(String(name || ""));
  return match ? match[1].toUpperCase() : "FILE";
}

function fileTypeClass(name) {
  const ext = fileExt(name).toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic"].includes(ext)) return "ft-image";
  if (["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz"].includes(ext)) return "ft-archive";
  if (["js", "mjs", "ts", "tsx", "jsx", "py", "go", "rs", "java", "c", "h", "cpp", "sh", "ps1", "json", "yml", "yaml", "html", "css"].includes(ext)) return "ft-code";
  if (["md", "txt", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv"].includes(ext)) return "ft-doc";
  return "ft-other";
}

function fileRoute(message) {
  if (message.to && message.to !== "all") {
    return `${labelOf(message.from)} → ${labelOf(message.to)}`;
  }
  return `${labelOf(message.from)} 发到本群`;
}

function fileCard(message) {
  const ref = parseFileBody(message);
  const card = document.createElement("div");
  card.className = "file-card";
  if (!ref) {
    const code = document.createElement("code");
    code.textContent = message.body;
    card.append(code);
    return card;
  }

  const head = document.createElement("div");
  head.className = "file-head";
  const route = document.createElement("span");
  route.className = "file-route";
  route.textContent = fileRoute(message);
  const kind = document.createElement("span");
  kind.textContent = "文件交接";
  const time = document.createElement("span");
  time.textContent = formatTime(message.ts);
  head.append(route, document.createTextNode("·"), kind, document.createTextNode("·"), time);

  const main = document.createElement("div");
  main.className = "file-main";
  const type = document.createElement("div");
  type.className = `file-type ${fileTypeClass(ref.name)}`;
  type.textContent = fileExt(ref.name);
  const info = document.createElement("div");
  info.className = "file-info";
  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = ref.name || ref.id;
  name.title = ref.name || ref.id;
  const sub = document.createElement("span");
  sub.className = "file-sub";
  sub.textContent = [formatBytes(ref.size), ref.id].filter(Boolean).join(" · ");
  info.append(name, sub);
  main.append(type, info);

  card.append(head, main);

  if (ref.note) {
    const note = document.createElement("p");
    note.className = "file-note";
    note.textContent = ref.note;
    card.append(note);
  }

  const foot = document.createElement("div");
  foot.className = "file-foot";
  const sha = document.createElement("span");
  sha.className = "file-sha";
  sha.textContent = ref.sha256 ? `sha256 ${ref.sha256.slice(0, 8)}…` : "";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "ghost-btn";
  copy.textContent = "复制 id";
  copy.addEventListener("click", () => copyText(ref.id, copy, "复制 id"));
  const download = document.createElement("button");
  download.type = "button";
  download.className = "ghost-btn";
  download.textContent = "下载";
  download.addEventListener("click", () => downloadFile(ref, download));
  foot.append(sha, copy, download);
  card.append(foot);
  return card;
}

function dataCard(message) {
  const card = document.createElement("div");
  card.className = "data-card";
  const code = document.createElement("code");
  code.textContent = message.body;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-btn";
  button.textContent = "复制路径";
  button.addEventListener("click", () => copyText(message.body, button, "复制路径"));
  card.append(code, button);
  return card;
}

async function downloadFile(ref, button) {
  button.textContent = "下载中…";
  try {
    const res = await fetch(`/files/${encodeURIComponent(ref.id)}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = ref.name || ref.id;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    button.textContent = "已保存";
  } catch (err) {
    button.textContent = "失败";
    setStatus(`下载失败：${err.message}`);
  }
  setTimeout(() => {
    button.textContent = "下载";
  }, 1600);
}

/* ---------- message rows ---------- */

function isGroupedWith(previous, message) {
  if (!previous || !message) return false;
  if (previous.type === "sys" || message.type === "sys") return false;
  if (previous.type === "file" || message.type === "file") return false;
  if (previous.type === "plan" || message.type === "plan") return false;
  if (previous.from !== message.from) return false;
  if (previous.topic !== message.topic) return false;
  if (dayKeyOf(previous.ts) !== dayKeyOf(message.ts)) return false;
  const delta = new Date(message.ts).getTime() - new Date(previous.ts).getTime();
  return Number.isFinite(delta) && delta >= 0 && delta < GROUP_WINDOW_MS;
}

function quoteEl(message) {
  const original = state.byId.get(message.reply_to);
  const quote = document.createElement("div");
  quote.className = original ? "quote" : "quote missing";
  quote.title = original ? "跳到原消息" : `原消息 #${message.reply_to} 不在当前窗口`;
  quote.addEventListener("click", () => scrollToMessage(message.reply_to));
  if (original) {
    const who = document.createElement("span");
    who.className = "quote-who";
    who.textContent = `${labelOf(original.from)}：`;
    const text = document.createElement("span");
    text.textContent = previewText(original, 60);
    quote.append(who, text);
  } else {
    quote.textContent = `回复 #${message.reply_to}`;
  }
  return quote;
}

function createMessageEl(message, { grouped = false, first = false } = {}) {
  const article = document.createElement("article");

  if (message.type === "sys") {
    article.className = "msg type-sys";
    article.id = `m-${message.id}`;
    const pill = document.createElement("p");
    pill.className = "sys-text";
    pill.textContent = message.body;
    article.append(pill);
    return article;
  }

  if (message.type === "plan") {
    article.className = "msg type-sys";
    article.id = `m-${message.id}`;
    const pill = document.createElement("p");
    pill.className = "sys-text";
    let planId = "";
    try {
      planId = JSON.parse(message.body)?.plan_id || "";
    } catch {
      planId = "";
    }
    pill.textContent = planId ? `分工卡 · ${planId}` : "分工卡";
    article.append(pill);
    return article;
  }

  const self = message.from === state.identity;
  article.className = [
    "msg",
    self ? "self" : "",
    grouped ? "grouped" : "",
    first ? "first" : "",
    `type-${message.type}`,
  ]
    .filter(Boolean)
    .join(" ");
  article.id = `m-${message.id}`;

  article.append(avatarEl(message.from));

  const content = document.createElement("div");
  content.className = "msg-content";

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  if (!self) {
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = labelOf(message.from);
    meta.append(who);
    if (state.activeTopic === "all") {
      const topic = document.createElement("span");
      topic.className = "topic";
      topic.textContent = `#${message.topic}`;
      meta.append(topic);
    }
    if (HOP_RE.test(String(message.body ?? "")) && message.from !== state.identity) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "模型生成";
      badge.title = "该回复由该身份的模型回合实时生成（[hop:N] 防循环标记）";
      meta.append(badge);
    }
  }
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = formatTime(message.ts);
  const action = document.createElement("button");
  action.type = "button";
  action.className = "msg-action";
  action.dataset.replyFor = String(message.id);
  action.textContent = "回复";
  meta.append(time, action);
  content.append(meta);

  if (message.type === "file") {
    if (message.reply_to) content.append(quoteEl(message));
    content.append(fileCard(message));
  } else if (message.type === "data") {
    if (message.reply_to) content.append(quoteEl(message));
    content.append(dataCard(message));
  } else {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (message.reply_to) bubble.append(quoteEl(message));
    appendMentions(bubble, message.body);
    content.append(bubble);
  }

  if (self) {
    const mentionsOthers = extractMentions(message.body).some((t) => t !== state.identity);
    if (mentionsOthers) {
      const status = document.createElement("div");
      status.dataset.statusFor = String(message.id);
      content.append(status);
      updateStatusNode(status, message);
    }
  }

  article.append(content);
  return article;
}

function addMessage(message) {
  if (!message || !Number.isInteger(message.id) || state.byId.has(message.id)) {
    return { added: false, kept: false, evicted: [], atEnd: false };
  }
  state.byId.set(message.id, message);

  let atEnd = true;
  const last = state.messages[state.messages.length - 1];
  if (!last || message.id > last.id) {
    state.messages.push(message);
  } else {
    let low = 0;
    let high = state.messages.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (state.messages[mid].id < message.id) low = mid + 1;
      else high = mid;
    }
    state.messages.splice(low, 0, message);
    atEnd = low === state.messages.length - 1;
  }

  const evicted = [];
  while (state.messages.length > 1000) {
    const removed = state.messages.shift();
    state.byId.delete(removed.id);
    evicted.push(removed);
  }
  return {
    added: true,
    kept: state.byId.has(message.id),
    evicted,
    atEnd,
  };
}

function visibleCount() {
  if (state.activeTopic === "all") return state.messages.length;
  let count = 0;
  for (const message of state.messages) {
    if (message.topic === state.activeTopic) count += 1;
  }
  return count;
}

function removeEvictedNodes(evicted) {
  for (const message of evicted) {
    const node = document.getElementById(`m-${message.id}`);
    if (!node) continue;
    const previous = node.previousElementSibling;
    const next = node.nextElementSibling;
    node.remove();
    if (previous && previous.classList.contains("day") && (!next || next.classList.contains("day"))) {
      previous.remove();
    }
  }
}

function appendMessages(messages, evicted) {
  const previousTop = el.messages.scrollTop;
  const previousHeight = el.messages.scrollHeight;
  removeEvictedNodes(evicted);
  const empty = el.messages.querySelector(".empty");
  if (empty) empty.remove();
  const fragment = document.createDocumentFragment();
  let previous = state.renderedLastMessage;
  for (const message of messages) {
    const grouped = isGroupedWith(previous, message);
    const node = createMessageEl(message, { grouped, first: Boolean(previous) && !grouped });
    node.classList.add("fresh"); // realtime appends only; full render stays still
    fragment.append(node);
    previous = message;
  }
  el.messages.append(fragment);
  state.renderedLastId = messages[messages.length - 1].id;
  state.renderedLastMessage = previous;
  el.roomMeta.textContent = `${visibleCount()} 条`;
  if (state.autoScroll) {
    scrollToBottom();
  } else {
    const added = el.messages.scrollHeight - previousHeight;
    scrollToOffset(previousTop + Math.max(0, added));
    noteBelowCount(messages.length);
  }
}

function clearPending() {
  pending = [];
  pendingEvicted = [];
  if (pendingFrame) {
    cancelAnimationFrame(pendingFrame);
    pendingFrame = 0;
  }
}

function flushPending() {
  pendingFrame = 0;
  const batch = pending;
  const evicted = pendingEvicted;
  pending = [];
  pendingEvicted = [];
  if (!batch.length) return;

  let lastId = state.renderedLastId;
  const appends = [];
  for (const message of batch) {
    if (!state.byId.has(message.id)) continue;
    const day = formatDate(message.ts);
    if (
      message.id <= lastId ||
      day !== state.renderedDay ||
      state.renderedTopic !== state.activeTopic ||
      (state.activeTopic !== "all" && message.topic !== state.activeTopic)
    ) {
      // Out of order, day rollover, or room change while queued: rebuild once.
      render();
      return;
    }
    appends.push(message);
    lastId = message.id;
  }
  if (!appends.length) {
    removeEvictedFromView(evicted);
    return;
  }
  appendMessages(appends, evicted);
}

function removeEvictedFromView(evicted) {
  if (!evicted.length) return;
  const previousTop = el.messages.scrollTop;
  const previousHeight = el.messages.scrollHeight;
  removeEvictedNodes(evicted);
  if (state.autoScroll) {
    scrollToBottom();
  } else {
    const added = el.messages.scrollHeight - previousHeight;
    scrollToOffset(previousTop + Math.max(0, added));
  }
  el.roomMeta.textContent = `${visibleCount()} 条`;
}

function emptyState() {
  const wrap = document.createElement("div");
  wrap.className = "empty";
  const card = document.createElement("div");
  card.className = "empty-card";
  card.append(avatarEl("all", "avatar-lg"));
  const title = document.createElement("strong");
  title.textContent = "还没有消息";
  const text = document.createElement("p");
  text.textContent = "发第一条消息，或者 @ 一个伙伴开始。";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button-primary";
  button.textContent = "发第一条消息";
  button.addEventListener("click", () => el.input.focus());
  card.append(title, text, button);
  wrap.append(card);
  return wrap;
}

function render() {
  clearPending();
  const previousTop = el.messages.scrollTop;
  const previousHeight = el.messages.scrollHeight;
  const visible =
    state.activeTopic === "all"
      ? state.messages
      : state.messages.filter((m) => m.topic === state.activeTopic);
  const fragment = document.createDocumentFragment();
  let lastDay = null;
  let previous = null;

  if (visible.length === 0) {
    fragment.append(emptyState());
  } else {
    for (const message of visible) {
      const day = formatDate(message.ts);
      if (day && day !== lastDay) {
        const divider = document.createElement("div");
        divider.className = "day";
        divider.textContent = day;
        fragment.append(divider);
        lastDay = day;
        previous = null;
      }
      const grouped = isGroupedWith(previous, message);
      fragment.append(createMessageEl(message, { grouped, first: Boolean(previous) && !grouped }));
      previous = message;
    }
  }

  el.messages.replaceChildren(fragment);
  state.renderedDay = lastDay;
  state.renderedLastId = visible.length ? visible[visible.length - 1].id : 0;
  state.renderedTopic = state.activeTopic;
  state.renderedLastMessage = previous;
  const room = ROOMS.find((r) => r.id === state.activeTopic) || ROOMS[0];
  el.roomTitle.textContent = room.label;
  el.roomSub.textContent = room.sub;
  el.roomMeta.textContent = `${visible.length} 条`;
  state.newBelow = 0;
  updateJumpBadge();
  if (state.autoScroll) {
    scrollToBottom();
  } else {
    // Keep the reading position anchored when new messages arrive below.
    const added = el.messages.scrollHeight - previousHeight;
    scrollToOffset(previousTop + Math.max(0, added));
  }
}

function setConn(text, kind) {
  el.connText.textContent = text;
  el.connDot.className = `dot${kind ? ` ${kind}` : ""}`;
}

function setStatus(text) {
  el.sendStatus.textContent = text;
}

function isNearBottom() {
  return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 120;
}

// While an IME composition is in progress the Enter/Escape keys belong to the
// input method (confirming candidates, cancelling composition), never to the
// composer. keyCode 229 is the legacy composition signal on some browsers.
function isComposing(event) {
  return event.isComposing === true || event.keyCode === 229;
}

function updateJumpBadge() {
  if (!el.jumpCount) return;
  const count = state.newBelow;
  el.jumpCount.hidden = count <= 0;
  el.jumpCount.textContent = count > 99 ? "99+" : count > 0 ? String(count) : "";
  if (el.jumpBtn) {
    el.jumpBtn.setAttribute(
      "aria-label",
      count > 0 ? `回到底部，${count > 99 ? "99+" : count} 条新消息` : "回到底部，看最新消息",
    );
  }
}

function jumpToLatest() {
  state.autoScroll = true;
  state.newBelow = 0;
  updateJumpBadge();
  el.jumpBtn.hidden = true;
  scrollToBottom();
}

function noteBelowCount(n) {
  if (state.autoScroll || n <= 0) return;
  state.newBelow += n;
  updateJumpBadge();
  el.jumpBtn.hidden = false;
}

// Programmatic scrolls must bypass CSS scroll-behavior:smooth — a smooth jump
// over 1000 content-visibility rows gets aborted by the layout shifts it
// triggers and can land nowhere. scrollIntoView({behavior:"smooth"}) for
// user-facing jumps stays as-is.
function scrollToBottom() {
  el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: "instant" });
}

function scrollToOffset(top) {
  el.messages.scrollTo({ top, behavior: "instant" });
}

function scrollToMessage(id) {
  const target = document.getElementById(`m-${id}`);
  if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
}

function previewForReply(message, max = 28) {
  return `#${message.id} ${labelOf(message.from)}：${previewText(message, max)}`;
}

function startReply(message) {
  state.replyTo = message.id;
  el.replyChipText.textContent = `回复 ${previewForReply(message)}`;
  el.replyChip.hidden = false;
  if (message.from !== state.identity) {
    const re = mentionRegex(message.from);
    if (re && !re.test(el.input.value)) {
      el.input.value = `@${message.from} ${el.input.value}`;
    }
  }
  el.input.focus();
  const end = el.input.value.length;
  el.input.setSelectionRange(end, end);
  autoResizeInput();
}

function cancelReply() {
  state.replyTo = null;
  el.replyChip.hidden = true;
  el.replyChipText.textContent = "";
}

function renderFileChips() {
  const fragment = document.createDocumentFragment();
  pendingFiles.forEach((file, index) => {
    const chip = document.createElement("span");
    chip.className = "file-chip";
    const name = document.createElement("span");
    name.className = "file-chip-name";
    name.textContent = file.name;
    name.title = file.name;
    const size = document.createElement("span");
    size.className = "file-chip-size";
    size.textContent = formatBytes(file.size);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "file-chip-remove";
    remove.setAttribute("aria-label", `移除 ${file.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      pendingFiles.splice(index, 1);
      renderFileChips();
      refreshAttachStatus();
    });
    chip.append(name, size, remove);
    fragment.append(chip);
  });
  el.fileChips.replaceChildren(fragment);
  el.fileChips.hidden = pendingFiles.length === 0;
}

function refreshAttachStatus() {
  if (pendingFiles.length === 1) {
    setStatus(`已选 ${pendingFiles[0].name}（${formatBytes(pendingFiles[0].size)}）`);
  } else if (pendingFiles.length > 1) {
    setStatus(`已选 ${pendingFiles.length} 个文件`);
  } else {
    setStatus("");
  }
}

function addFiles(list) {
  for (const file of list) pendingFiles.push(file);
  renderFileChips();
  refreshAttachStatus();
}

function hasFileDrag(event) {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

function bindDragDrop() {
  let depth = 0;
  window.addEventListener("dragenter", (event) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    depth += 1;
    el.dropOverlay.hidden = false;
  });
  window.addEventListener("dragover", (event) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", () => {
    if (el.dropOverlay.hidden) return;
    depth = Math.max(0, depth - 1);
    if (!depth) el.dropOverlay.hidden = true;
  });
  window.addEventListener("drop", (event) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    depth = 0;
    el.dropOverlay.hidden = true;
    addFiles(event.dataTransfer.files);
  });
}

async function copyText(text, button, restore = "复制") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  button.textContent = "已复制";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    button.textContent = restore;
  }, 1200);
}

function autoResizeInput() {
  if (!el.input) return;
  el.input.style.height = "auto";
  const next = Math.min(MAX_INPUT_HEIGHT, el.input.scrollHeight);
  el.input.style.height = `${Math.max(26, next)}px`;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    showTokenModal("token 无效或缺失，请重新粘贴。");
    throw new Error("unauthorized");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `HTTP ${response.status}`);
  }
  return data;
}

async function pollPresence() {
  if (!state.token) return;
  try {
    const res = await fetch("/presence", {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.presence = new Map((data.identities ?? []).map((entry) => [entry.identity, entry]));
    state.presenceKnown = true;
  } catch {
    state.presenceKnown = false;
  }
  renderPeople();
  updateStatuses();
}

async function uploadFile(file, note, topic, replyTo = null) {
  setStatus(`上传中 ${file.name}…`);
  const res = await fetch(
    `/files/upload?name=${encodeURIComponent(file.name)}&from=${encodeURIComponent(state.identity)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${state.token}`, "Content-Type": "application/octet-stream" },
      body: file,
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `上传失败 HTTP ${res.status}`);
  return api("/send", {
    method: "POST",
    body: JSON.stringify({
      from: state.identity,
      topic,
      type: "file",
      body: JSON.stringify({
        id: data.file.id,
        name: data.file.name,
        size: data.file.size,
        sha256: data.file.sha256,
        note: note || "",
      }),
      reply_to: replyTo,
    }),
  });
}

function onMessage(message) {
  const result = addMessage(message);
  if (!result.added) return;
  if (message.id > state.lastId) state.lastId = message.id;
  if (mentionState) updateMentionMenu();
  scheduleRooms();

  if (state.activeTopic !== "all" && message.topic !== state.activeTopic) {
    if (message.from !== state.identity) {
      state.unread.set(message.topic, (state.unread.get(message.topic) || 0) + 1);
    }
    removeEvictedFromView(result.evicted);
    renderRooms();
    // A reply may target a message rendered in this room's status lines.
    updateStatuses();
    return;
  }

  if (!result.kept) return;

  const day = formatDate(message.ts);
  if (
    result.atEnd &&
    state.renderedTopic === state.activeTopic &&
    state.renderedLastId < message.id &&
    day === state.renderedDay &&
    (state.activeTopic === "all" || message.topic === state.activeTopic)
  ) {
    pending.push(message);
    for (const evicted of result.evicted) pendingEvicted.push(evicted);
    if (!pendingFrame) pendingFrame = requestAnimationFrame(flushPending);
  } else {
    render();
  }
  // A new reply flips the original message's status line to 已回复.
  if (message.reply_to || isWakeMessage(message)) updateStatuses();
}

async function loadHistory(topic) {
  const data = await api(`/messages?limit=100&topic=${encodeURIComponent(topic)}`);
  for (const message of data.messages || []) addMessage(message);
  if (Number.isInteger(data.last_id)) state.lastId = Math.max(state.lastId, data.last_id);
  state.loaded.add(topic);
  render();
  renderRooms();
}

async function switchRoom(topic) {
  closeMentionMenu();
  cancelReply();
  state.activeTopic = topic;
  state.unread.delete(topic);
  state.autoScroll = true;
  renderRooms();
  if (!state.loaded.has(topic)) {
    try {
      await loadHistory(topic);
    } catch (err) {
      setStatus(err.message);
    }
  } else {
    render();
  }
  closeSidebar();
}

function openSidebar() {
  el.sidebar.classList.add("open");
  el.scrim.hidden = false;
  el.menu.setAttribute("aria-expanded", "true");
}

function closeSidebar() {
  el.sidebar.classList.remove("open");
  el.scrim.hidden = true;
  el.menu.setAttribute("aria-expanded", "false");
}

function toggleSidebar() {
  if (el.sidebar.classList.contains("open")) closeSidebar();
  else openSidebar();
}

/* ---------- desktop sidebar rail (>=761px) ---------- */

function sideCollapsed() {
  return document.documentElement.classList.contains("side-collapsed");
}

function setSideCollapsed(collapsed, persist = true) {
  document.documentElement.classList.toggle("side-collapsed", collapsed);
  if (el.sideToggle) {
    const label = collapsed ? "展开侧边栏" : "收起侧边栏";
    el.sideToggle.setAttribute("aria-expanded", String(!collapsed));
    el.sideToggle.setAttribute("aria-label", label);
    el.sideToggle.title = label;
  }
  if (persist) {
    try {
      localStorage.setItem(SIDE_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* storage can be unavailable (private mode); the toggle still works */
    }
  }
}

function toggleSideCollapsed() {
  setSideCollapsed(!sideCollapsed());
}

function connect() {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  if (!state.token) return;

  const since = state.lastId || 0;
  const source = new EventSource(
    `/stream?since=${since}&token=${encodeURIComponent(state.token)}&identity=${encodeURIComponent(state.identity)}`,
  );
  state.es = source;
  setConn("连接中", "retry");

  source.onopen = () => {
    state.connected = true;
    state.failures = 0;
    setConn("已连接", "online");
    el.tokenBtn.hidden = true;
    pollPresence();
  };

  source.onerror = () => {
    state.connected = false;
    state.failures += 1;
    setConn(state.failures >= 3 ? "连接失败" : "重连中", "retry");
    if (state.failures >= 3) el.tokenBtn.hidden = false;
  };

  source.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message && Number.isInteger(message.id)) onMessage(message);
    } catch {
      /* ignore malformed event */
    }
  };
}

function readToken() {
  const injected = window.__MSGHUB_TOKEN__;
  if (typeof injected === "string" && injected && injected !== "__MSGHUB_TOKEN_JSON__") {
    return injected;
  }
  const stored = localStorage.getItem("msghub.token");
  if (stored) return stored;
  const url = new URL(window.location.href);
  const queryToken = url.searchParams.get("token");
  if (queryToken) {
    localStorage.setItem("msghub.token", queryToken);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    return queryToken;
  }
  return "";
}

function showTokenModal(message) {
  el.tokenMessage.textContent =
    message || "从 data/token.txt 读取后粘贴到这里。token 只保存在本机浏览器。";
  el.tokenModal.hidden = false;
  el.tokenInput.focus();
}

function hideTokenModal() {
  el.tokenModal.hidden = true;
}

async function saveToken() {
  closeMentionMenu();
  const token = el.tokenInput.value.trim();
  if (!token) return;
  state.token = token;
  localStorage.setItem("msghub.token", token);
  hideTokenModal();

  if (state.es) {
    state.es.close();
    state.es = null;
  }
  state.messages = [];
  state.byId.clear();
  state.lastId = 0;
  state.loaded.clear();
  state.unread.clear();
  state.failures = 0;
  state.autoScroll = true;
  renderRooms();
  render();

  try {
    // Do not call boot() here: the loopback page has an injected token that
    // would override the token the user just pasted.
    await loadHistory("all");
    connect();
  } catch (err) {
    setConn("未连接", "");
    if (err.message !== "unauthorized") setStatus(err.message);
  }
}

function sendMessage(event) {
  event.preventDefault();
  closeMentionMenu();
  const identity = el.identity.value.trim();
  if (!IDENTITY_RE.test(identity)) {
    setStatus("身份只能用小写字母/数字/-/_，首尾必须是字母或数字");
    return;
  }
  state.identity = identity;
  localStorage.setItem("msghub.identity", identity);
  updateMeAvatar();

  const topic = state.activeTopic === "all" ? "daily" : state.activeTopic;
  const files = [...pendingFiles];
  const note = el.input.value.trim();

  if (files.length) {
    el.send.disabled = true;
    setStatus(files.length > 1 ? `上传 ${files.length} 个文件…` : "发送中…");
    (async () => {
      for (const [index, file] of files.entries()) {
        await uploadFile(file, files.length === 1 ? note : "", topic, index === 0 ? state.replyTo : null);
      }
      pendingFiles = [];
      renderFileChips();
      el.input.value = "";
      el.fileInput.value = "";
      autoResizeInput();
      cancelReply();
      setStatus("");
      state.autoScroll = true;
    })()
      .catch((err) => setStatus(err.message))
      .finally(() => {
        el.send.disabled = false;
      });
    return;
  }

  const body = note;
  if (!body) return;
  el.send.disabled = true;
  setStatus("发送中…");

  api("/send", {
    method: "POST",
    body: JSON.stringify({ from: identity, topic, body, type: "chat", reply_to: state.replyTo || null }),
  })
    .then((data) => {
      el.input.value = "";
      autoResizeInput();
      cancelReply();
      setStatus("");
      state.autoScroll = true;
      if (data.message) onMessage(data.message);
    })
    .catch((err) => setStatus(err.message))
    .finally(() => {
      el.send.disabled = false;
    });
}

async function boot() {
  renderRooms();
  renderPeople();
  state.token = readToken();
  if (!state.token) {
    showTokenModal();
    setConn("未连接", "");
    return;
  }

  const savedIdentity = localStorage.getItem("msghub.identity");
  state.identity = savedIdentity && IDENTITY_RE.test(savedIdentity) ? savedIdentity : "";
  el.identity.value = state.identity;
  updateMeAvatar();

  try {
    await loadHistory("all");
  } catch (err) {
    if (err.message !== "unauthorized") setStatus(err.message);
    return;
  }
  connect();
  pollPresence();
}

function bind() {
  el.rooms = $("rooms");
  el.people = $("people");
  el.messages = $("messages");
  el.roomTitle = $("room-title");
  el.roomSub = $("room-sub");
  el.roomMeta = $("room-meta");
  el.connDot = $("conn-dot");
  el.connText = $("conn-text");
  el.meAvatar = $("me-avatar");
  el.meName = $("me-name");
  el.meEdit = $("me-edit");
  el.sideFoot = document.querySelector(".side-foot");
  el.sideToggle = $("side-toggle");
  el.tokenBtn = $("token-btn");
  el.sidebar = $("sidebar");
  el.scrim = $("scrim");
  el.menu = $("menu");
  el.search = $("room-search");
  el.identity = $("identity");
  el.input = $("input");
  el.mentionMenu = $("mention-menu");
  el.send = $("send");
  el.sendStatus = $("send-status");
  el.fileInput = $("file-input");
  el.attachBtn = $("attach-btn");
  el.replyChip = $("reply-chip");
  el.replyChipText = $("reply-chip-text");
  el.fileChips = $("file-chips");
  el.dropOverlay = $("drop-overlay");
  el.jumpBtn = $("jump-latest");
  el.jumpCount = $("jump-count");
  el.tokenModal = $("token-modal");
  el.tokenMessage = $("token-message");
  el.tokenInput = $("token-input");

  el.input.setAttribute("aria-autocomplete", "list");
  el.input.setAttribute("aria-controls", "mention-menu");
  el.input.setAttribute("aria-expanded", "false");
  el.input.setAttribute("aria-haspopup", "listbox");

  $("composer").addEventListener("submit", sendMessage);
  el.menu.addEventListener("click", toggleSidebar);
  el.sideToggle.addEventListener("click", toggleSideCollapsed);
  // Sync aria/title with the state the early head script already applied;
  // do not rewrite localStorage.
  setSideCollapsed(sideCollapsed(), false);
  el.scrim.addEventListener("click", closeSidebar);
  el.search.addEventListener("input", () => applySearch(el.search.value));
  el.tokenBtn.addEventListener("click", () => showTokenModal());
  $("token-save").addEventListener("click", saveToken);
  el.tokenInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveToken();
    }
  });
  // The token dialog is aria-modal: trap Tab inside it, and allow Escape only
  // when a token already exists (with none, the dialog is the only way in).
  el.tokenModal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (state.token) hideTokenModal();
      return;
    }
    if (event.key !== "Tab") return;
    const first = el.tokenInput;
    const last = $("token-save");
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  el.attachBtn.addEventListener("click", () => el.fileInput.click());
  el.fileInput.addEventListener("change", () => {
    addFiles(el.fileInput.files);
    el.fileInput.value = "";
  });
  $("reply-cancel").addEventListener("click", cancelReply);
  bindDragDrop();
  // Status lines are rebuilt in place; clicks are delegated.
  el.messages.addEventListener("click", (event) => {
    const replyTarget = event.target.closest?.("[data-reply-for]");
    if (replyTarget) {
      const message = state.byId.get(Number(replyTarget.dataset.replyFor));
      if (message) startReply(message);
      return;
    }
    const node = event.target.closest?.("[data-status-for]");
    if (node?.dataset.jump) scrollToMessage(Number(node.dataset.jump));
  });
  el.identity.addEventListener("change", () => {
    const identity = el.identity.value.trim();
    if (IDENTITY_RE.test(identity)) {
      state.identity = identity;
      localStorage.setItem("msghub.identity", identity);
      updateMeAvatar();
      closeMentionMenu();
      render();
      renderPeople();
      connect(); // re-register presence under the new identity
    }
  });
  el.meEdit.addEventListener("click", () => setIdentityEditing(true));
  el.identity.addEventListener("blur", () => setIdentityEditing(false, false));
  el.identity.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      el.identity.blur(); // fires `change`, which validates and saves
      setIdentityEditing(false, false);
    } else if (event.key === "Escape") {
      event.preventDefault();
      el.identity.value = state.identity; // revert; same value = no change event
      el.identity.blur();
      setIdentityEditing(false, false);
    }
  });
  el.input.addEventListener("keydown", (event) => {
    // IME composition owns Enter/Escape; never treat them as send/cancel.
    if (isComposing(event)) return;
    if (handleMentionKey(event)) return;
    if (event.key === "Escape" && state.replyTo) {
      cancelReply();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage(event);
    }
  });
  el.input.addEventListener("input", () => {
    autoResizeInput();
    updateMentionMenu();
  });
  el.input.addEventListener("click", updateMentionMenu);
  el.input.addEventListener("keyup", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      updateMentionMenu();
    }
  });
  el.input.addEventListener("blur", () => setTimeout(closeMentionMenu, 0));
  el.messages.addEventListener("scroll", () => {
    state.autoScroll = isNearBottom();
    if (state.autoScroll && state.newBelow) {
      state.newBelow = 0;
      updateJumpBadge();
    }
    el.jumpBtn.hidden = state.autoScroll;
  });
  el.jumpBtn.addEventListener("click", jumpToLatest);
  window.addEventListener("keydown", (event) => {
    if (isComposing(event)) return;
    if (event.key === "Escape") closeSidebar();
  });
  window.addEventListener("beforeunload", () => {
    if (state.es) state.es.close();
  });
  setInterval(pollPresence, 4000);
  autoResizeInput();
}

document.addEventListener("DOMContentLoaded", () => {
  bind();
  boot().catch((err) => setStatus(err.message));
});
