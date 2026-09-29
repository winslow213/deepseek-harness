/**
 * Browser pages the team shell serves itself: the unauthenticated entry pages
 * (login, registration) and the signed-in account pages (password change), plus
 * the account service's operator approval pages. They share one dark-theme
 * stylesheet so the entry host looks like one product.
 *
 * Every page is self-contained HTML with inline CSS and no external assets: the
 * entry host is on a LAN with no CDN reachability, and the operator approval
 * pages must render on whatever device opens the notification link.
 *
 * @module dsh-team-shell/team-pages
 */

import { readFileSync } from 'node:fs'
import { escapeHtml } from './html.ts'

/**
 * The Feishu feedback QR card shipped beside the login form, inlined as a
 * base64 data URI at module load so every page stays one self-contained
 * document with no external asset fetch.
 */
const FEEDBACK_QR_PNG = readFileSync(new URL('./feedback-qr.png', import.meta.url))

/** Shared dark-theme stylesheet: star field, glass card, form controls. */
const THEME_CSS = `
  :root { color-scheme: dark; }
  body {
    font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    margin: 0; min-height: 100vh; color: #e8edf7;
    background: radial-gradient(ellipse at 50% 120%, #0b1e3f 0%, #060a18 60%, #04060f 100%);
    display: grid; place-items: center; overflow: hidden;
  }
  /* star field */
  .stars { position: fixed; inset: 0; background-image:
      radial-gradient(1px 1px at 20% 30%, #fff8, transparent),
      radial-gradient(1px 1px at 70% 20%, #fff6, transparent),
      radial-gradient(1.5px 1.5px at 40% 70%, #aebfff, transparent),
      radial-gradient(1px 1px at 85% 60%, #fff9, transparent),
      radial-gradient(1px 1px at 10% 85%, #fff5, transparent),
      radial-gradient(1.5px 1.5px at 60% 90%, #8fa8ff, transparent),
      radial-gradient(1px 1px at 30% 45%, #ffffff88, transparent),
      radial-gradient(1px 1px at 90% 15%, #ffffff66, transparent);
    pointer-events: none; }
  .card {
    position: relative; z-index: 1; width: 22rem; text-align: center;
    background: rgba(13, 24, 54, .55); border: 1px solid rgba(120, 160, 255, .25);
    border-radius: 16px; padding: 2.6rem 2.2rem 2.2rem; backdrop-filter: blur(8px);
    box-shadow: 0 0 60px rgba(30, 70, 200, .25);
  }
  .card.wide { width: 30rem; }
  .brand { font-size: 2.1rem; font-weight: 700; letter-spacing: .3em; margin: 0 0 .3rem;
    background: linear-gradient(120deg, #8ab6ff, #dfe9ff, #7fa0ff);
    -webkit-background-clip: text; background-clip: text; color: transparent; }
  .tagline { font-size: .82rem; color: #93a4cc; margin: 0 0 2rem; letter-spacing: .08em; }
  form { text-align: left; }
  label { display: block; margin: .9rem 0 .3rem; font-size: .85rem; color: #b8c6e2; }
  input {
    width: 100%; box-sizing: border-box; padding: .65rem .8rem;
    background: rgba(255,255,255,.05); border: 1px solid rgba(140,170,255,.3);
    border-radius: 8px; color: #eef2fb; font-size: .95rem; outline: none;
  }
  input:focus { border-color: #6f9bff; box-shadow: 0 0 0 3px rgba(111,155,255,.15); }
  button {
    width: 100%; margin-top: 1.6rem; padding: .7rem; border: 0; border-radius: 8px;
    background: linear-gradient(120deg, #2f6bff, #5b8cff); color: #fff;
    font-size: .98rem; letter-spacing: .2em; cursor: pointer; transition: filter .15s;
  }
  button:hover { filter: brightness(1.12); }
  button.danger { background: linear-gradient(120deg, #a63a3a, #c85a5a); }
  button.link { width: auto; margin: 0; padding: 0; background: none; color: #8ab6ff;
    font-size: .85rem; letter-spacing: 0; text-decoration: underline; }
  button.link:hover { filter: brightness(1.2); }
  #err { color: #ff7d7d; min-height: 1em; font-size: .85rem; margin-top: .8rem; text-align: center; }
  .ok { color: #7fe0a8; }
  .note { font-size: .8rem; color: #93a4cc; line-height: 1.7; margin: 1.2rem 0 0; text-align: left; }
  .row { display: flex; gap: .6rem; }
  .row button { margin-top: 1.6rem; }
  .mono { font-family: ui-monospace, Menlo, Consolas, monospace; color: #dfe9ff; }
  .footer { margin: 1.4rem 0 0; font-size: .82rem; color: #93a4cc; }
  .footer a { color: #8ab6ff; text-decoration: none; }
  .footer a:hover { text-decoration: underline; }
  .feedback { margin: 1.6rem 0 0; padding-top: 1.4rem; border-top: 1px solid rgba(120, 160, 255, .18); }
  .feedback img {
    width: 220px; border-radius: 10px; background: #fff; padding: 6px;
    box-sizing: border-box; box-shadow: 0 0 24px rgba(30, 70, 200, .2);
  }
  .feedbackTitle { font-size: .85rem; color: #b8c6e2; margin: .8rem 0 0; }
  .feedbackHint { font-size: .75rem; color: #93a4cc; margin: .25rem 0 0; }
  /* message center */
  .card.inbox { width: 58rem; max-width: 96vw; height: 42rem; max-height: 90vh;
    text-align: left; display: flex; flex-direction: column; }
  .card.inbox .brand, .card.inbox .tagline { text-align: center; }
  .cols { display: flex; gap: 1rem; flex: 1; min-height: 0; margin-top: .6rem; }
  #side { width: 15rem; flex-shrink: 0; overflow-y: auto; padding-right: .4rem; }
  .contact { padding: .5rem .6rem; border-radius: 8px; cursor: pointer; }
  .contact:hover { background: rgba(255,255,255,.05); }
  .contact.active { background: rgba(47,107,255,.18); }
  .contact .nm { font-size: .85rem; color: #e8edf7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .contact.fresh .nm::after { content: ' ●'; color: #5b8cff; font-size: .6rem; }
  .contact .pv { font-size: .72rem; color: #93a4cc; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; margin-top: .1rem; }
  .main { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .thread { flex: 1; overflow-y: auto; padding: .4rem .2rem; }
  .thread .hint { color: #93a4cc; font-size: .85rem; text-align: center; margin-top: 2rem; }
  .msg { max-width: 70%; margin: .35rem 0; padding: .45rem .7rem; border-radius: 10px;
    font-size: .88rem; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
  .msg.them { background: rgba(255,255,255,.07); }
  .msg.me { background: rgba(47,107,255,.28); margin-left: auto; }
  .msg .mt { display: block; font-size: .68rem; color: #93a4cc; margin-bottom: .15rem; }
  .msg .tag { display: inline-block; margin-left: .35rem; padding: 0 .3rem;
    border: 1px solid rgba(140,170,255,.4); border-radius: 4px; color: #8ab6ff; font-size: .62rem; }
  .composer { display: flex; gap: .6rem; margin-top: .8rem; align-items: flex-end; }
  .composer textarea { flex: 1; resize: none; box-sizing: border-box; padding: .6rem .8rem;
    background: rgba(255,255,255,.05); border: 1px solid rgba(140,170,255,.3); border-radius: 8px;
    color: #eef2fb; font-size: .92rem; font-family: inherit; outline: none; }
  .composer textarea:focus { border-color: #6f9bff; box-shadow: 0 0 0 3px rgba(111,155,255,.15); }
  .composer button { width: auto; margin: 0; padding: .65rem 1.4rem; flex-shrink: 0; }
`

/** Wrap page body content in the shared document shell. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>${THEME_CSS}</style></head>
<body>
<div class="stars"></div>
${body}
</body></html>`
}

/** The entry login page, served when a request carries no valid session. */
export const LOGIN_PAGE = page('天问星 · 登录', `<div class="card">
  <h1 class="brand">天问星</h1>
  <p class="tagline">鸿蒙科专用 Agent 赋能研发平台</p>
  <form id="f">
    <label for="u">用户名</label><input id="u" autocomplete="username" required>
    <label for="p">密码</label><input id="p" type="password" autocomplete="current-password" required>
    <button type="submit">登 录</button>
    <div id="err"></div>
  </form>
  <p class="footer">还没有账号？<a href="/register">申请注册</a></p>
  <div class="feedback">
    <img src="data:image/png;base64,${FEEDBACK_QR_PNG.toString('base64')}" alt="天问星使用反馈二维码">
    <p class="feedbackTitle">使用问题反馈</p>
    <p class="feedbackHint">扫码加入反馈群，使用中遇到问题随时提</p>
  </div>
</div>
<script>
const f = document.getElementById('f')
f.addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = document.getElementById('err')
  err.textContent = ''
  try {
    const r = await fetch('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: document.getElementById('u').value, password: document.getElementById('p').value }),
    })
    if (!r.ok) { err.textContent = '用户名或密码错误'; return }
    window.location.href = '/'
  } catch { err.textContent = '网络错误' }
})
</script>`)

/**
 * Self-service registration page. Collects the work email only; the account
 * name is derived from the mail address so the applicant never chooses it.
 * Success is not account creation — the operator approves on Feishu first, so
 * the page states the default password up front and never claims an account
 * exists yet.
 * @param domains - accepted email domains, rendered as the form's hint.
 * @param defaultPassword - the shared password issued on approval.
 * @returns the registration page HTML.
 */
export function registerPage(domains: readonly string[], defaultPassword: string): string {
  const hint = domains.length === 0 ? '任意邮箱' : domains.map(d => `@${d}`).join(' / ')
  return page('天问星 · 申请注册', `<div class="card">
  <h1 class="brand">天问星</h1>
  <p class="tagline">申请开通账号</p>
  <form id="f">
    <label for="e">工作邮箱</label><input id="e" type="email" autocomplete="email" placeholder="name@${domains[0] ?? 'example.com'}" required>
    <label for="n">姓名（可选）</label><input id="n" autocomplete="name">
    <button type="submit">提交申请</button>
    <div id="err"></div>
  </form>
  <p class="note">
    用户名取邮箱 @ 前面的一段，提交后由管理员审批，审批通过即可登录。<br>
    初始密码统一为 <span class="mono">${escapeHtml(defaultPassword)}</span>，登录后请到 <a href="/password">/password</a> 修改。<br>
    可接受的邮箱：${escapeHtml(hint)}
  </p>
  <p class="footer"><a href="/">返回登录</a></p>
</div>
<script>
const f = document.getElementById('f')
f.addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = document.getElementById('err')
  err.textContent = ''
  const email = document.getElementById('e').value.trim()
  const name = document.getElementById('n').value.trim()
  try {
    const r = await fetch('/api/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(name === '' ? { email } : { email, name }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) { err.textContent = body.error || '提交失败'; return }
    f.innerHTML = '<p class="note ok" style="text-align:center">申请已提交，等待管理员审批。<br>'
      + '用户名：<span class="mono">' + body.username + '</span><br>'
      + '审批通过后用初始密码登录即可。</p>'
      + '<p class="footer" style="text-align:center"><a href="/">返回登录</a></p>'
  } catch { err.textContent = '网络错误' }
})
</script>`)
}

/**
 * Signed-in password change page. Prompts for the current password as well as
 * the new one, so a stolen session cookie alone cannot take over an account.
 * @param username - the signed-in account name, shown for confirmation.
 * @returns the password page HTML.
 */
export function changePasswordPage(username: string): string {
  return page('天问星 · 修改密码', `<div class="card">
  <h1 class="brand">天问星</h1>
  <p class="tagline">修改密码 · ${escapeHtml(username)}</p>
  <form id="f">
    <label for="c">当前密码</label><input id="c" type="password" autocomplete="current-password" required>
    <label for="p">新密码</label><input id="p" type="password" autocomplete="new-password" required>
    <label for="p2">确认新密码</label><input id="p2" type="password" autocomplete="new-password" required>
    <button type="submit">确认修改</button>
    <div id="err"></div>
  </form>
  <p class="footer"><a href="/">返回工作台</a></p>
</div>
<script>
const f = document.getElementById('f')
f.addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = document.getElementById('err')
  err.textContent = ''
  const current = document.getElementById('c').value
  const next = document.getElementById('p').value
  const again = document.getElementById('p2').value
  if (next !== again) { err.textContent = '两次输入的新密码不一致'; return }
  try {
    const r = await fetch('/api/me/password', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) { err.textContent = body.error || '修改失败'; return }
    f.innerHTML = '<p class="note ok" style="text-align:center">密码已修改。</p>'
      + '<p class="footer" style="text-align:center"><a href="/">返回工作台</a></p>'
  } catch { err.textContent = '网络错误' }
})
</script>`)
}

/**
 * The signed-in member's message center: a contact sidebar ordered by recent
 * activity, a thread pane, and a composer. One polling script drives it —
 * contacts and history come from the account service's message API, and every
 * dynamic value is inserted via textContent so message bodies never render as
 * HTML. The composer posts the same API; the reply appears once the sender's
 * own fetch archives the sent copy.
 * @param username - the signed-in member's account name, shown as the identity.
 * @returns the inbox page HTML.
 */
export function inboxPage(username: string): string {
  const me = JSON.stringify(username).replace(/</gu, '\\u003c')
  return page('天问星 · 消息中心', `<div class="card inbox">
  <h1 class="brand">消息中心</h1>
  <p class="tagline">消息中心 · ${escapeHtml(username)} · <a href="/">返回工作台</a></p>
  <div id="err"></div>
  <div class="cols">
    <nav id="side" aria-label="联系人"></nav>
    <section class="main">
      <div id="thread" class="thread"></div>
      <div class="composer">
        <textarea id="body" rows="3" placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"></textarea>
        <button id="send" type="button">发送</button>
      </div>
    </section>
  </div>
</div>
<script>
var me = ${me}
var contacts = [], messages = [], sel = null, fresh = new Set()
function cp(m) { return m.from === me ? m.to : m.from }
function pad(n) { return (n < 10 ? '0' : '') + n }
function fmt(ts) {
  var d = new Date(ts)
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}
function label(u) {
  for (var i = 0; i < contacts.length; i++) {
    if (contacts[i].username === u) return contacts[i].displayName ? contacts[i].displayName + ' (' + u + ')' : u
  }
  return u
}
async function api(path, opts) {
  var r = await fetch(path, opts)
  if (r.status === 401) { window.location.href = '/'; throw new Error('登录已过期') }
  return r
}
async function loadContacts() {
  var r = await api('/api/messages/contacts')
  var d = await r.json()
  contacts = d.contacts || []
  renderSide()
}
async function refresh() {
  var r = await api('/api/messages?limit=200')
  var d = await r.json()
  var prevTop = 0
  for (var i = 0; i < messages.length; i++) prevTop = Math.max(prevTop, messages[i].ts)
  messages = d.messages || []
  for (var j = 0; j < messages.length; j++) {
    if (messages[j].ts > prevTop) {
      var c = cp(messages[j])
      if (c !== sel) fresh.add(c)
    }
  }
  renderSide()
  renderThread()
}
function threads() {
  var map = Object.create(null)
  for (var i = 0; i < messages.length; i++) {
    var c = cp(messages[i])
    if (!map[c]) map[c] = []
    map[c].push(messages[i])
  }
  var list = []
  for (var k in map) list.push({ user: k, last: map[k][map[k].length - 1].ts, msgs: map[k] })
  list.sort(function (a, b) { return b.last - a.last })
  return list
}
function renderSide() {
  var side = document.getElementById('side')
  side.textContent = ''
  var ths = threads(), seen = Object.create(null)
  function addItem(u, last) {
    var d = document.createElement('div')
    d.className = 'contact' + (u === sel ? ' active' : '') + (fresh.has(u) ? ' fresh' : '')
    var nm = document.createElement('div')
    nm.className = 'nm'
    nm.textContent = u === me ? u + '（我）' : label(u)
    d.appendChild(nm)
    if (last) {
      var pv = document.createElement('div')
      pv.className = 'pv'
      pv.textContent = fmt(last.ts) + ' ' + last.body.replace(/\s+/g, ' ').slice(0, 24)
      d.appendChild(pv)
    }
    d.addEventListener('click', function () {
      sel = u
      fresh.delete(u)
      renderSide()
      renderThread()
      document.getElementById('body').focus()
    })
    seen[u] = true
    side.appendChild(d)
  }
  for (var t = 0; t < ths.length; t++) addItem(ths[t].user, ths[t].msgs[ths[t].msgs.length - 1])
  for (var c = 0; c < contacts.length; c++) {
    var u2 = contacts[c].username
    if (!seen[u2] && u2 !== me) addItem(u2, null)
  }
}
function renderThread() {
  var thread = document.getElementById('thread')
  thread.textContent = ''
  if (sel === null) {
    var p = document.createElement('p')
    p.className = 'hint'
    p.textContent = '从左侧选择一位成员开始对话'
    thread.appendChild(p)
    return
  }
  var arr = []
  for (var i = 0; i < messages.length; i++) if (cp(messages[i]) === sel) arr.push(messages[i])
  for (var j = 0; j < arr.length; j++) {
    var m = arr[j], div = document.createElement('div')
    div.className = 'msg ' + (m.from === me ? 'me' : 'them')
    var mt = document.createElement('span')
    mt.className = 'mt'
    mt.textContent = (m.from === me ? '我' : label(m.from)) + ' · ' + fmt(m.ts)
    if (m.kind === 'agent') {
      var tag = document.createElement('span')
      tag.className = 'tag'
      tag.textContent = 'agent'
      mt.appendChild(tag)
    }
    var bd = document.createElement('div')
    bd.textContent = m.body
    div.appendChild(mt)
    div.appendChild(bd)
    thread.appendChild(div)
  }
  thread.scrollTop = thread.scrollHeight
}
async function send() {
  var el = document.getElementById('body')
  var body = el.value.trim()
  if (sel === null || body === '') return
  var r = await api('/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: sel, body: body }),
  })
  if (!r.ok) {
    var e = await r.json().catch(function () { return {} })
    var err = document.getElementById('err')
    err.textContent = e.error || '发送失败'
    setTimeout(function () { err.textContent = '' }, 4000)
    return
  }
  el.value = ''
  await refresh()
}
document.getElementById('send').addEventListener('click', function () { send() })
document.getElementById('body').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
})
loadContacts().then(refresh).catch(function (e) {
  document.getElementById('err').textContent = String(e && e.message ? e.message : e)
})
setInterval(function () { refresh().catch(function () {}) }, 10000)
</script>`)
}

/**
 * Operator approval page, rendered by the account service for a notification
 * link. The decision is a POST from this page: a link prefetcher or a Feishu
 * message preview must never be able to approve an account on its own.
 * @param fields - the pending request's facts, rendered as a summary table.
 * @param token - the single-use approval token carried back on submit.
 * @returns the approval page HTML.
 */
export function approvalPage(fields: ReadonlyArray<readonly [string, string]>, token: string): string {
  const rows = fields
    .map(([k, v]) => `<tr><td style="color:#93a4cc;padding:.3rem 1rem .3rem 0;white-space:nowrap">${escapeHtml(k)}</td><td class="mono">${escapeHtml(v)}</td></tr>`)
    .join('')
  const hidden = `<input type="hidden" name="token" value="${escapeHtml(token)}">`
  return page('天问星 · 账号审批', `<div class="card wide">
  <h1 class="brand">账号审批</h1>
  <p class="tagline">确认后立即创建账号</p>
  <table style="margin:0 auto 1rem;font-size:.9rem;text-align:left">${rows}</table>
  <form method="post" action="/api/approvals">
    ${hidden}
    <input type="hidden" name="action" value="approve">
    <button type="submit">批准并创建账号</button>
  </form>
  <form method="post" action="/api/approvals">
    ${hidden}
    <input type="hidden" name="action" value="reject">
    <button type="submit" class="danger">拒绝申请</button>
  </form>
</div>`)
}

/**
 * Outcome page for an approval decision or an unusable approval link.
 * @param title - the page heading.
 * @param message - the explanatory paragraph, already safe to render as text.
 * @param ok - true for a successful decision, false for a refusal or expiry.
 * @returns the result page HTML.
 */
export function resultPage(title: string, message: string, ok: boolean): string {
  const lines = message.split('\n').map(escapeHtml).join('<br>')
  return page(`天问星 · ${title}`, `<div class="card">
  <h1 class="brand">${ok ? '完成' : '无法处理'}</h1>
  <p class="tagline">${escapeHtml(title)}</p>
  <p class="note${ok ? ' ok' : ''}" style="text-align:center">${lines}</p>
  ${ok ? '' : '<p class="footer" style="text-align:center"><a href="/">返回登录</a></p>'}
</div>`)
}

/** The "instance not ready" page for an authenticated member with no spawned instance. */
export const NOT_READY_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Instance not ready</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9}
.card{background:#fff;border:1px solid #d9dee3;border-radius:12px;padding:2rem;width:24rem;text-align:center}
h1{font-size:1.2rem}code{background:#eef1f4;padding:.15rem .4rem;border-radius:4px}</style></head>
<body><div class="card"><h1>Your dsh instance is not running</h1>
<p>The account service could not find a running instance for this session.
Try signing in again or contact the service operator.</p>
<p><a href="/api/logout" id="lo">Sign out</a></p></div></body></html>`
