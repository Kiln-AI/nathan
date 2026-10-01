export type RouteHandler = (request: Request, ctx: ExecutionContext) => Response | Promise<Response>;

/** Exact-path router: 404 for unknown paths, 405 for a known path with another method. */
export class Router {
  private readonly routes = new Map<string, Map<string, RouteHandler>>();

  on(method: string, path: string, handler: RouteHandler): void {
    const byMethod = this.routes.get(path) ?? new Map<string, RouteHandler>();
    if (byMethod.has(method)) throw new Error(`Route ${method} ${path} is already defined`);
    byMethod.set(method, handler);
    this.routes.set(path, byMethod);
  }

  async handle(request: Request, ctx: ExecutionContext): Promise<Response> {
    const byMethod = this.routes.get(new URL(request.url).pathname);
    if (!byMethod) return new Response("Not found", { status: 404 });
    const handler = byMethod.get(request.method);
    if (!handler) {
      return new Response("Method not allowed", { status: 405, headers: { Allow: [...byMethod.keys()].join(", ") } });
    }
    return handler(request, ctx);
  }
}
