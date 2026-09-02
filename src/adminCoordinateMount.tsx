import { createRoot, type Root } from 'react-dom/client'
import AdminCoordinateSettings from './components/AdminCoordinateSettings'

const MOUNT_ID = 'evren-admin-coordinate-settings'
let root: Root | null = null
let mountNode: HTMLElement | null = null
let installed = false

function syncMount() {
  const grid = document.querySelector<HTMLElement>('.admin-settings-grid')

  if (!grid) {
    if (root && mountNode && !document.contains(mountNode)) root.unmount()
    root = null
    mountNode = null
    return
  }

  const existing = document.getElementById(MOUNT_ID)
  if (existing) return

  mountNode = document.createElement('div')
  mountNode.id = MOUNT_ID
  mountNode.style.display = 'contents'
  const dataSecurityCard = grid.children.item(1)
  grid.insertBefore(mountNode, dataSecurityCard || null)
  root = createRoot(mountNode)
  root.render(<AdminCoordinateSettings />)
}

export function installAdminCoordinateSettings() {
  if (installed || typeof document === 'undefined') return
  installed = true
  const observer = new MutationObserver(syncMount)
  observer.observe(document.body, { childList: true, subtree: true })
  syncMount()
}
