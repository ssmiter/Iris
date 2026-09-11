/**
 * 浏览器密码自动填充护栏。
 *
 * 背景 BUG：应用登录表单被浏览器记住后，Chrome/Edge 会把任意 type="password"
 * 输入框当作登录表单，自动填充已保存的账号密码——并且把密码框上方最近的
 * 文本框当用户名填上邮箱。实测表现为：设置页 Provider 配置里"上下文窗口"
 * 被填入邮箱、"API Key"被填入登录密码，用户需手动删除重填。
 *
 * 用法：展开到对应 <input> 上即可。
 * - API Key 等凭证框用 credentialProps（new-password 告诉浏览器这不是登录表单，
 *   data-* 分别针对 1Password / LastPass / 通用密码管理器）。
 * - 凭证框附近的普通文本框用 plainTextProps，防止被当用户名位置填充。
 */
export const credentialAutofillGuard = {
  autoComplete: 'new-password',
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-form-type': 'other',
} as const

export const plainTextAutofillGuard = {
  autoComplete: 'off',
} as const
