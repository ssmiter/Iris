/**
 * 会话水合期间的正文占位。
 *
 * 纯静态灰条，不播放 pulse/shimmer 等动画；水合完成后由真实内容替换。
 */
export function HydrationSkeleton() {
  return (
    <main
      aria-busy="true"
      aria-label="正在恢复对话"
      className="mx-auto flex min-h-0 w-full max-w-conversation flex-1 flex-col px-[var(--conversation-pad)] py-6"
    >
      <span className="sr-only">正在恢复对话内容</span>
      {/* 用户气泡占位：60% */}
      <div className="flex justify-end">
        <div className="h-10 w-[60%] rounded-lg bg-surface-muted" />
      </div>
      {/* 助手回答占位：85% */}
      <div className="mt-3 h-20 w-[85%] rounded-lg bg-surface-muted" />
      {/* 用户气泡占位：45% */}
      <div className="mt-3 flex justify-end">
        <div className="h-10 w-[45%] rounded-lg bg-surface-muted" />
      </div>
    </main>
  )
}
