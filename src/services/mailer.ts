import { getSettings } from './settings'

export async function sendResendEmail(
  env: { DB: D1Database },
  input: {
    toEmail: string
    subject: string
    html: string
  }
): Promise<{ ok: boolean; message?: string }> {
  const settings = await getSettings(env.DB)

  if (!settings.resend_enabled || !settings.resend_api_key || !settings.resend_from) {
    return { ok: false, message: '\u540e\u7aef\u672a\u914d\u7f6e Resend\uff0c\u65e0\u6cd5\u53d1\u9001\u90ae\u4ef6' }
  }

  const toEmail = String(input.toEmail || '').trim()
  if (!toEmail || !toEmail.includes('@')) {
    return { ok: false, message: '\u8bf7\u8f93\u5165\u6709\u6548\u7684\u90ae\u7bb1\u5730\u5740' }
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.resend_api_key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: settings.resend_from,
      to: [toEmail],
      subject: input.subject,
      html: input.html
    })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      ok: false,
      message: `Resend API \u9519\u8bef\uff1a${res.status} ${text.slice(0, 200)}`
    }
  }

  return { ok: true }
}

export async function sendVerificationCode(
  env: { DB: D1Database },
  toEmail: string,
  code: string
): Promise<{ ok: boolean; message?: string }> {
  const subject = '\u6ce8\u518c\u90ae\u7bb1\u9a8c\u8bc1\u7801'
  const html = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
  <h2>Minecraft \u7aef\u53e3\u9690\u85cf\u5de5\u5177</h2>
  <p>\u60a8\u7684\u6ce8\u518c\u9a8c\u8bc1\u7801\u662f\uff1a</p>
  <p style="font-size:28px;font-weight:bold;letter-spacing:4px;padding:12px 16px;background:#f4f4f4;border-radius:6px;text-align:center;">${code}</p>
  <p>\u9a8c\u8bc1\u7801 10 \u5206\u949f\u5185\u6709\u6548\uff0c\u8bf7\u52ff\u5411\u4ed6\u4eba\u6cc4\u9732\u3002</p>
</div>`

  return await sendResendEmail(env, { toEmail, subject, html })
}

export async function sendTestEmail(
  env: { DB: D1Database },
  toEmail: string
): Promise<{ ok: boolean; message?: string }> {
  const subject = '[\u6d4b\u8bd5\u90ae\u4ef6] Minecraft \u7aef\u53e3\u9690\u85cf\u5de5\u5177'
  const now = new Date().toLocaleString('zh-CN')
  const html = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
  <h2>\u90ae\u4ef6\u53d1\u4fe1\u6d4b\u8bd5</h2>
  <p>\u8fd9\u662f\u4e00\u5c01\u6765\u81ea\u7ba1\u7406\u540e\u53f0\u7684\u6d4b\u8bd5\u90ae\u4ef6\u3002</p>
  <p>\u5982\u679c\u4f60\u6536\u5230\u4e86\u8fd9\u5c01\u90ae\u4ef6\uff0c\u8bf4\u660e Resend \u914d\u7f6e\u6b63\u5e38\u3002</p>
  <p style="color:#666;font-size:12px;">\u53d1\u9001\u65f6\u95f4\uff1a${now}</p>
</div>`
  return await sendResendEmail(env, { toEmail, subject, html })
}
