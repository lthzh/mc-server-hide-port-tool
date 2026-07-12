import { Hono } from 'hono'
import type { Bindings } from './services/cloudflare-dns'
import { registerAuthRoutes } from './routes/auth'
import { registerDnsRoutes } from './routes/dns'
import { registerAdminRoutes } from './routes/admin'

const app = new Hono<{ Bindings: Bindings }>()

registerAuthRoutes(app)
registerDnsRoutes(app)
registerAdminRoutes(app)

export default app
