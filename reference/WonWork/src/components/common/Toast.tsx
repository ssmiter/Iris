import { Toaster } from 'sonner'

export function Toast() {
  // offset 下移避开 48px 顶栏（2026-07-31：toast 挡住顶部状态栏）
  return <Toaster richColors position="top-right" closeButton duration={4000} offset={{ top: 60 }} />
}
