import { getSettings, type ResendAccount } from './settings'

type MailTemplateInput = {
  title: string
  eyebrow?: string
  intro?: string
  highlight?: string
  highlightLabel?: string
  paragraphs?: string[]
  footerNote?: string
  metaLines?: string[]
}

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderParagraphs(paragraphs: string[] | undefined): string {
  if (!paragraphs || paragraphs.length === 0) return ''
  return paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px;color:#334155;font-size:15px;line-height:1.7;">${escapeHtml(p)}</p>`
    )
    .join('')
}

function renderMetaLines(metaLines: string[] | undefined): string {
  if (!metaLines || metaLines.length === 0) return ''
  const rows = metaLines
    .map(
      (line) =>
        `<div style="margin:0 0 6px;color:#64748b;font-size:12px;line-height:1.6;">${escapeHtml(line)}</div>`
    )
    .join('')
  return `<div style="margin-top:22px;padding-top:16px;border-top:1px solid #e2e8f0;">${rows}</div>`
}

export function renderMailTemplate(input: MailTemplateInput): string {
  const brand = 'Minecraft 端口隐藏工具'
  const eyebrow = escapeHtml(input.eyebrow || brand)
  const title = escapeHtml(input.title)
  const intro = input.intro
    ? `<p style="margin:0 0 18px;color:#334155;font-size:15px;line-height:1.7;">${escapeHtml(input.intro)}</p>`
    : ''
  const highlightLabel = input.highlightLabel
    ? `<div style="margin:0 0 10px;color:#64748b;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(input.highlightLabel)}</div>`
    : ''
  const highlight = input.highlight
    ? `<div style="margin:0 0 20px;padding:18px 16px;border:1px solid #a7f3d0;border-radius:14px;background:linear-gradient(180deg,#ecfdf5 0%,#f0fdf4 100%);text-align:center;">
        ${highlightLabel}
        <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:32px;font-weight:800;letter-spacing:0.28em;color:#047857;">
          ${escapeHtml(input.highlight)}
        </div>
      </div>`
    : ''
  const footerNote = input.footerNote
    ? `<p style="margin:18px 0 0;color:#94a3b8;font-size:12px;line-height:1.6;">${escapeHtml(input.footerNote)}</p>`
    : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0f172a;padding:28px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;border-collapse:separate;">
          <tr>
            <td style="padding:0 0 14px 4px;color:#94a3b8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;letter-spacing:0.04em;">
              ${escapeHtml(brand)}
            </td>
          </tr>
          <tr>
            <td style="background:#ffffff;border:1px solid #e2e8f0;border-radius:18px;overflow:hidden;box-shadow:0 18px 40px rgba(2,6,23,0.28);">
              <div style="height:6px;background:linear-gradient(90deg,#10b981 0%,#059669 55%,#0ea5e9 100%);"></div>
              <div style="padding:28px 28px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
                <div style="display:inline-block;margin:0 0 14px;padding:6px 10px;border-radius:999px;background:#ecfdf5;border:1px solid #a7f3d0;color:#047857;font-size:12px;font-weight:700;">
                  ${eyebrow}
                </div>
                <h1 style="margin:0 0 12px;color:#0f172a;font-size:24px;line-height:1.35;font-weight:800;">
                  ${title}
                </h1>
                ${intro}
                ${highlight}
                ${renderParagraphs(input.paragraphs)}
                ${renderMetaLines(input.metaLines)}
                ${footerNote}
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 4px 0;color:#64748b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;line-height:1.6;">
              此邮件由系统自动发送，请勿直接回复。
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

function isRetriableResendStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 422 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  )
}

async function sendWithAccount(
  account: ResendAccount,
  input: { toEmail: string; subject: string; html: string }
): Promise<{ ok: true } | { ok: false; status: number; message: string; retriable: boolean }> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.api_key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: account.from,
      to: [input.toEmail],
      subject: input.subject,
      html: input.html
    })
  })

  if (res.ok) return { ok: true }

  const text = await res.text().catch(() => '')
  const message = `Resend API 错误：${res.status} ${text.slice(0, 200)}`
  return {
    ok: false,
    status: res.status,
    message,
    retriable: isRetriableResendStatus(res.status)
  }
}

export async function sendResendEmail(
  env: { DB: D1Database },
  input: {
    toEmail: string
    subject: string
    html: string
    ignoreEnabledFlag?: boolean
  }
): Promise<{ ok: boolean; message?: string }> {
  const settings = await getSettings(env.DB)
  const accounts = settings.resend_accounts || []

  if (accounts.length === 0) {
    return { ok: false, message: '后端未配置 Resend API Key 或发件人地址' }
  }
  if (!input.ignoreEnabledFlag && !settings.resend_enabled) {
    return { ok: false, message: '请先启用邮件服务（Resend）' }
  }

  const toEmail = String(input.toEmail || '').trim()
  if (!toEmail || !toEmail.includes('@')) {
    return { ok: false, message: '请输入有效的邮箱地址' }
  }

  const errors: string[] = []
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i]!
    try {
      const result = await sendWithAccount(account, {
        toEmail,
        subject: input.subject,
        html: input.html
      })
      if (result.ok) return { ok: true }

      errors.push(`#${i + 1} ${account.from}: ${result.message}`)
      // Always try next account silently until all are exhausted.
      if (i < accounts.length - 1) continue
    } catch (err) {
      const msg = err instanceof Error ? err.message : '网络错误'
      errors.push(`#${i + 1} ${account.from}: ${msg}`)
      if (i < accounts.length - 1) continue
    }
  }

  return {
    ok: false,
    message: errors[errors.length - 1] || '所有 Resend 账号均发送失败'
  }
}

export async function sendVerificationCode(
  env: { DB: D1Database },
  toEmail: string,
  code: string
): Promise<{ ok: boolean; message?: string }> {
  const subject = '注册邮箱验证码'
  const html = renderMailTemplate({
    eyebrow: '账号安全',
    title: '您的注册验证码',
    intro: '您正在注册 Minecraft 端口隐藏工具。请使用下方验证码完成邮箱验证：',
    highlightLabel: '验证码',
    highlight: code,
    paragraphs: [
      '验证码 10 分钟内有效。',
      '如果这不是您本人的操作，请忽略此邮件。'
    ],
    footerNote: '为了账号安全，请勿将验证码告知他人。'
  })

  return await sendResendEmail(env, { toEmail, subject, html })
}

export async function sendTestEmail(
  env: { DB: D1Database },
  toEmail: string
): Promise<{ ok: boolean; message?: string }> {
  const subject = '[测试邮件] Minecraft 端口隐藏工具'
  const now = new Date().toLocaleString('zh-CN')
  const html = renderMailTemplate({
    eyebrow: '管理后台',
    title: '邮件发信测试成功',
    intro: '这是一封来自管理后台的测试邮件。如果你收到了它，说明 Resend 配置工作正常。',
    highlightLabel: '测试状态',
    highlight: 'OK',
    paragraphs: ['你可以继续使用当前邮件配置发送注册验证码。'],
    metaLines: [`发送时间：${now}`, `接收邮箱：${toEmail}`],
    footerNote: '若未收到此邮件，请检查垃圾箱、发件域名配置以及 Resend API Key。'
  })
  return await sendResendEmail(env, { toEmail, subject, html, ignoreEnabledFlag: true })
}
