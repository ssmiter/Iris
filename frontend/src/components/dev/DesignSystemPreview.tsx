import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowUpRight,
  Check,
  FileText,
  Moon,
  Palette,
  Send,
  Sparkles,
  Sun,
} from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Modal,
  ModalClose,
  ToastHost,
  Tooltip,
  notify,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import {
  applyTheme,
  getInitialTheme,
  saveTheme,
  type Theme,
} from '@/theme/theme'

const swatches = [
  { name: 'Canvas', className: 'bg-canvas' },
  { name: 'Surface', className: 'bg-surface' },
  { name: 'Raised', className: 'bg-surface-raised' },
  { name: 'Muted', className: 'bg-surface-muted' },
  { name: 'Iris', className: 'bg-primary' },
  { name: 'Success', className: 'bg-success' },
  { name: 'Warning', className: 'bg-warning' },
  { name: 'Danger', className: 'bg-danger' },
]

function Section({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="grid gap-5 border-t border-border py-10 sm:py-12">
      <header className="grid max-w-2xl gap-2">
        <p className="text-caption uppercase tracking-[0.16em] text-primary">
          {eyebrow}
        </p>
        <h2 className="text-title text-ink">{title}</h2>
        <p className="text-body text-ink-subtle">{description}</p>
      </header>
      {children}
    </section>
  )
}

function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="brand-spectrum grid h-8 w-8 place-items-center rounded-full p-[3px] shadow-hairline"
    >
      <span className="h-full w-full rounded-full bg-surface-raised" />
    </span>
  )
}

function TokenSwatch({
  name,
  className,
}: {
  name: string
  className: string
}) {
  return (
    <div className="grid gap-2">
      <div
        className={cn(
          'h-16 rounded-sm border border-border shadow-hairline',
          className,
        )}
      />
      <span className="text-caption text-ink-muted">{name}</span>
    </div>
  )
}

export function DesignSystemPreview() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const showSaved = () => {
    setIsSaving(true)
    window.setTimeout(() => {
      setIsSaving(false)
      notify.success('偏好已保存', {
        description: '这是一条短期反馈，不会替代对话中的持久状态。',
      })
    }, 700)
  }

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="sticky top-0 z-30 border-b border-border bg-canvas/88 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-4 px-[var(--page-gutter)] py-3">
          <div className="flex items-center gap-3">
            <BrandMark />
            <div>
              <p className="text-small font-semibold leading-tight text-ink">Iris</p>
              <p className="text-caption text-ink-muted">Design foundation 1.1</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={theme === 'light' ? '切换到暗色主题' : '切换到亮色主题'}
            onClick={() => {
              const nextTheme = theme === 'light' ? 'dark' : 'light'
              saveTheme(nextTheme)
              setTheme(nextTheme)
            }}
          >
            {theme === 'light' ? (
              <Moon aria-hidden="true" className="h-4 w-4" />
            ) : (
              <Sun aria-hidden="true" className="h-4 w-4" />
            )}
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1180px] px-[var(--page-gutter)] pb-20">
        <section className="grid min-h-[500px] items-center gap-10 py-14 lg:grid-cols-[1.15fr_.85fr] lg:py-20">
          <div className="grid max-w-3xl gap-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="info" showDot>
                Foundation ready
              </Badge>
              <Badge appearance="outline">Light / Dark</Badge>
            </div>
            <div className="grid gap-4">
              <h1 className="text-pretty text-display sm:text-[2.75rem] sm:leading-[1.12]">
                安静地接住复杂的事，
                <span className="text-primary">把下一步说清楚。</span>
              </h1>
              <p className="max-w-2xl text-body text-ink-subtle sm:text-[1.0625rem] sm:leading-7">
                Iris 的颜色只负责建立方向，组件负责让状态可信。彩虹是签名，不是每个界面的背景。
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button>
                <Sparkles aria-hidden="true" className="h-4 w-4" />
                开始一件事
              </Button>
              <Button variant="secondary">
                查看设计原则
                <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <Card variant="raised" padding="lg" className="relative overflow-hidden">
            <div className="brand-spectrum absolute inset-x-0 top-0 h-1" />
            <CardHeader>
              <div className="mb-3 flex items-center justify-between">
                <span className="grid h-9 w-9 place-items-center rounded-sm bg-primary-soft text-primary">
                  <Check aria-hidden="true" className="h-4 w-4" />
                </span>
                <Badge tone="success">边界已确认</Badge>
              </div>
              <CardTitle>视觉服务于寻找</CardTitle>
              <CardDescription>
                每个新组件先回答：它减少了用户哪一次寻找？
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {['当前状态有稳定位置', '危险动作不只靠颜色', '动画结束后视线仍有落点'].map(
                (item) => (
                  <div
                    key={item}
                    className="flex items-center gap-3 rounded-sm bg-surface-muted px-3 py-2.5 text-small text-ink-subtle"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                    {item}
                  </div>
                ),
              )}
            </CardContent>
          </Card>
        </section>

        <Section
          eyebrow="Tokens"
          title="语义颜色，而不是散落的色值"
          description="主题切换只改变语义映射。业务组件不直接触碰 Primitive palette。"
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-8">
            {swatches.map((swatch) => (
              <TokenSwatch key={swatch.name} {...swatch} />
            ))}
          </div>
        </Section>

        <Section
          eyebrow="Actions"
          title="动作有清晰的主次关系"
          description="颜色、形状、文字和焦点共同表达行为；危险动作不借用普通主按钮。"
        >
          <Card padding="lg">
            <div className="flex flex-wrap items-center gap-3">
              <Button>
                <Send aria-hidden="true" className="h-4 w-4" />
                发送
              </Button>
              <Button variant="secondary">保存草稿</Button>
              <Tooltip content="收入待办，不打断当前对话">
                <Button variant="ghost">稍后处理</Button>
              </Tooltip>
              <Button variant="danger">删除记录</Button>
              <Button isLoading loadingLabel="保存中…">
                保存
              </Button>
              <Button disabled>不可用</Button>
            </div>
          </Card>
        </Section>

        <Section
          eyebrow="Fields"
          title="输入状态不藏在 placeholder 里"
          description="标签、说明和错误都有稳定的可访问关系。"
        >
          <div className="grid gap-5 lg:grid-cols-2">
            <Card padding="lg">
              <Input
                label="任务名称"
                placeholder="例如：整理本周投递"
                description="之后可以在对话中继续补充，不必一次说完。"
              />
            </Card>
            <Card padding="lg">
              <Input
                label="工作区目录"
                defaultValue="job/applications"
                error="目录必须位于当前工作区内。"
              />
            </Card>
          </div>
        </Section>

        <Section
          eyebrow="Surfaces"
          title="卡片承载内容，不争夺注意力"
          description="普通卡片保持中性；交互卡片本身就是原生按钮，而不是伪装成可点击的 div。"
        >
          <div className="grid gap-5 md:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-body font-semibold">
                  Plain fact
                </CardTitle>
                <CardDescription>安静承载一段稳定信息。</CardDescription>
              </CardHeader>
            </Card>
            <Card variant="raised">
              <CardHeader>
                <CardTitle className="text-body font-semibold">
                  Raised surface
                </CardTitle>
                <CardDescription>只为真正浮起的内容增加阴影。</CardDescription>
              </CardHeader>
            </Card>
            <CardAction aria-label="打开设计系统文档">
              <div className="flex items-start justify-between gap-4">
                <div className="grid gap-1">
                  <p className="text-body font-semibold text-ink">Interactive card</p>
                  <p className="text-small text-ink-subtle">有键盘焦点，也有明确动作。</p>
                </div>
                <ArrowUpRight aria-hidden="true" className="h-4 w-4 text-primary" />
              </div>
            </CardAction>
          </div>
        </Section>

        <Section
          eyebrow="Feedback"
          title="短期反馈与持久状态分开"
          description="Toast 只确认轻量操作；Modal 处理需要聚焦的短流程。"
        >
          <Card padding="lg">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" onClick={showSaved} isLoading={isSaving}>
                显示 Toast
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  notify.error('没有写入文件', {
                    description: '目标版本已变化，请重新查看差异。',
                  })
                }
              >
                显示错误
              </Button>
              <Modal
                title="导入一份文件"
                description="这里验证焦点、滚动、关闭和动作层级；不执行真实文件操作。"
                trigger={
                  <Button>
                    <FileText aria-hidden="true" className="h-4 w-4" />
                    打开 Modal
                  </Button>
                }
                footer={
                  <>
                    <ModalClose asChild>
                      <Button variant="ghost">取消</Button>
                    </ModalClose>
                    <ModalClose asChild>
                      <Button>确认选择</Button>
                    </ModalClose>
                  </>
                }
              >
                <div className="grid gap-5">
                  <div className="grid h-36 place-items-center rounded-md border border-dashed border-border-strong bg-surface-muted text-center">
                    <div className="grid gap-2">
                      <span className="mx-auto grid h-10 w-10 place-items-center rounded-sm bg-primary-soft text-primary">
                        <FileText aria-hidden="true" className="h-5 w-5" />
                      </span>
                      <p className="text-small font-semibold text-ink">选择围栏内的文件</p>
                      <p className="text-caption text-ink-muted">PDF、文档或表格</p>
                    </div>
                  </div>
                  <Input label="显示名称" defaultValue="求职记录.xlsx" />
                </div>
              </Modal>
            </div>
          </Card>
        </Section>

        <Section
          eyebrow="Status"
          title="状态不能只靠颜色猜"
          description="Badge 保留文字，并在需要时增加稳定的小型图形锚点。"
        >
          <div className="flex flex-wrap gap-2">
            <Badge showDot>等待</Badge>
            <Badge tone="info" showDot>
              运行中
            </Badge>
            <Badge tone="success" showDot>
              已验证
            </Badge>
            <Badge tone="warning" showDot>
              需确认
            </Badge>
            <Badge tone="danger" showDot>
              未完成
            </Badge>
          </div>
        </Section>

        <footer className="flex flex-col gap-4 border-t border-border py-8 text-small text-ink-muted sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Palette aria-hidden="true" className="h-4 w-4" />
            Iris design foundation
          </div>
          <span>彩虹是签名，状态是事实。</span>
        </footer>
      </main>
      <ToastHost />
    </div>
  )
}
