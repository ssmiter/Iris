import { useState } from 'react'
import { useChatStore } from '@/stores/chatStore'

/**
 * 骨架对话页（M0）：证明 SSE 链路 + 历史渲染。
 * 视觉与瀑布流组件由你自己设计——范式与令牌见 docs/07。
 */
export default function App() {
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const [input, setInput] = useState('')

  return (
    <div className="app">
      <main className="chat">
        {messages.length === 0 && (
          <div className="empty">
            <h1>Iris · 虹使</h1>
            <p>把日常琐事交给知根知底的虹使。</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.content}
          </div>
        ))}
      </main>
      <footer className="composer">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && input.trim()) {
              void sendMessage(input.trim())
              setInput('')
            }
          }}
          placeholder="说点什么…"
          disabled={isStreaming}
        />
      </footer>
    </div>
  )
}
