import typography from '@tailwindcss/typography'
import type { Config } from 'tailwindcss'

const color = (token: string) => `rgb(var(--color-${token}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        canvas: color('canvas'),
        surface: {
          DEFAULT: color('surface'),
          raised: color('surface-raised'),
          muted: color('surface-muted'),
        },
        ink: {
          DEFAULT: color('text'),
          subtle: color('text-subtle'),
          muted: color('text-muted'),
        },
        border: {
          DEFAULT: color('border'),
          strong: color('border-strong'),
        },
        primary: {
          DEFAULT: color('primary'),
          hover: color('primary-hover'),
          soft: color('primary-soft'),
          foreground: color('primary-foreground'),
        },
        focus: color('focus'),
        success: {
          DEFAULT: color('success'),
          soft: color('success-soft'),
          foreground: color('success-foreground'),
        },
        warning: {
          DEFAULT: color('warning'),
          soft: color('warning-soft'),
          foreground: color('warning-foreground'),
        },
        danger: {
          DEFAULT: color('danger'),
          soft: color('danger-soft'),
          foreground: color('danger-foreground'),
          contrast: color('danger-contrast'),
        },
        info: {
          DEFAULT: color('info'),
          soft: color('info-soft'),
          foreground: color('info-foreground'),
        },
        violet: {
          DEFAULT: color('violet'),
          soft: color('violet-soft'),
          foreground: color('violet-foreground'),
        },
        teal: {
          DEFAULT: color('teal'),
          soft: color('teal-soft'),
          foreground: color('teal-foreground'),
        },
      },
      fontFamily: {
        sans: [
          'Segoe UI Variable',
          'Segoe UI',
          'PingFang SC',
          'Microsoft YaHei UI',
          'system-ui',
          'sans-serif',
        ],
        mono: ['Cascadia Code', 'SFMono-Regular', 'Consolas', 'monospace'],
      },
      fontSize: {
        display: ['2rem', { lineHeight: '2.375rem', fontWeight: '650' }],
        title: ['1.5rem', { lineHeight: '1.9375rem', fontWeight: '650' }],
        heading: ['1.125rem', { lineHeight: '1.625rem', fontWeight: '600' }],
        body: ['0.9375rem', { lineHeight: '1.5625rem' }],
        small: ['0.8125rem', { lineHeight: '1.1875rem' }],
        caption: ['0.71875rem', { lineHeight: '1rem', fontWeight: '500' }],
      },
      spacing: {
        4.5: '1.125rem',
      },
      borderRadius: {
        xs: 'var(--radius-xs)',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      boxShadow: {
        hairline: 'var(--shadow-hairline)',
        raised: 'var(--shadow-raised)',
        floating: 'var(--shadow-floating)',
        focus: 'var(--shadow-focus)',
      },
      maxWidth: {
        conversation: 'var(--conversation-max)',
      },
      transitionDuration: {
        instant: 'var(--motion-instant)',
        fast: 'var(--motion-fast)',
        normal: 'var(--motion-normal)',
        deliberate: 'var(--motion-deliberate)',
        fold: 'var(--motion-fold)',
      },
      transitionTimingFunction: {
        standard: 'var(--ease-standard)',
        enter: 'var(--ease-enter)',
        exit: 'var(--ease-exit)',
        flow: 'var(--ease-flow)',
      },
      keyframes: {
        'overlay-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'overlay-out': {
          from: { opacity: '1' },
          to: { opacity: '0' },
        },
        'dialog-in': {
          from: { opacity: '0', transform: 'translate(-50%, -47%) scale(.98)' },
          to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
        },
        'dialog-out': {
          from: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
          to: { opacity: '0', transform: 'translate(-50%, -48%) scale(.985)' },
        },
        'soft-pulse': {
          '0%, 100%': { opacity: '.45', transform: 'scale(.9)' },
          '50%': { opacity: '1', transform: 'scale(1)' },
        },
        // 瀑布流节点出生：内容淡入微升，来路线段从上方生长（ WonWork 水流感
        // 的 Iris 克制版——时长压进 deliberate token，只播一次，both 填充防闪）。
        'node-enter': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'seg-grow': {
          from: { transform: 'scaleY(0)' },
          to: { transform: 'scaleY(1)' },
        },
        // 活跃节点光环（WonWork wf-halo）：圆点外圈 box-shadow 扩散到透明，
        // 与 soft-pulse 内点呼吸同周期；attention 等待态用 warning 色、更急促。
        'node-halo': {
          '0%': { boxShadow: '0 0 0 0 rgb(var(--color-primary) / 0.3)' },
          '100%': { boxShadow: '0 0 0 6px rgb(var(--color-primary) / 0)' },
        },
        'node-halo-warn': {
          '0%': { boxShadow: '0 0 0 0 rgb(var(--color-warning) / 0.35)' },
          '100%': { boxShadow: '0 0 0 6px rgb(var(--color-warning) / 0)' },
        },
        // 回合收尾微光：active→settled 时摘要行泛一层 primary 薄光后散去，
        // "尘埃落定"的一次性信号，不循环。
        'settle-glow': {
          from: { backgroundColor: 'rgb(var(--color-primary) / 0.1)' },
          to: { backgroundColor: 'transparent' },
        },
        spin: {
          to: { transform: 'rotate(360deg)' },
        },
      },
      animation: {
        'overlay-in': 'overlay-in var(--motion-normal) var(--ease-enter)',
        'overlay-out': 'overlay-out var(--motion-fast) var(--ease-exit)',
        'dialog-in': 'dialog-in var(--motion-deliberate) var(--ease-enter)',
        'dialog-out': 'dialog-out var(--motion-normal) var(--ease-exit)',
        'soft-pulse': 'soft-pulse 1.8s var(--ease-standard) infinite',
        'node-enter': 'node-enter var(--motion-deliberate) var(--ease-enter) both',
        'seg-grow': 'seg-grow var(--motion-deliberate) var(--ease-enter) both',
        'node-halo': 'node-halo 1.8s var(--ease-standard) infinite',
        'node-halo-warn': 'node-halo-warn 1.2s var(--ease-standard) infinite',
        'settle-glow': 'settle-glow 1.4s var(--ease-standard) both',
        spin: 'spin .8s linear infinite',
      },
    },
  },
  plugins: [typography],
} satisfies Config
