import { useEffect } from 'react'

const LOGIN_CARD_SELECTOR = '.admin-login-card'
const LOGIN_FORM_SELECTOR = '.admin-login-form'
const LOGIN_INPUT_SELECTOR = '#admin-password'
const STATUS_CLASS = 'admin-login-security-status'
const MAX_ATTEMPTS = 3

function formatCountdown(totalSeconds: number) {
  const safe = Math.max(0, Math.ceil(totalSeconds))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

type LoginStatusPayload = {
  ok?: boolean
  blocked?: boolean
  attemptsRemaining?: number
  retryAfter?: number
}

export default function AdminLoginSecurityStatusFeature() {
  useEffect(() => {
    let attemptsRemaining = MAX_ATTEMPTS
    let lockUntil = 0
    let activeCard: Element | null = null
    let disposed = false

    const decorate = () => {
      const card = document.querySelector<HTMLElement>(LOGIN_CARD_SELECTOR)
      if (!card) return

      const subtitle = card.querySelector<HTMLElement>('.admin-login-heading p')
      if (subtitle) subtitle.style.display = 'none'

      const note = card.querySelector<HTMLElement>('.admin-login-note span')
      if (note) note.textContent = 'Oturum 15 dakika sonra otomatik kapanır. Üç hatalı deneme 15 dakika kilit uygular.'

      const form = card.querySelector<HTMLFormElement>(LOGIN_FORM_SELECTOR)
      const passwordField = form?.querySelector<HTMLElement>('.admin-password-field')
      const input = form?.querySelector<HTMLInputElement>(LOGIN_INPUT_SELECTOR)
      const legacyError = form?.querySelector<HTMLElement>('.admin-form-error')
      if (!form || !passwordField || !input) return

      const remainingLockSeconds = lockUntil > Date.now()
        ? Math.ceil((lockUntil - Date.now()) / 1000)
        : 0
      const blocked = remainingLockSeconds > 0
      const showAttemptWarning = !blocked && attemptsRemaining > 0 && attemptsRemaining < MAX_ATTEMPTS

      let status = form.querySelector<HTMLElement>(`.${STATUS_CLASS}`)
      if (blocked || showAttemptWarning) {
        if (!status) {
          status = document.createElement('p')
          status.className = STATUS_CLASS
          status.setAttribute('role', 'alert')
          passwordField.insertAdjacentElement('afterend', status)
        }
        status.classList.toggle('is-locked', blocked)
        status.classList.toggle('is-warning', showAttemptWarning)
        status.textContent = blocked
          ? `Giriş kilitlendi · ${formatCountdown(remainingLockSeconds)}`
          : `Hatalı parola · Son ${attemptsRemaining} hakkınız`
        if (legacyError) legacyError.style.display = 'none'
      } else {
        status?.remove()
        if (legacyError) legacyError.style.display = ''
      }

      card.classList.toggle('admin-login-is-locked', blocked)
      input.readOnly = blocked
      input.setAttribute('aria-disabled', blocked ? 'true' : 'false')
      if (blocked) input.placeholder = `Giriş kilitli · ${formatCountdown(remainingLockSeconds)}`
      else if (input.placeholder.startsWith('Giriş kilitli')) input.placeholder = 'Parolanızı girin'
    }

    const refreshStatus = async () => {
      try {
        const response = await fetch('/api/admin/login-status', {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
        })
        if (!response.ok) return
        const payload = await response.json() as LoginStatusPayload
        if (disposed || payload.ok === false) return

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
        // Durum göstergesi kullanılamasa da mevcut yönetici girişi çalışmaya devam eder.
      }
    }

    const onSubmit = (event: Event) => {
      const form = event.target
      if (!(form instanceof HTMLFormElement) || !form.matches(LOGIN_FORM_SELECTOR)) return
      if (lockUntil > Date.now()) {
        event.preventDefault()
        event.stopImmediatePropagation()
        decorate()
        return
      }
      window.setTimeout(() => void refreshStatus(), 450)
      window.setTimeout(() => void refreshStatus(), 950)
    }

    const discover = () => {
      const card = document.querySelector(LOGIN_CARD_SELECTOR)
      decorate()
      if (card && card !== activeCard) {
        activeCard = card
        void refreshStatus()
      } else if (!card) {
        activeCard = null
      }
    }

    document.addEventListener('submit', onSubmit, true)
    const observer = new MutationObserver(discover)
    observer.observe(document.body, { childList: true, subtree: true })
    discover()

    const countdownTimer = window.setInterval(() => {
      if (lockUntil > 0 && lockUntil <= Date.now()) {
        lockUntil = 0
        attemptsRemaining = MAX_ATTEMPTS
        decorate()
        void refreshStatus()
        return
      }
      if (lockUntil > Date.now()) decorate()
    }, 1000)

    return () => {
      disposed = true
      observer.disconnect()
      document.removeEventListener('submit', onSubmit, true)
      window.clearInterval(countdownTimer)
    }
  }, [])

  return (
    <style>{`
      .${STATUS_CLASS}{margin:8px 0 0;padding:9px 11px;border:1px solid #f0c7a1;border-radius:10px;background:#fff8ef;color:#a65b13;font-size:9px;font-weight:850;line-height:1.35;text-align:center}
      .${STATUS_CLASS}.is-locked{border-color:#efb7bd;background:#fff1f2;color:#b43746;font-variant-numeric:tabular-nums;font-size:10px}
      .admin-login-card.admin-login-is-locked .admin-primary-button{pointer-events:none;opacity:.48;filter:saturate(.65)}
      .admin-login-card.admin-login-is-locked .admin-password-field{opacity:.72}
      .admin-login-card.admin-login-is-locked #admin-password{cursor:not-allowed}
    `}</style>
  )
}
