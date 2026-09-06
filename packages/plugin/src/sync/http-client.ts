/**
 * dsh-cloud-sync protocol v1 客户端（docs/03-server-protocol.md §4/§7）。
 * 仅依赖全局 fetch，无第三方依赖。
 */

export interface RemoteObject {
  key: string
  size: number
  revision: string
  lastModified: string
}

/** 带状态码的协议错误；409 额外携带服务端当前长度。 */
export class ProtocolError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly currentLength?: number,
  ) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export interface SyncClientOptions {
  serverUrl: string
  token: string
  /** 用户名（可选）：多用户服务端的配对校验，非空时随请求发送 X-DSH-User。 */
  username?: string
  timeoutMs?: number
}

export class SyncClient {
  private base: string
  private token: string
  private username: string | undefined
  private timeoutMs: number

  constructor(options: SyncClientOptions) {
    this.base = options.serverUrl.replace(/\/+$/, '')
    this.token = options.token
    this.username = options.username || undefined
    this.timeoutMs = options.timeoutMs ?? 15000
  }

  private async request(
    method: string,
    path: string,
    body?: Buffer,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; headers: Headers; body: Buffer }> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(this.username ? { 'X-DSH-User': this.username } : {}),
        ...(body ? { 'Content-Type': 'application/octet-stream' } : {}),
        ...headers,
      },
      body: body as unknown as BodyInit | undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const responseBody = Buffer.from(await response.arrayBuffer())
    if (!response.ok) {
      let currentLength: number | undefined
      if (response.status === 409) {
        try {
          currentLength = (JSON.parse(responseBody.toString('utf8')) as { currentLength?: number }).currentLength
        } catch {
          // 哑存储规范要求 409 带 currentLength；缺失按无长度处理
        }
      }
      throw new ProtocolError(response.status, `${method} ${path} → ${response.status}`, currentLength)
    }
    return { status: response.status, headers: response.headers, body: responseBody }
  }

  /** 列表（可选前缀过滤），按 key 字典序。 */
  async list(prefix?: string): Promise<RemoteObject[]> {
    const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''
    const { body } = await this.request('GET', `/v1/sessions${query}`)
    return (JSON.parse(body.toString('utf8')) as { objects: RemoteObject[] }).objects
  }

  /** 全量下载；key 不存在抛 ProtocolError(404)。 */
  async download(key: string): Promise<Buffer> {
    const { body } = await this.request('GET', `/v1/${key}`)
    return body
  }

  /** Range 下载 [start, end]（含端点）。 */
  async downloadRange(key: string, start: number, end: number): Promise<Buffer> {
    const { body } = await this.request('GET', `/v1/${key}`, undefined, {
      Range: `bytes=${start}-${end}`,
    })
    return body
  }

  /** 全量覆写（首传、meta 更新）。 */
  async overwrite(key: string, content: Buffer): Promise<void> {
    await this.request('PUT', `/v1/${key}`, content)
  }

  /** 追加；offset 与服务端当前长度不一致抛 ProtocolError(409, currentLength)。 */
  async append(key: string, offset: number, content: Buffer): Promise<void> {
    await this.request('PUT', `/v1/${key}`, content, { 'X-Append-Offset': String(offset) })
  }

  async delete(key: string): Promise<void> {
    await this.request('DELETE', `/v1/${key}`)
  }

  /** 连通性测试：列表接口通且鉴权通过即成功（healthz 不鉴权，不用）。 */
  async ping(): Promise<void> {
    await this.list('sessions/')
  }
}
