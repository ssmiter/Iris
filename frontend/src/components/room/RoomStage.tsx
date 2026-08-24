import type { ReactNode, Ref, MouseEvent as ReactMouseEvent } from 'react'

/**
 * 房间舞台（docs/39 §1）：内容列 max-w 880px 居中，纵向滚动。
 * overlay 槽位渲染在滚动层之外（如右侧推入的详情层），不随内容滚动。
 */
export function RoomStage({
  children,
  overlay,
  contentRef,
  onContentMouseDown,
}: {
  children: ReactNode
  overlay?: ReactNode
  contentRef?: Ref<HTMLDivElement>
  onContentMouseDown?: (event: ReactMouseEvent) => void
}) {
  return (
    <section className="relative min-h-0 flex-1 overflow-hidden">
      <div
        ref={contentRef}
        className="scrollbar-subtle relative h-full overflow-y-auto"
        onMouseDown={onContentMouseDown}
      >
        <div className="mx-auto max-w-[880px] px-6 pb-24 pt-5 sm:px-10">
          {children}
        </div>
      </div>
      {overlay}
    </section>
  )
}
