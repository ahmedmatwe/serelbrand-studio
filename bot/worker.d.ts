declare const worker: { fetch(req: Request, env: Record<string, unknown>): Promise<Response> };
export default worker;
