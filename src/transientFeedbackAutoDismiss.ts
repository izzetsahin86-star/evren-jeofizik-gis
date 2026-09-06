const AUTO_DISMISS_MS = 1000

const TRANSIENT_SELECTORS = [
  '.smart-toast',
  '.desbatch-toast',
  '.descal-status',
  '.document-v2-status',
  '.desdual-status',
  '.des-status',
  '.field-status',
  '.despro-status',
  '.despro-export-status',
  '.underground-status',
  '.admin-settings-message',
  '.map-address-message',
  '.unified-transfer .form-note',
].join(',')

const timers = new WeakMap<HTMLElement, number>()

function clearTimer(element: HTMLElement) {
  const timer = timers.get(element)
  if (timer !== undefined) window.clearTimeout(timer)
  timers.delete(element)
}

function isBusyFeedback(element: HTMLElement) {
  return element.matches('.desbatch-toast.is-busy')
}

function arm(element: HTMLElement) {
  clearTimer(element)

  // İşlem sürerken ilerleme kartı görünür kalır. İşlem bittiğinde
  // busy sınıfı kalkar ve aynı kart 1 saniyelik kapanma süresine girer.
  if (isBusyFeedback(element)) {
    element.style.removeProperty('display')
    return
  }

  // Aynı React düğümü yeni bir mesajla tekrar kullanılırsa yeniden görünür yap.
  element.style.removeProperty('display')

  const timer = window.setTimeout(() => {
    if (!element.isConnected || isBusyFeedback(element)) return
    element.style.setProperty('display', 'none', 'important')
    timers.delete(element)
  }, AUTO_DISMISS_MS)

  timers.set(element, timer)
}

function visit(node: Node) {
  if (!(node instanceof Element)) return
  if (node.matches(TRANSIENT_SELECTORS)) arm(node as HTMLElement)
  node.querySelectorAll<HTMLElement>(TRANSIENT_SELECTORS).forEach(arm)
}

export function startTransientFeedbackAutoDismiss() {
  document.querySelectorAll<HTMLElement>(TRANSIENT_SELECTORS).forEach(arm)

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(visit)
        const parent = mutation.target instanceof Element ? mutation.target.closest<HTMLElement>(TRANSIENT_SELECTORS) : null
        if (parent) arm(parent)
        continue
      }

      if (mutation.type === 'characterData') {
        const parent = mutation.target.parentElement?.closest<HTMLElement>(TRANSIENT_SELECTORS)
        if (parent) arm(parent)
        continue
      }

      if (mutation.type === 'attributes' && mutation.target instanceof HTMLElement && mutation.target.matches(TRANSIENT_SELECTORS)) {
        arm(mutation.target)
      }
    }
  })

  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class'],
  })

  return () => {
    observer.disconnect()
    document.querySelectorAll<HTMLElement>(TRANSIENT_SELECTORS).forEach(clearTimer)
  }
}
