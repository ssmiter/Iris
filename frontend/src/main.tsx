import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// 字体基座（docs/39 §8）：Manrope 西文 + Noto Sans SC 中文，可变字重离线打包，
// fontsource 自带 font-display: swap 与 unicode-range 分包，首屏不阻塞。
import '@fontsource-variable/manrope'
import '@fontsource-variable/noto-sans-sc'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
