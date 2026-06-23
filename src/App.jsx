import { useState, useEffect, useRef, useCallback } from 'react'

const CAMCORDER_HINTS = ['PV-GS', 'DV', 'FireWire', 'Panasonic', 'Sony', 'Canon']

function formatSize(bytes) {
  if (bytes === 0) return '0 MB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatElapsed(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0')
  const s = (seconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

export default function App() {
  const [devices, setDevices] = useState([])
  const [device, setDevice] = useState('')
  const [dest, setDest] = useState('')
  const [filename, setFilename] = useState('')
  const [isCapturing, setIsCapturing] = useState(false)
  const [logLines, setLogLines] = useState([])
  const [fileSize, setFileSize] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [deps, setDeps] = useState(null)

  const logRef = useRef(null)
  const timerRef = useRef(null)
  const startTimeRef = useRef(null)

  const outputPath = dest && filename.trim()
    ? `${dest}/${filename.trim()}.dv`
    : null

  const appendLog = useCallback((line) => {
    setLogLines((prev) => [...prev, { id: Date.now() + Math.random(), text: line }])
  }, [])

  // Scroll log to bottom after every new line, deferred so the DOM has painted
  useEffect(() => {
    requestAnimationFrame(() => {
      if (logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight
      }
    })
  }, [logLines])

  // Wire up Electron IPC listeners once
  useEffect(() => {
    window.api.onCaptureOutput((data) => {
      data.split('\n').filter(Boolean).forEach(appendLog)
    })

    window.api.onCaptureProgress(({ size }) => {
      setFileSize(size)
      if (startTimeRef.current) {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
      }
    })

    window.api.onCaptureEnded(({ code, outputPath, size, error }) => {
      clearInterval(timerRef.current)
      setIsCapturing(false)
      setFileSize(size ?? 0)
      if (error) {
        appendLog(`Error: ${error}`)
      } else {
        appendLog(`─── Capture ended (exit ${code}) — ${formatSize(size ?? 0)} written ───`)
        if (outputPath) appendLog(`Saved to: ${outputPath}`)
      }
    })

    return () => {
      window.api.removeListeners('capture-output')
      window.api.removeListeners('capture-progress')
      window.api.removeListeners('capture-ended')
    }
  }, [appendLog])

  const scanDevices = useCallback(async () => {
    setScanning(true)
    appendLog('Scanning for capture devices…')
    const found = await window.api.listDevices()
    setDevices(found)
    if (found.length > 0) {
      const camcorder = found.find((d) => CAMCORDER_HINTS.some((h) => d.toLowerCase().includes(h.toLowerCase())))
      setDevice(camcorder ?? found[0])
      appendLog(`Found ${found.length} device(s): ${found.join(', ')}`)
    } else {
      appendLog('No video devices found. Connect your camcorder and click Refresh.')
    }
    setScanning(false)
  }, [appendLog])

  useEffect(() => {
    window.api.checkDeps().then(setDeps)
    scanDevices()
  }, [])

  const browseFolder = async () => {
    const selected = await window.api.selectFolder()
    if (selected) setDest(selected)
  }

  const startCapture = async () => {
    const result = await window.api.startCapture({ device, dest, filename, overwrite: false })

    if (result?.error === 'FILE_EXISTS') {
      const ok = window.confirm(`${result.outputPath}\nalready exists. Overwrite?`)
      if (!ok) return
      await window.api.startCapture({ device, dest, filename, overwrite: true })
    } else if (result?.error) {
      appendLog(`Error: ${result.error}`)
      return
    }

    const cmd = `ffmpeg-dl -f avfoundation -capture_raw_data true -i "${device}" -c copy -f dv - | tee "${outputPath}" | dvrescue - 2>/dev/null`
    appendLog('─── Starting capture ───')
    appendLog(`Device:  ${device}`)
    appendLog(`Output:  ${outputPath}`)
    appendLog(`Command: ${cmd}`)
    appendLog('─'.repeat(56))

    setIsCapturing(true)
    setFileSize(0)
    setElapsed(0)
    startTimeRef.current = Date.now()
  }

  const stopCapture = async () => {
    await window.api.stopCapture()
    setIsCapturing(false)
    clearInterval(timerRef.current)
  }

  const canStart = device && dest && filename.trim() && !isCapturing

  return (
    <div className="app">
      <div className="titlebar" />

      {/* Missing dependency banner */}
      {deps && (!deps.ffmpegDl || !deps.dvrescue) && (
        <div className="dep-banner">
          <strong>Missing required software</strong>
          <ul>
            {!deps.ffmpegDl && <li>ffmpeg not found — install via <code>brew install ffmpeg</code></li>}
            {!deps.dvrescue && <li>dvrescue not found — see the <strong>Install</strong> menu, or run:<br /><code>brew install mediaarea/homebrew-mediaarea/dvrescue</code></li>}
          </ul>
          <div className="dep-links">
            {deps.installLinks.map((link) => (
              <a
                key={link.url}
                href={link.url}
                onClick={(e) => { e.preventDefault(); window.open(link.url) }}
              >
                {link.label} ↗
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="form">
        {/* Device */}
        <div className="field">
          <label>Device</label>
          <div className="row">
            <select value={device} onChange={(e) => setDevice(e.target.value)} disabled={isCapturing}>
              {devices.length === 0 && <option value="">No devices found</option>}
              {devices.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <button className="btn-secondary" onClick={scanDevices} disabled={scanning || isCapturing}>
              {scanning ? 'Scanning…' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Destination */}
        <div className="field">
          <label>Destination</label>
          <div className="row">
            <input
              type="text"
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              placeholder="/Users/you/Desktop"
              disabled={isCapturing}
            />
            <button className="btn-secondary" onClick={browseFolder} disabled={isCapturing}>
              Browse…
            </button>
          </div>
        </div>

        {/* Filename */}
        <div className="field">
          <label>Filename</label>
          <div className="row">
            <input
              type="text"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder="tape-001"
              disabled={isCapturing}
            />
            <span className="ext">.dv</span>
          </div>
        </div>

        {/* Output preview */}
        <div className="field">
          <label>Output</label>
          <span className="preview">{outputPath ?? '—'}</span>
        </div>
      </div>

      <div className="divider" />

      {/* Buttons */}
      <div className="actions">
        <button className="btn-primary" onClick={startCapture} disabled={!canStart}>
          Start Import
        </button>
        <button className="btn-danger" onClick={stopCapture} disabled={!isCapturing}>
          Stop Import
        </button>
        <button className="btn-secondary" onClick={() => window.close()}>
          Quit
        </button>
      </div>

      {/* Status bar */}
      {isCapturing && (
        <div className="status-bar">
          <span className="dot" /> Capturing — {formatSize(fileSize)} — {formatElapsed(elapsed)}
        </div>
      )}

      {/* Log */}
      <div className="log" ref={logRef}>
        {logLines.map((l) => (
          <div key={l.id} className="log-line">{l.text}</div>
        ))}
      </div>
    </div>
  )
}
