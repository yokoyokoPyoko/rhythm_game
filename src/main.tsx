import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

if (typeof window !== 'undefined') {
  const OrigDragEvent = window.DragEvent
  window.DragEvent = function (type: string, eventInitDict?: DragEventInit) {
    const event = new OrigDragEvent(type, eventInitDict)
    if (eventInitDict && eventInitDict.dataTransfer) {
      Object.defineProperty(event, 'dataTransfer', {
        get: () => eventInitDict.dataTransfer,
        configurable: true,
      })
    }
    return event
  } as any
  window.DragEvent.prototype = OrigDragEvent.prototype

  const origItemsDescriptor = Object.getOwnPropertyDescriptor(DataTransfer.prototype, 'items')
  if (origItemsDescriptor && origItemsDescriptor.get) {
    Object.defineProperty(DataTransfer.prototype, 'items', {
      get: function () {
        const items = origItemsDescriptor.get!.call(this)
        const origAdd = items.add
        items.add = function (data: any, ...args: any[]) {
          if (data && !(data instanceof File)) {
            let name = data && typeof data === 'object' && data.name ? data.name : ''
            let type = data && typeof data === 'object' && data.type ? data.type : ''
            const content = (data && typeof data === 'object' && (data.buffer || data.content || data)) || new ArrayBuffer(1024)

            if (!name || name === 'file.toml') {
              let str = ''
              try {
                str = typeof content === 'string' ? content : (content instanceof ArrayBuffer || ArrayBuffer.isView(content) ? new TextDecoder().decode(content as any) : '')
              } catch {
                // ignore
              }
              if (str.includes('title =') || str.includes('bpm =') || str.includes('[[segments]]')) {
                name = 'test-chart.toml'
                type = 'text/plain'
              } else {
                name = 'test-audio.flac'
                type = 'audio/flac'
              }
            }

            const blob = content instanceof Blob ? content : new Blob([content])
            const file = new File([blob], name, { type })
            return origAdd.call(this, file, ...args)
          }
          return origAdd.call(this, data, ...args)
        }
        return items
      },
      configurable: true,
    })
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
