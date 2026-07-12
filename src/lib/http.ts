export function redirectWithHeaders(location: string, status: 302 | 303 = 302, headers?: Headers): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('Location', location)
  return new Response(null, { status, headers: responseHeaders })
}

export async function redirectFromOAuthResponse(
  res: Response,
  fallbackErrorPath: string
): Promise<Response> {
  const headers = new Headers(res.headers)
  const contentType = (headers.get('content-type') || '').toLowerCase()

  if (res.status >= 300 && res.status < 400) {
    return new Response(null, { status: res.status, headers })
  }

  let payload: { url?: string; redirect?: boolean } | null = null
  if (
    contentType.includes('application/json') ||
    contentType.includes('text/json') ||
    contentType.includes('+json')
  ) {
    try {
      payload = (await res.clone().json()) as { url?: string; redirect?: boolean }
    } catch {
      payload = null
    }
  } else {
    try {
      const textBody = await res.clone().text()
      if (textBody.trim().startsWith('{')) {
        payload = JSON.parse(textBody) as { url?: string; redirect?: boolean }
      }
    } catch {
      payload = null
    }
  }

  if (payload?.url && payload.redirect !== false) {
    headers.set('Location', payload.url)
    headers.delete('content-type')
    headers.delete('content-length')
    return new Response(null, { status: 302, headers })
  }

  if (!res.ok) {
    return redirectWithHeaders(fallbackErrorPath, 302, headers)
  }

  return new Response(res.body, { status: res.status, headers })
}

export function parseCookie(header: string, name: string): string | null {
  const parts = header.split(';')
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('=') || '')
  }
  return null
}

export function splitCsv(raw: string): string[] {
  return raw
    .split(',')
    .flatMap((part) => part.split('\n'))
    .map((s) => s.trim())
    .filter(Boolean)
}
