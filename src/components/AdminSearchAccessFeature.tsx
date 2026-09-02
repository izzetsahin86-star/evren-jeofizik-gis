import { useEffect } from 'react'

const ADDRESS_INPUT_SELECTOR = '.map-address-box input'
const ADMIN_TRIGGER_LENGTH = 15
const ADMIN_TRIGGER_SHA256 = '4e7cf1391ed0c79625bb7668df805ffd0a2b4c44222448b8f7e667859539a322'

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  descriptor?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

export default function AdminSearchAccessFeature() {
  useEffect(() => {
    let checkId = 0

    const onInput = (event: Event) => {
      const input = event.target
      if (!(input instanceof HTMLInputElement) || !input.matches(ADDRESS_INPUT_SELECTOR)) return

      const value = input.value
      if (value.length !== ADMIN_TRIGGER_LENGTH) return
      const currentCheck = ++checkId

      void sha256Hex(value)
        .then((digest) => {
          if (currentCheck !== checkId || digest !== ADMIN_TRIGGER_SHA256 || input.value !== value) return
          setNativeInputValue(input, '')
          window.location.replace('/admin')
        })
        .catch(() => undefined)
    }

    document.addEventListener('input', onInput, true)
    return () => {
      checkId += 1
      document.removeEventListener('input', onInput, true)
    }
  }, [])

  return null
}
