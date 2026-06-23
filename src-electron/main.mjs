import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn, execSync } from 'child_process'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const isDev = process.env.ELECTRON_DEV === '1'

const TOOL_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'
const env = { ...process.env, PATH: `${TOOL_PATH}:${process.env.PATH}` }

function resolveFFmpeg() {
  for (const bin of ['ffmpeg-dl', 'ffmpeg']) {
    try { execSync(`which ${bin}`, { env }); return bin } catch { /* try next */ }
  }
  return null
}

const INSTALL_LINKS = [
  {
    label: 'dvrescue (MediaArea)',
    url: 'https://mediaarea.net/DVRescue',
    brew: 'brew install mediaarea/homebrew-mediaarea/dvrescue',
  },
  {
    label: 'Blackmagic Desktop Video 12.8',
    url: 'https://www.blackmagicdesign.com/support/download/29a0964238eb45f9a5ae8b6a477a49f6/Mac%20OS%20X',
  },
  {
    label: 'Blackmagic Desktop Video SDK 12.8',
    url: 'https://www.blackmagicdesign.com/support/download/b8509558624f4c85856b3d92776e9bde/Mac%20OS%20X',
  },
]

const SETUP_INFO = {
  title: 'Recommended capture configuration',
  message: 'Camera connects over DV to FireWire into a PCIE FireWire card. Capture is written through an M.2 transfer card into an NVMe SSD enclosure, which is then attached by Thunderbolt.',
  detail:
    'Connection path:\n' +
    '1. Camera\n' +
    '2. DV to FireWire cable\n' +
    '3. PCIE-1394A 4-Port 1394A PCIE FireWire 400 Expansion Card\n' +
    '4. M.2 Transfer PCIe adapter card installed in the SSD enclosure\n' +
    '5. NVMe SSD enclosure connected via Thunderbolt\n\n' +
    'Example hardware links are provided below.',
  links: [
    {
      label: 'PCIE-1394A 4-Port FireWire 400 Expansion Card',
      url: 'https://www.amazon.com/dp/B07Q2G79QG?ref=ppx_yo2ov_dt_b_fed_asin_title&th=1',
    },
    {
      label: 'M.2 Transfer PCIe Adapter Card (2-Pack)',
      url: 'https://www.amazon.com/dp/B09C1BK164?ref=ppx_yo2ov_dt_b_fed_asin_title&th=1',
    },
    {
      label: 'MAIWO NVMe USB4 SSD Enclosure',
      url: 'https://www.amazon.com/dp/B0CZ767YH6?ref=ppx_yo2ov_dt_b_fed_asin_title',
    },
  ],
}

let mainWindow
let captureProcess = null
let progressInterval = null
let currentOutputPath = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 640,
    minWidth: 620,
    minHeight: 540,
    titleBarStyle: 'hiddenInset',
    title: 'DV Capture',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    mainWindow.loadURL('http://127.0.0.1:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  buildMenu()
  createWindow()
})

function showCaptureSetup() {
  const options = {
    type: 'info',
    title: SETUP_INFO.title,
    message: SETUP_INFO.message,
    detail: SETUP_INFO.links.map((link, index) => `${index + 1}. ${link.label}`).join('\n'),
    buttons: [...SETUP_INFO.links.map((link) => link.label), 'Close'],
    cancelId: SETUP_INFO.links.length,
    noLink: true,
    normalizeAccessKeys: true,
  }

  dialog.showMessageBox(mainWindow, options).then((result) => {
    const index = result.response
    if (index >= 0 && index < SETUP_INFO.links.length) {
      shell.openExternal(SETUP_INFO.links[index].url)
    }
  })
}

function buildMenu() {
  const installItems = INSTALL_LINKS.map((item) => ({
    label: item.label,
    click: () => {
      if (item.brew) {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: item.label,
          message: 'Install via Homebrew',
          detail: `Run this command in Terminal:\n\n${item.brew}`,
          buttons: ['Open Website', 'Close'],
          cancelId: 1,
        }).then(({ response }) => {
          if (response === 0) shell.openExternal(item.url)
        })
      } else {
        shell.openExternal(item.url)
      }
    },
  }))

  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Install',
      submenu: [
        { label: 'Required Software', enabled: false },
        { type: 'separator' },
        ...installItems,
        { type: 'separator' },
        {
          label: 'Capture setup',
          click: showCaptureSetup,
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.on('window-all-closed', () => {
  stopCapture()
  app.quit()
})

// ── IPC: Check required tools ──────────────────────────────────────────────

ipcMain.handle('check-deps', () => {
  const check = (cmd) => {
    try { execSync(`which ${cmd}`, { env }); return true } catch { return false }
  }
  return {
    ffmpegDl: resolveFFmpeg() !== null,
    dvrescue: check('dvrescue'),
    installLinks: INSTALL_LINKS,
  }
})

// ── IPC: List AVFoundation video devices ───────────────────────────────────

ipcMain.handle('list-devices', () => {
  return new Promise((resolve) => {
    const ffmpeg = resolveFFmpeg()
    if (!ffmpeg) { resolve([]); return }
    const proc = spawn(ffmpeg, ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { env })

    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString() })

    const timeout = setTimeout(() => { proc.kill(); resolve([]) }, 8000)

    proc.on('close', () => {
      clearTimeout(timeout)
      resolve(parseDevices(stderr))
    })

    proc.on('error', () => { clearTimeout(timeout); resolve([]) })
  })
})

function parseDevices(stderr) {
  const devices = []
  let inVideo = false
  for (const line of stderr.split('\n')) {
    if (line.includes('AVFoundation video devices')) { inVideo = true; continue }
    if (line.includes('AVFoundation audio devices')) break
    if (inVideo) {
      const m = line.match(/\[(\d+)\]\s+(.+)/)
      if (m) devices.push(m[2].trim())
    }
  }
  return devices
}

// ── IPC: Open native folder picker ────────────────────────────────────────

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select destination folder',
  })
  return result.canceled ? null : result.filePaths[0]
})

// ── IPC: Start capture ─────────────────────────────────────────────────────

ipcMain.handle('start-capture', async (_, { device, dest, filename, overwrite }) => {
  if (captureProcess) return { error: 'Already capturing' }

  const outputPath = path.join(dest, filename.trim() + '.dv')

  if (!overwrite && fs.existsSync(outputPath)) {
    return { error: 'FILE_EXISTS', outputPath }
  }

  // Merge dvrescue stderr into stdout so both stream to the log in real-time.
  // ffmpeg-dl stderr is redirected to /dev/null to suppress its own noise.
  const ffmpeg = resolveFFmpeg()
  if (!ffmpeg) return { error: 'ffmpeg not found' }

  const cmd = [
    ffmpeg, '-f', 'avfoundation', '-capture_raw_data', 'true',
    '-i', device, '-c', 'copy', '-f', 'dv', '-', '2>/dev/null',
    '|', 'tee', `"${outputPath}"`,
    '|', 'dvrescue', '-', '2>&1',
  ].join(' ')

  captureProcess = spawn('/bin/zsh', ['-c', cmd], { env, detached: true })
  currentOutputPath = outputPath

  const sendLine = (data) => {
    mainWindow?.webContents.send('capture-output', data.toString())
  }
  captureProcess.stdout.on('data', sendLine)
  captureProcess.stderr.on('data', sendLine)

  captureProcess.on('close', (code) => {
    const size = safeFileSize(currentOutputPath)
    mainWindow?.webContents.send('capture-ended', { code, outputPath: currentOutputPath, size })
    cleanup()
  })

  captureProcess.on('error', (err) => {
    mainWindow?.webContents.send('capture-ended', { error: err.message })
    cleanup()
  })

  progressInterval = setInterval(() => {
    const size = safeFileSize(currentOutputPath)
    mainWindow?.webContents.send('capture-progress', { size })
  }, 1000)

  return { success: true, outputPath }
})

// ── IPC: Stop capture ──────────────────────────────────────────────────────

ipcMain.handle('stop-capture', () => stopCapture())

function stopCapture() {
  if (!captureProcess) return
  try {
    process.kill(-captureProcess.pid, 'SIGINT')
  } catch {
    try { captureProcess.kill('SIGINT') } catch { /* already dead */ }
  }
  cleanup()
}

function cleanup() {
  clearInterval(progressInterval)
  progressInterval = null
  captureProcess = null
}

function safeFileSize(filePath) {
  try {
    return filePath && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
  } catch {
    return 0
  }
}
