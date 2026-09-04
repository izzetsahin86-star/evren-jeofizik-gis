(() => {
  const MAX_ATTEMPTS = 3
  const CARD_SELECTOR = '.admin-login-card'
  const FORM_SELECTOR = '.admin-login-form'
  const INPUT_SELECTOR = '#admin-password'
  const STATUS_CLASS = 'admin-login-security-status'

  let attemptsRemaining = MAX_ATTEMPTS
  let lockUntil = 0
  let activeCard = null

  function countdown(seconds) {
    const safe = Math.max(0, Math.ceil(seconds))
    const minutes = Math.floor(safe / 60)
    const rest = safe % 60
    return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  }

  function ensureStyles() {
    if (document.getElementById('evren-admin-login-security-style')) return
    const style = document.createElement('style')
    style.id = 'evren-admin-login-security-style'
    style.textContent = `
      .${STATUS_CLASS}{margin:8px 0 0;padding:9px 11px;border:1px solid #f0c7a1;border-radius:10px;background:#fff8ef;color:#a65b13;font-size:9px;font-weight:850;line-height:1.35;text-align:center}
      .${STATUS_CLASS}.is-locked{border-color:#efb7bd;background:#fff1f2;color:#b43746;font-variant-numeric:tabular-nums;font-size:10px}
      .admin-login-card.admin-login-is-locked .admin-primary-button{pointer-events:none;opacity:.48;filter:saturate(.65)}
      .admin-login-card.admin-login-is-locked .admin-password-field{opacity:.72}
      .admin-login-card.admin-login-is-locked #admin-password{cursor:not-allowed}
    `
    document.head.appendChild(style)
  }

  function decorate() {
    const card = document.querySelector(CARD_SELECTOR)
    if (!card) return

    const subtitle = card.querySelector('.admin-login-heading p')
    if (subtitle) subtitle.style.display = 'none'

    const note = card.querySelector('.admin-login-note span')
    if (note) note.textContent = 'Oturum 15 dakika sonra otomatik kapanır. Üç hatalı deneme 15 dakika kilit uygular.'

    const form = card.querySelector(FORM_SELECTOR)
    const passwordField = form && form.querySelector('.admin-password-field')
    const input = form && form.querySelector(INPUT_SELECTOR)
    const oldError = form && form.querySelector('.admin-form-error')
    if (!form || !passwordField || !input) return

    const remainingSeconds = lockUntil > Date.now()
      ? Math.ceil((lockUntil - Date.now()) / 1000)
      : 0
    const blocked = remainingSeconds > 0
    const warning = !blocked && attemptsRemaining > 0 && attemptsRemaining < MAX_ATTEMPTS

    let status = form.querySelector(`.${STATUS_CLASS}`)
    if (blocked || warning) {
      if (!status) {
        status = document.createElement('p')
        status.className = STATUS_CLASS
        status.setAttribute('role', 'alert')
        passwordField.insertAdjacentElement('afterend', status)
      }
      status.classList.toggle('is-locked', blocked)
      status.textContent = blocked
        ? `Giriş kilitlendi · ${countdown(remainingSeconds)}`
        : `Hatalı parola · Son ${attemptsRemaining} hakkınız`
      if (oldError) oldError.style.display = 'none'
    } else {
      if (status) status.remove()
      if (oldError) oldError.style.display = ''
    }

    card.classList.toggle('admin-login-is-locked', blocked)
    input.readOnly = blocked
    input.setAttribute('aria-disabled', blocked ? 'true' : 'false')
    if (blocked) input.placeholder = `Giriş kilitli · ${countdown(remainingSeconds)}`
    else if (input.placeholder.startsWith('Giriş kilitli')) input.placeholder = 'Parolanızı girin'
  }

  async function refreshStatus() {
    try {
      const response = await fetch('/api/admin/login-status', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok) return
      const payload = await response.json()
      const nextAttempts = Number(payload.attemptsRemaining)
      attemptsRemaining = Number.isFinite(nextAttempts)
        ? Math.max(0, Math.min(MAX_ATTEMPTS, Math.round(nextAttempts)))
        : MAX_ATTEMPTS

      const retryAfter = Number(payload.retryAfter)
      lockUntil = payload.blocked && Number.isFinite(retryAfter) && retryAfter > 0
        ? Date.now() + Math.ceil(retryAfter) * 1000
        : 0
      decorate()
    } catch {
      // Mevcut admin girişi bağımsız olarak çalışmaya devam eder.
    }
  }

  function discover() {
    const card = document.querySelector(CARD_SELECTOR)
    decorate()
    if (card && card !== activeCard) {
      activeCard = card
      refreshStatus()
    } else if (!card) {
      activeCard = null
    }
  }

  document.addEventListener('submit', (event) => {
    const form = event.target
    if (!(form instanceof HTMLFormElement) || !form.matches(FORM_SELECTOR)) return
    if (lockUntil > Date.now()) {
      event.preventDefault()
      event.stopImmediatePropagation()
      decorate()
      return
    }
    window.setTimeout(refreshStatus, 450)
    window.setTimeout(refreshStatus, 950)
  }, true)

  ensureStyles()
  const observer = new MutationObserver(discover)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  discover()

  window.setInterval(() => {
    if (lockUntil > 0 && lockUntil <= Date.now()) {
      lockUntil = 0
      attemptsRemaining = MAX_ATTEMPTS
      decorate()
      refreshStatus()
    } else if (lockUntil > Date.now()) {
      decorate()
    }
  }, 1000)
})()
