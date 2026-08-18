const os = require('node:os')

try {
  os.networkInterfaces()
} catch {
  os.networkInterfaces = () => ({})
}
